'use strict';

const net = require('net');
const tls = require('tls');

const REDIS_URL = String(process.env.REDIS_URL || '').trim();
const EVENTS_KEY = 'p2u:live:events';

function config() {
  if (!REDIS_URL) return null;
  try {
    const u = new URL(REDIS_URL);
    return {
      host: u.hostname,
      port: Number(u.port || 6379),
      password: decodeURIComponent(u.password || ''),
      useTls: u.protocol === 'rediss:'
    };
  } catch (_) {
    return null;
  }
}

function encode(args) {
  let out = '*' + args.length + '\r\n';
  for (const arg of args) {
    const buf = Buffer.from(String(arg));
    out += '$' + buf.length + '\r\n';
    out += buf.toString('binary') + '\r\n';
  }
  return Buffer.from(out, 'binary');
}

function parse(buf, offset) {
  if (offset >= buf.length) return null;
  const type = String.fromCharCode(buf[offset]);
  const nl = buf.indexOf(10, offset);
  if (nl < 0) return null;
  const line = buf.slice(offset + 1, nl - (buf[nl - 1] === 13 ? 1 : 0)).toString();
  if (type === '+' || type === '-') return {value: line, error: type === '-', rest: nl + 1};
  if (type === ':') return {value: Number(line), rest: nl + 1};
  if (type === '$') {
    const len = Number(line);
    if (len < 0) return {value: null, rest: nl + 1};
    const start = nl + 1;
    const end = start + len;
    if (buf.length < end + 2) return null;
    return {value: buf.slice(start, end).toString(), rest: end + 2};
  }
  if (type === '*') {
    const count = Number(line);
    if (count < 0) return {value: null, rest: nl + 1};
    let pos = nl + 1;
    const items = [];
    for (let i = 0; i < count; i++) {
      const next = parse(buf, pos);
      if (!next) return null;
      items.push(next.value);
      pos = next.rest;
    }
    return {value: items, rest: pos};
  }
  throw new Error('Unsupported Redis reply');
}

function command(args, timeoutMs) {
  const cfg = config();
  if (!cfg) return Promise.resolve(null);
  timeoutMs = timeoutMs || 2500;
  return new Promise((resolve, reject) => {
    const sock = cfg.useTls
      ? tls.connect({host: cfg.host, port: cfg.port, servername: cfg.host})
      : net.connect({host: cfg.host, port: cfg.port});
    let buf = Buffer.alloc(0);
    let stage = cfg.password ? 0 : 1;
    let settled = false;
    const timer = setTimeout(() => finish(new Error('Redis timeout')), timeoutMs);
    function finish(err, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { sock.destroy(); } catch (_) {}
      if (err) reject(err);
      else resolve(value);
    }
    sock.setTimeout(timeoutMs);
    sock.on('timeout', () => finish(new Error('Redis socket timeout')));
    sock.on('error', err => finish(err));
    sock.on('data', chunk => {
      buf = Buffer.concat([buf, chunk]);
      try {
        while (true) {
          const parsed = parse(buf, 0);
          if (!parsed) return;
          buf = buf.slice(parsed.rest);
          if (stage === 0) {
            if (parsed.error) return finish(new Error(parsed.value));
            stage = 1;
            continue;
          }
          return parsed.error ? finish(new Error(parsed.value)) : finish(null, parsed.value);
        }
      } catch (err) { finish(err); }
    });
    sock.on('connect', () => {
      const parts = [];
      if (cfg.password) parts.push(encode(['AUTH', cfg.password]));
      parts.push(encode(args));
      sock.write(Buffer.concat(parts));
    });
  });
}

async function loadEvents(maxEvents) {
  if (!REDIS_URL) return {mode: 'in-memory', events: null};
  try {
    const rows = await command(['LRANGE', EVENTS_KEY, '0', '-1']);
    const restored = [];
    if (Array.isArray(rows)) {
      for (const row of rows) {
        try {
          const event = JSON.parse(row);
          if (event && Number(event.t) && event.sid && event.vid) restored.push(event);
        } catch (_) {}
      }
    }
    restored.sort((a, b) => a.t - b.t);
    return {mode: 'redis', events: restored.slice(-(maxEvents || 50000))};
  } catch (err) {
    console.error('analytics hydrate failed', err.message);
    return {mode: 'in-memory', events: null};
  }
}

async function saveEvent(event, maxEvents) {
  if (!REDIS_URL) return 'in-memory';
  try {
    await command(['RPUSH', EVENTS_KEY, JSON.stringify(event)]);
    await command(['LTRIM', EVENTS_KEY, String(-(maxEvents || 50000)), '-1']);
    return 'redis';
  } catch (err) {
    console.error('analytics persist failed', err.message);
    return 'in-memory';
  }
}

module.exports = {enabled: !!REDIS_URL, loadEvents, saveEvent};
