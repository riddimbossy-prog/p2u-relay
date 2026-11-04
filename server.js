// Predict2U code-lookup relay: public booking-code lookups + live scores. No secrets.
const http=require('http');
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
const BOOKS={sportybet:c=>sporty('www.sportybet.com',c),footballcom:c=>sporty('www.football.com',c),msport,betika,betpawa};
function send(res,code,obj,origin){const h={'Content-Type':'application/json','Cache-Control':'public, max-age=30',Vary:'Origin'};
  if(origin&&ORIG.some(r=>r.test(origin))){h['Access-Control-Allow-Origin']=origin;h['Access-Control-Allow-Methods']='GET, OPTIONS'}res.writeHead(code,h);res.end(code===204?'':JSON.stringify(obj))}
http.createServer(async(req,res)=>{const o=req.headers.origin,u=new URL(req.url,'http://x'),p=u.pathname;
  if(req.method==='OPTIONS')return send(res,204,{},o);
  if(p==='/'||p==='/health')return send(res,200,{ok:true,books:Object.keys(BOOKS),t:Date.now()},o);
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
