// Predict2U relay: public booking-code lookups + live scores + pay-per-code unlock (Paystack). Secrets only via env vars.
const crypto=require('crypto');
const http=require('http');
const adminAnalytics=require('./admin');
const PORT=process.env.PORT||10000;
const UA='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';
const ORIG=[/^https:\/\/(www\.)?predict2u\.com$/,/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/];
const cache=new Map(),TTL=45e3;
function cget(k){const v=cache.get(k);if(v&&Date.now()-v.t<TTL)return v.d;cache.delete(k)}
function cset(k,d){cache.set(k,{t:Date.now(),d});if(cache.size>3000)cache.delete(cache.keys().next().value)}
const hits=new Map();
function limited(ip){const now=Date.now(),r=(hits.get(ip)||[]).filter(t=>now-t<60e3);r.push(now);hits.set(ip,r);if(hits.size>5000)hits.clear();return r.length>60}
async function j(url,headers={}){const k='u:'+url,c=cget(k);if(c)return c;
  const ac=new AbortController(),t=setTimeout(()=>ac.abort(),12000);
  try{const r=await fetch(url,{headers:{'User-Agent':UA,Accept:'application/json',...headers},signal:ac.signal});if(!r.ok)throw new Error('upstream '+r.status);const d=await r.json();cset(k,d);return d}finally{clearTimeout(t)}}
const side=(d,H,A)=>String(d||'').replace(/\bHome\b/g,H).replace(/\bAway\b/g,A);
const tc=s=>String(s||'').toLowerCase().replace(/\b\w/g,c=>c.toUpperCase());
async function ev(id){if(!/^sr:match:\d+$/.test(id))return null;
  try{const d=(await j(`https://www.sportybet.com/api/gh/factsCenter/event?eventId=${encodeURIComponent(id)}&productId=3`)).data;if(!d)return null;
    return{eventId:id,status:d.matchStatus,score:d.setScore||null,played:d.playedSeconds||null,kickoff:d.estimateStartTime,home:d.homeTeamName,away:d.awayTeamName}}catch(e){return null}}
function settle(l){const st=l.status||'';if(/Cancel|Postpon|Abandon/i.test(st))return'void';if(st!=='Ended'||!l.score)return(st&&!/Not start|Ended/i.test(st))?'live':'pending';
  const [h,a]=l.score.split(':').map(Number),s=String(l.selection||'').trim(),mk=l.market||'';const m=s.match(/^(Over|Under) (\d+(?:\.\d+)?)$/i);
  if(m&&!/team|home|away|half|corner|card/i.test(mk))return((h+a)>+m[2])===/over/i.test(m[1])?'won':'lost';
  if(/half|corner|card|handicap/i.test(mk))return'unsettled';
  const T=String(l.match).split(' v '),out={1:h>a,X:h===a,2:a>h};
  const ps=s.split(/ or /).map(x=>{x=x.trim();return x===T[0]?'1':x===T[1]?'2':/^draw$/i.test(x)?'X':null});
  if(ps.every(Boolean))return ps.some(q=>out[q])?'won':'lost';
  if(/both|gg/i.test(mk)){if(/^(gg|yes)$/i.test(s))return h&&a?'won':'lost';if(/^(ng|no)$/i.test(s))return!(h&&a)?'won':'lost'}
  return'unsettled'}
async function enrich(legs,force){await Promise.all(legs.map(async l=>{if(force||!l.status){const e=await ev(l.eventId);if(e){l.status=e.status;l.score=e.score;l.played=e.played;l.kickoff=l.kickoff||e.kickoff}}l.result=settle(l)}));return legs}
async function sporty(host,code){const d=(await j(`https://${host}/api/gh/orders/share/${encodeURIComponent(code)}`)).data;if(!d||!d.outcomes)return null;
  return d.outcomes.map(o=>{const m=o.markets[0],oc=m.outcomes[0],H=o.homeTeamName,A=o.awayTeamName;
    return{eventId:o.eventId,match:H+' v '+A,league:o.sport?.category?.tournament?.name||'',market:m.desc,selection:side(oc.desc,H,A),odds:+oc.odds||null,kickoff:o.estimateStartTime,status:o.matchStatus,score:o.setScore||null,played:o.playedSeconds||null}})}
async function msport(code){const d=(await j(`https://www.msport.com/api/gh/orders/real-sports/order/share/${encodeURIComponent(code)}`)).data;if(!d||!d.bettableBetSlip)return null;
  return d.bettableBetSlip.map(s=>{const e=s.event,H=e.homeTeam,A=e.awayTeam;let sel=side(s.outcome.description,H,A);if(/^draw$/i.test(sel))sel='Draw';
    return{eventId:e.eventId,match:H+' v '+A,league:e.tournament,market:s.market.description,selection:sel,odds:+s.outcome.odds||null,kickoff:e.startTime}})}
async function betika(code){const dd=(await j(`https://api.betika.com.gh/v2/share/decode?code=${encodeURIComponent(code)}&src=MOBILE_WEB`)).data;if(!dd||!dd.length)return null;
  return dd.map(x=>{const H=tc(x.home_team),A=tc(x.away_team),st=String(x.sub_type_id);let sel=String(x.odd_key||'');
    if(st==='1')sel=x.outcome_id==='1'?H:x.outcome_id==='3'?A:'Draw';else if(st==='10')sel={'9':H+' or Draw','10':H+' or '+A,'11':'Draw or '+A}[x.outcome_id]||sel;
    else if(/^(over|under) /i.test(sel))sel=tc(sel.split(' ')[0])+' '+sel.split(' ')[1];else sel=tc(sel);
    return{eventId:'sr:match:'+x.parent_match_id,match:H+' v '+A,league:'',market:x.name,selection:sel,odds:+x.odd_value||null,kickoff:Date.parse(String(x.start_time).replace(' ','T')+'Z')||null}})}
const PH={'x-pawa-brand':'betpawa-ghana','x-pawa-language':'en',devicetype:'web'};
async function betpawa(code){const it=(await j(`https://www.betpawa.com.gh/api/sportsbook/v3/booking-number/${encodeURIComponent(code)}`,PH)).items;if(!it||!it.length)return null;
  return Promise.all(it.map(async x=>{const e=x.eventInfo,P=e.participants||[],H=(P.find(p=>p.position===1)||{}).name,A=(P.find(p=>p.position===2)||{}).name,s=x.selections[0];
    let sr=null;try{const f=await j('https://www.betpawa.com.gh/api/sportsbook/v4/events/'+e.id,PH);const w=(f.widgets||[]).find(w=>w.type==='SPORTRADAR');if(w)sr='sr:match:'+w.id}catch(_){}
    const hc=s.selectionInfo.handicap||(s.market.specifier||{}).total||s.market.formattedHandicap||'';let sel=String(s.selectionInfo.displayName||s.selectionInfo.name).replace(/\{formattedHandicap\}|\{handicap\}/g,hc).trim();const mk=s.market.displayName||s.market.name;
    if(/^1X2/i.test(s.market.name))sel=sel==='1'?H:sel==='2'?A:'Draw';else if(/double chance/i.test(mk))sel={'1X':H+' or Draw','12':H+' or '+A,'X2':'Draw or '+A}[sel]||sel;
    else if(/^(over|under)$/i.test(sel)&&hc)sel=sel+' '+hc;
    return{eventId:sr||('bp:'+e.id),match:H+' v '+A,league:e.competition?.name||'',market:mk,selection:sel,odds:+(x.odds||{}).price||null,kickoff:Date.parse(e.startTime)}}))}

// ---------- Pay-per-code unlock ----------
const PSK=process.env.PAYSTACK_SECRET_KEY||'',PPK=process.env.PAYSTACK_PUBLIC_KEY||'',LKEY=process.env.LOCK_KEY||'';
const LURL=process.env.LOCKED_URL||'https://predict2u.com/locked.enc.json';
let LOCK={t:0,meta:{},data:{}};
async function locked(){if(Date.now()-LOCK.t<60e3&&LOCK.t)return LOCK;
  try{const r=await fetch(LURL+'?t='+Date.now(),{headers:{'User-Agent':UA}});if(!r.ok)throw new Error('locked '+r.status);const e=await r.json();let data={};
    if(LKEY){const k=Buffer.from(LKEY,'hex'),b=Buffer.from(e.data,'base64'),d=crypto.createDecipheriv('aes-256-gcm',k,Buffer.from(e.iv,'base64'));d.setAAD(Buffer.from('p2u-lock-v1'));d.setAuthTag(b.subarray(b.length-16));
      data=JSON.parse(Buffer.concat([d.update(b.subarray(0,b.length-16)),d.final()]).toString())}
    LOCK={t:Date.now(),meta:e.ids||{},data}}catch(err){console.log('locked fetch failed',err.message);if(!LOCK.t)LOCK.t=Date.now()-50e3}
  return LOCK}
const b64u=b=>Buffer.from(b).toString('base64url');
function sign(o){const p=b64u(JSON.stringify(o));return p+'.'+crypto.createHmac('sha256',LKEY).update(p).digest('base64url')}
function unsign(t){const [p,h]=String(t||'').split('.');if(!p||!h||!LKEY)return null;const x=crypto.createHmac('sha256',LKEY).update(p).digest('base64url');
  if(x.length!==h.length||!crypto.timingSafeEqual(Buffer.from(x),Buffer.from(h)))return null;try{return JSON.parse(Buffer.from(p,'base64url').toString())}catch(e){return null}}
async function ps(path,opt={}){const r=await fetch('https://api.paystack.co'+path,{...opt,headers:{Authorization:'Bearer '+PSK,'Content-Type':'application/json',...(opt.headers||{})}});const d=await r.json().catch(()=>({}));if(!r.ok||d.status===false)throw new Error(d.message||('paystack '+r.status));return d.data}
function body(req,max=1e5){return new Promise((ok,no)=>{let b='';req.on('data',c=>{b+=c;if(b.length>max){no(new Error('too big'));req.destroy()}});req.on('end',()=>ok(b));req.on('error',no)})}
const payOn=()=>!!(PSK&&PPK&&LKEY);
const validId=id=>/^(banker|medium|hot)-\d{8}$/.test(String(id||''));
function grant(L,id,ref,email){const c=L.data[id];return{id,codes:c?c.codes:null,title:c?c.title:(L.meta[id]||{}).title,token:sign({id,ref,email,iat:Date.now()})}}
const PAID=new Map();// reference -> {id,email} from webhook (memory hint only; Paystack is the source of truth)
async function checkTx(ref,id){const t=await ps('/transaction/verify/'+encodeURIComponent(ref));const m=t.metadata||{},L=await locked(),meta=L.meta[m.slip]||{};
  const price=Math.round((meta.price||50)*100);
  if(t.status!=='success'||t.currency!=='GHS'||+t.amount<price||!validId(m.slip)||(id&&m.slip!==id))return null;
  return grant(L,m.slip,t.reference,(t.customer||{}).email||'')}
async function payRoute(req,res,p,u,o){
  if(p==='/pay/config'){const L=await locked();return send(res,200,{enabled:payOn(),publicKey:payOn()?PPK:null,currency:'GHS',locked:L.meta},o),true}
  if(p==='/paystack/webhook'&&req.method==='POST'){const raw=await body(req,1e6);
    const sig=String(req.headers['x-paystack-signature']||''),h=PSK?crypto.createHmac('sha512',PSK).update(raw).digest('hex'):'';
    if(!PSK||sig.length!==h.length||!crypto.timingSafeEqual(Buffer.from(sig),Buffer.from(h))){res.writeHead(401);res.end('bad signature');return true}
    try{const e=JSON.parse(raw);if(e.event==='charge.success'){const d=e.data||{};PAID.set(d.reference,{id:(d.metadata||{}).slip,email:(d.customer||{}).email});console.log('paid',d.reference,(d.metadata||{}).slip)}}catch(_){}
    res.writeHead(200);res.end('ok');return true}
  if(!p.startsWith('/pay/')&&p!=='/unlock')return false;
  if(!payOn())return send(res,503,{error:'payments coming soon',enabled:false},o),true;
  if(req.method!=='POST')return send(res,405,{error:'POST only'},o),true;
  let q={};try{q=JSON.parse(await body(req)||'{}')}catch(e){return send(res,400,{error:'bad json'},o),true}
  const email=String(q.email||'').trim().toLowerCase();
  if(p==='/pay/init'){if(!validId(q.id))return send(res,400,{error:'bad slip'},o),true;const L=await locked();if(!L.meta[q.id])return send(res,404,{error:'slip not on sale'},o),true;
    if(!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))return send(res,400,{error:'valid email needed'},o),true;
    const back=String(q.back||'https://predict2u.com/').replace(/[#?].*$/,'');
    const d=await ps('/transaction/initialize',{method:'POST',body:JSON.stringify({email,amount:Math.round((L.meta[q.id].price||50)*100),currency:'GHS',channels:['mobile_money','card'],
      callback_url:/^https:\/\/(www\.)?predict2u\.com\//.test(back)?back+'?p2uslip='+q.id:'https://predict2u.com/',metadata:{slip:q.id,device:String(q.device||'').slice(0,64),custom_fields:[{display_name:'Slip',variable_name:'slip',value:q.id}]}})});
    return send(res,200,{access_code:d.access_code,reference:d.reference,authorization_url:d.authorization_url},o),true}
  if(p==='/pay/verify'){const g=await checkTx(String(q.reference||''),q.id);return g?send(res,200,g,o):send(res,402,{error:'payment not confirmed'},o),true}
  if(p==='/unlock'){const t=unsign(q.token);if(!t||!validId(t.id))return send(res,401,{error:'bad token'},o),true;const L=await locked();return send(res,200,grant(L,t.id,t.ref,t.email),o),true}
  if(p==='/pay/restore'){if(!email)return send(res,400,{error:'email needed'},o),true;const L=await locked(),out=[];
    try{const c=await ps('/customer/'+encodeURIComponent(email));const tx=await ps('/transaction?status=success&perPage=100&customer='+c.id);
      for(const t of tx||[]){const id=(t.metadata||{}).slip;if(validId(id)&&L.meta[id]&&t.currency==='GHS'&&+t.amount>=Math.round((L.meta[id].price||50)*100)&&!out.some(x=>x.id===id))out.push(grant(L,id,t.reference,email))}}catch(e){}
    return send(res,200,{unlocks:out},o),true}
  return send(res,404,{error:'not found'},o),true}
const BOOKS={sportybet:c=>sporty('www.sportybet.com',c),footballcom:c=>sporty('www.football.com',c),msport,betika,betpawa};
let currentPath='';
function send(res,code,obj,origin){const h={'Content-Type':'application/json','Cache-Control':'public, max-age=30',Vary:'Origin'};
  if(origin&&ORIG.some(r=>r.test(origin))){h['Access-Control-Allow-Origin']=origin;h['Access-Control-Allow-Methods']='GET, POST, OPTIONS';h['Access-Control-Allow-Headers']='Content-Type'}if(/^\/(pay|unlock)/.test(currentPath||''))h['Cache-Control']='no-store';res.writeHead(code,h);res.end(code===204?'':JSON.stringify(obj))}
http.createServer(async(req,res)=>{const o=req.headers.origin,u=new URL(req.url,'http://x'),p=u.pathname;
  if(req.method==='OPTIONS'&&(p==='/analytics/collect'||p==='/live/hit'))return adminAnalytics.handle(req,res,p,o);
  if(req.method==='OPTIONS')return send(res,204,{},o);
  currentPath=p;
  if(p==='/'||p==='/health')return send(res,200,{ok:true,books:Object.keys(BOOKS),pay:payOn(),t:Date.now()},o);
  if(p==='/analytics/collect'||p==='/live/hit'||p==='/admin'||p.startsWith('/admin/')){try{return await adminAnalytics.handle(req,res,p,o)}catch(e){console.error('admin route error',e.message);if(!res.headersSent){res.writeHead(500,{'Content-Type':'text/plain','Cache-Control':'no-store'});res.end('Admin route error')}return}}
  if(p.startsWith('/pay/')||p==='/unlock'||p==='/paystack/webhook'){try{if(await payRoute(req,res,p,u,o))return}catch(e){return send(res,502,{error:'payment error',detail:String(e.message||e)},o)}}
  const ip=String(req.headers['x-forwarded-for']||req.socket.remoteAddress||'').split(',')[0].trim();
  if(limited(ip))return send(res,429,{error:'rate limited (60/min)'},o);
  try{const m=p.match(/^\/code\/([a-z]+)\/([A-Za-z0-9]{4,14})$/);
    if(m){const b=m[1],c=b==='betika'?m[2]:m[2].toUpperCase();if(!BOOKS[b])return send(res,404,{error:'unknown book'},o);
      const k='c:'+b+':'+c;let out=cget(k);
      if(!out){const legs=await BOOKS[b](c);if(!legs)return send(res,404,{error:'code not found or expired',book:b,code:c},o);
        await enrich(legs,b!=='sportybet'&&b!=='footballcom');out={book:b,code:c,legs,totalOdds:+legs.reduce((a,l)=>a*(l.odds||1),1).toFixed(2),fetched:Date.now()};cset(k,out)}
      return send(res,200,out,o)}
    if(p==='/events'){const ids=(u.searchParams.get('ids')||'').split(',').filter(x=>/^sr:match:\d+$/.test(x)).slice(0,80);
      const r=await Promise.all(ids.map(ev)),out={};r.forEach(e=>{if(e)out[e.eventId]=e});return send(res,200,{events:out,fetched:Date.now()},o)}
    send(res,404,{error:'not found'},o)}catch(e){send(res,502,{error:'upstream error',detail:String(e.message||e)},o)}
}).listen(PORT,()=>console.log('relay on',PORT));
