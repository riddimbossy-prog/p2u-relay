'use strict';

// Private, dependency-free admin analytics. Raw IPs and credentials are never stored.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ADMIN_EMAIL = String(process.env.ADMIN_EMAIL || 'predict2u@gmail.com').trim().toLowerCase();
const ADMIN_PASSWORD = String(process.env.ADMIN_PASSWORD || '');
const SESSION_TTL = 12 * 60 * 60 * 1000;
const ONLINE_WINDOW = 5 * 60 * 1000;
const RETENTION = 48 * 60 * 60 * 1000;
const MAX_EVENTS = 50000;
const events = [];
const sessions = new Map();
const loginAttempts = new Map();
const seenBySession = new Map();
let lastPrune = 0;

const asset = name => fs.readFileSync(path.join(__dirname, 'admin-assets', name));
const esc = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const cleanText = (value, max) => String(value == null ? '' : value).slice(0, max);
const dayKey = timestamp => new Intl.DateTimeFormat('en-CA', {timeZone:'Africa/Accra', year:'numeric', month:'2-digit', day:'2-digit'}).format(new Date(timestamp));
const clientIp = req => String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
const originAllowed = origin => !origin || /^https:\/\/(www\.)?predict2u\.com$/.test(origin) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);

function securityHeaders(res, csp) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (csp) res.setHeader('Content-Security-Policy', csp);
}
function json(res, status, data, origin, privateRoute) {
  securityHeaders(res);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', privateRoute ? 'no-store' : 'no-store');
  res.setHeader('Vary', 'Origin');
  if (origin && originAllowed(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Max-Age', '600');
  }
  res.end(status === 204 ? '' : JSON.stringify(data));
}
function html(res, status, content, cookie) {
  securityHeaders(res, "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  res.statusCode = status;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
  if (cookie) res.setHeader('Set-Cookie', cookie);
  res.end(content);
}
function redirect(res, location, cookie) {
  securityHeaders(res);
  res.statusCode = 303;
  res.setHeader('Location', location);
  res.setHeader('Cache-Control', 'no-store');
  if (cookie) res.setHeader('Set-Cookie', cookie);
  res.end();
}
function readBody(req, max = 8192) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => {
      data += chunk;
      if (Buffer.byteLength(data) > max) {
        reject(new Error('Request too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}
function cookies(req) {
  const out = {};
  String(req.headers.cookie || '').split(';').forEach(part => {
    const at = part.indexOf('=');
    if (at > 0) out[part.slice(0, at).trim()] = part.slice(at + 1).trim();
  });
  return out;
}
function sessionCookie(token, maxAge) {
  const secure = process.env.ADMIN_INSECURE_COOKIE === '1' ? '' : '; Secure';
  return `p2u_admin=${token}; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`;
}
function adminSession(req) {
  const token = cookies(req).p2u_admin;
  const session = token && sessions.get(token);
  if (!session || session.expires < Date.now()) {
    if (token) sessions.delete(token);
    return null;
  }
  session.expires = Date.now() + SESSION_TTL;
  return session;
}
function safeEqual(a, b) {
  const left = crypto.createHash('sha256').update(String(a)).digest();
  const right = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(left, right);
}
function loginPage(error) {
  return asset('login.html').toString().replace('{{ERROR}}', error ? `<p class="login-error" role="alert">${esc(error)}</p>` : '');
}
function authRequired(req, res) {
  if (adminSession(req)) return true;
  if (!ADMIN_PASSWORD) {
    html(res, 503, loginPage('Admin login is not configured yet.'));
    return null;
  }
  const session = adminSession(req);
  if (!session) html(res, 401, loginPage(''));
  return session;
}
function prune(now) {
  if (now - lastPrune < 30000) return;
  lastPrune = now;
  while (events.length && now - events[0].t > RETENTION) events.shift();
  for (const [key, value] of sessions) if (value.expires < now) sessions.delete(key);
  for (const [key, value] of seenBySession) if (now - value > RETENTION) seenBySession.delete(key);
  for (const [key, value] of loginAttempts) if (now - value.start > 15 * 60 * 1000) loginAttempts.delete(key);
}
function cleanPage(value) {
  let page = cleanText(value, 180) || '/';
  if (!page.startsWith('/') || page.startsWith('//')) page = '/';
  return page.replace(/[?#].*$/, '') || '/';
}
function cleanReferrer(value) {
  const raw = cleanText(value, 300);
  if (!raw) return 'Direct';
  try {
    const url = new URL(raw);
    if (!/^https?:$/.test(url.protocol)) return 'Direct';
    if (/^(www\.)?predict2u\.com$/i.test(url.hostname)) return 'Internal';
    return url.hostname.toLowerCase().replace(/^www\./, '').slice(0, 100);
  } catch (_) { return 'Direct'; }
}
function coarseDevice(value, ua) {
  if (['mobile', 'tablet', 'desktop'].includes(value)) return value;
  return /ipad|tablet/i.test(ua) ? 'tablet' : /mobile|android|iphone/i.test(ua) ? 'mobile' : 'desktop';
}
async function collect(req, res, origin) {
  if (!originAllowed(origin)) return json(res, 403, {ok:false}, origin);
  let input;
  try { input = JSON.parse(await readBody(req) || '{}'); }
  catch (_) { return json(res, 400, {ok:false}, origin); }
  const sid = cleanText(input.sid, 64);
  const vid = cleanText(input.vid, 64);
  if (!/^[A-Za-z0-9_-]{12,64}$/.test(sid) || !/^[A-Za-z0-9_-]{12,64}$/.test(vid)) return json(res, 400, {ok:false}, origin);
  const type = ['page', 'heartbeat', 'unlock'].includes(input.type) ? input.type : 'page';
  const now = Date.now();
  const event = {
    t: now,
    day: dayKey(now),
    type,
    sid,
    vid,
    page: cleanPage(input.page),
    referrer: cleanReferrer(input.referrer),
    device: coarseDevice(input.device, String(req.headers['user-agent'] || ''))
  };
  events.push(event);
  if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
  seenBySession.set(sid, now);
  prune(now);
  return json(res, 202, {ok:true}, origin);
}
function top(map, limit = 8) {
  return [...map.entries()].map(([name, value]) => ({name, value})).sort((a,b) => b.value - a.value || a.name.localeCompare(b.name)).slice(0, limit);
}
function increment(map, key, amount = 1) { map.set(key, (map.get(key) || 0) + amount); }
function metrics() {
  const now = Date.now();
  prune(now);
  const today = dayKey(now);
  const currentMinute = Math.floor(now / 60000);
  const minuteCounts = new Array(60).fill(0);
  const online = new Set();
  const visitors = new Set();
  const pageCounts = new Map();
  const referrerCounts = new Map();
  const deviceSessions = new Map();
  const unlockPages = new Map();
  let viewsToday = 0;
  let unlockClicksToday = 0;
  for (const event of events) {
    if (now - event.t <= ONLINE_WINDOW) online.add(event.sid);
    const minute = Math.floor(event.t / 60000);
    if (event.type === 'page' && minute <= currentMinute && minute > currentMinute - 60) minuteCounts[minute - (currentMinute - 59)]++;
    if (event.day !== today) continue;
    visitors.add(event.vid);
    if (event.type === 'page') {
      viewsToday++;
      increment(pageCounts, event.page);
      increment(referrerCounts, event.referrer);
      if (!deviceSessions.has(event.device)) deviceSessions.set(event.device, new Set());
      deviceSessions.get(event.device).add(event.sid);
    } else if (event.type === 'unlock') {
      unlockClicksToday++;
      increment(unlockPages, event.page);
    }
  }
  const devices = new Map();
  for (const [name, ids] of deviceSessions) devices.set(name, ids.size);
  return {
    generatedAt: now,
    timezone: 'Africa/Accra',
    activeMinutes: 5,
    refreshSeconds: 10,
    onlineNow: online.size,
    visitorsToday: visitors.size,
    viewsToday,
    unlockClicksToday,
    minutes: minuteCounts.map((value, index) => ({t:(currentMinute - 59 + index) * 60000, value})),
    topPages: top(pageCounts),
    referrers: top(referrerCounts),
    devices: top(devices, 3),
    unlockPages: top(unlockPages, 6),
    storage: 'in-memory',
    retentionHours: 48
  };
}
async function login(req, res) {
  console.log('admin login config fingerprint',ADMIN_PASSWORD.length,crypto.createHash('sha256').update(ADMIN_PASSWORD).digest('hex').slice(0,16));
  if (!ADMIN_PASSWORD) return html(res, 503, loginPage('Admin login is not configured yet.'));
  const ip = clientIp(req) || 'unknown';
  const attempt = loginAttempts.get(ip);
  if (attempt && Date.now() - attempt.start < 15 * 60 * 1000 && attempt.count >= 10) return html(res, 429, loginPage('Too many attempts. Try again in 15 minutes.'));
  let params;
  try { params = new URLSearchParams(await readBody(req)); }
  catch (_) { return html(res, 400, loginPage('The sign-in request was not valid.')); }
  const email = String(params.get('email') || '').trim().toLowerCase();
  const password = String(params.get('password') || '');
  if (!safeEqual(email, ADMIN_EMAIL) || !safeEqual(password, ADMIN_PASSWORD)) {
    const current = attempt && Date.now() - attempt.start < 15 * 60 * 1000 ? attempt : {start:Date.now(), count:0};
    current.count++;
    loginAttempts.set(ip, current);
    return html(res, 401, loginPage('Email or password is incorrect.'));
  }
  loginAttempts.delete(ip);
  const token = crypto.randomBytes(32).toString('base64url');
  if (sessions.size > 100) sessions.clear();
  sessions.set(token, {expires:Date.now() + SESSION_TTL});
  return redirect(res, '/admin', sessionCookie(token, SESSION_TTL / 1000));
}
async function handle(req, res, pathname, origin) {
  if (pathname === '/analytics/collect') {
    if (req.method === 'OPTIONS') return json(res, 204, {}, origin);
    if (req.method !== 'POST') return json(res, 405, {error:'POST only'}, origin);
    return collect(req, res, origin);
  }
  if (pathname === '/admin/assets/admin.css' && req.method === 'GET') {
    securityHeaders(res); res.setHeader('Content-Type','text/css; charset=utf-8'); res.setHeader('Cache-Control','private, max-age=300'); return res.end(asset('admin.css'));
  }
  if (pathname === '/admin/assets/admin.js' && req.method === 'GET') {
    securityHeaders(res); res.setHeader('Content-Type','text/javascript; charset=utf-8'); res.setHeader('Cache-Control','private, max-age=300'); return res.end(asset('admin.js'));
  }
  if (pathname === '/admin/login' && req.method === 'POST') return login(req, res);
  if (pathname === '/admin/logout' && req.method === 'POST') {
    const token = cookies(req).p2u_admin;
    if (token) sessions.delete(token);
    return redirect(res, '/admin', sessionCookie('', 0));
  }
  if (pathname === '/admin' || pathname === '/admin/') {
    if (req.method !== 'GET') return html(res, 405, loginPage('Method not allowed.'));
    if (!authRequired(req, res)) return;
    return html(res, 200, asset('dashboard.html').toString());
  }
  if (pathname === '/admin/metrics') {
    if (req.method !== 'GET') return json(res, 405, {error:'GET only'}, origin, true);
    if (!ADMIN_PASSWORD || !adminSession(req)) return json(res, 401, {error:'Authentication required'}, origin, true);
    return json(res, 200, metrics(), origin, true);
  }
  return html(res, 404, loginPage('Page not found.'));
}
module.exports = {handle, _metrics:metrics, _reset:() => {events.length = 0; sessions.clear(); seenBySession.clear(); loginAttempts.clear();}};
