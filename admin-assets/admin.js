(function(){
  'use strict';
  var $=function(id){return document.getElementById(id);};
  var canvas=$('traffic-chart'),ctx=canvas.getContext('2d'),state=null,points=[],animationFrame=0,toastTimer;
  var fmt=new Intl.NumberFormat('en-GH'),timeFmt=new Intl.DateTimeFormat('en-GB',{timeZone:'Africa/Accra',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false});
  var previous={};
  function text(id,value){var el=$(id);if(el)el.textContent=value;}
  function number(id,value){
    var el=$(id),from=previous[id]||0,to=Number(value)||0;previous[id]=to;
    if(window.matchMedia('(prefers-reduced-motion: reduce)').matches||from===to){el.textContent=fmt.format(to);return;}
    var start=performance.now(),duration=550;
    function step(now){var p=Math.min(1,(now-start)/duration),e=1-Math.pow(1-p,3);el.textContent=fmt.format(Math.round(from+(to-from)*e));if(p<1)requestAnimationFrame(step);}requestAnimationFrame(step);
  }
  function esc(value){return String(value).replace(/[&<>"']/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});}
  function toast(message){var el=$('toast');el.textContent=message;el.classList.add('visible');clearTimeout(toastTimer);toastTimer=setTimeout(function(){el.classList.remove('visible');},4000);}
  function bars(id,items,empty){
    var el=$(id);if(!items||!items.length){el.innerHTML='<p class="empty-state">'+empty+'</p>';return;}
    var max=Math.max.apply(null,items.map(function(x){return x.value;}).concat([1]));
    el.innerHTML=items.map(function(item){return '<div class="bar-row"><div class="bar-meta"><span class="bar-name" title="'+esc(item.name)+'">'+esc(item.name)+'</span><strong class="bar-value">'+fmt.format(item.value)+'</strong></div><div class="bar-track"><div class="bar-fill" style="width:'+Math.max(2,item.value/max*100).toFixed(1)+'%"></div></div></div>';}).join('');
  }
  function renderDevices(items){
    var el=$('devices'),total=(items||[]).reduce(function(sum,item){return sum+item.value;},0),start=0,colors=['#38ed91','#eac46b','#7993a0'];
    text('device-total',fmt.format(total));
    if(!total){$('device-donut').style.background='conic-gradient(#1b2a24 0deg,#1b2a24 360deg)';el.innerHTML='<p class="empty-state">No device data yet.</p>';return;}
    var stops=items.map(function(item,index){var end=start+item.value/total*360,s=colors[index]+' '+start.toFixed(1)+'deg '+end.toFixed(1)+'deg';start=end;return s;});
    $('device-donut').style.background='conic-gradient('+stops.join(',')+')';
    el.innerHTML=items.map(function(item){return '<div class="device-row"><i></i><span>'+esc(item.name[0].toUpperCase()+item.name.slice(1))+'</span><strong>'+Math.round(item.value/total*100)+'% <small>· '+fmt.format(item.value)+'</small></strong></div>';}).join('');
  }
  function compact(id,items){var el=$(id);if(!items||!items.length){el.innerHTML='<p class="empty-state">Unlock clicks will appear here.</p>';return;}el.innerHTML=items.map(function(item){return '<div class="compact-row"><span title="'+esc(item.name)+'">'+esc(item.name)+'</span><strong>'+fmt.format(item.value)+' clicks</strong></div>';}).join('');}
  function sizeCanvas(){var box=canvas.getBoundingClientRect(),ratio=Math.min(window.devicePixelRatio||1,2);canvas.width=Math.round(box.width*ratio);canvas.height=Math.round(box.height*ratio);ctx.setTransform(ratio,0,0,ratio,0,0);drawChart(state?state.minutes:[],1);}
  function drawChart(minutes,progress){
    var w=canvas.clientWidth,h=canvas.clientHeight;ctx.clearRect(0,0,w,h);points=[];
    if(!minutes||!minutes.length)return;
    var values=minutes.map(function(m){return m.value;}),max=Math.max.apply(null,values.concat([3])),left=5,right=5,top=13,bottom=14;
    ctx.lineWidth=1;ctx.strokeStyle='rgba(180,220,197,.06)';
    for(var row=0;row<4;row++){var y=top+(h-top-bottom)*row/3;ctx.beginPath();ctx.moveTo(left,y);ctx.lineTo(w-right,y);ctx.stroke();}
    minutes.forEach(function(m,i){points.push({x:left+(w-left-right)*i/(minutes.length-1),y:top+(h-top-bottom)*(1-m.value/max*progress),value:m.value,t:m.t});});
    var fill=ctx.createLinearGradient(0,top,0,h);fill.addColorStop(0,'rgba(56,237,145,.26)');fill.addColorStop(.7,'rgba(56,237,145,.035)');fill.addColorStop(1,'rgba(56,237,145,0)');
    ctx.beginPath();ctx.moveTo(points[0].x,h-bottom);points.forEach(function(p){ctx.lineTo(p.x,p.y);});ctx.lineTo(points[points.length-1].x,h-bottom);ctx.closePath();ctx.fillStyle=fill;ctx.fill();
    var gradient=ctx.createLinearGradient(0,0,w,0);gradient.addColorStop(0,'#239b62');gradient.addColorStop(.65,'#38ed91');gradient.addColorStop(1,'#d0f780');
    ctx.beginPath();points.forEach(function(p,i){if(i===0)ctx.moveTo(p.x,p.y);else ctx.lineTo(p.x,p.y);});ctx.strokeStyle=gradient;ctx.lineWidth=2;ctx.lineJoin='round';ctx.lineCap='round';ctx.shadowColor='rgba(56,237,145,.3)';ctx.shadowBlur=8;ctx.stroke();ctx.shadowBlur=0;
    var last=points[points.length-1];ctx.beginPath();ctx.arc(last.x,last.y,3.5,0,Math.PI*2);ctx.fillStyle='#b5f86a';ctx.shadowColor='#38ed91';ctx.shadowBlur=12;ctx.fill();ctx.shadowBlur=0;
  }
  function animateChart(minutes){cancelAnimationFrame(animationFrame);if(window.matchMedia('(prefers-reduced-motion: reduce)').matches){drawChart(minutes,1);return;}var start=performance.now();function frame(now){var p=Math.min(1,(now-start)/500);drawChart(minutes,1-Math.pow(1-p,3));if(p<1)animationFrame=requestAnimationFrame(frame);}animationFrame=requestAnimationFrame(frame);}
  function render(data){
    state=data;number('online-now',data.onlineNow);number('visitors-today',data.visitorsToday);number('views-today',data.viewsToday);number('unlocks-today',data.unlockClicksToday);
    text('hour-views',fmt.format(data.minutes.reduce(function(s,m){return s+m.value;},0)));
    text('last-updated','Updated '+timeFmt.format(new Date(data.generatedAt))+' GMT');
    bars('top-pages',data.topPages,'Waiting for the first visits…');bars('referrers',data.referrers,'Waiting for traffic sources…');renderDevices(data.devices);compact('unlock-pages',data.unlockPages);animateChart(data.minutes);
  }
  function refresh(manual){
    fetch('/admin/metrics',{credentials:'same-origin',cache:'no-store',headers:{Accept:'application/json'}}).then(function(r){if(r.status===401){location.reload();throw new Error('session');}if(!r.ok)throw new Error('HTTP '+r.status);return r.json();}).then(function(data){render(data);if(manual)toast('Dashboard refreshed');}).catch(function(e){if(e.message!=='session'){text('last-updated','Reconnecting…');if(manual)toast('Could not refresh. Trying again automatically.');}});
  }
  canvas.addEventListener('mousemove',function(e){if(!points.length)return;var r=canvas.getBoundingClientRect(),x=e.clientX-r.left,p=points.reduce(function(best,item){return Math.abs(item.x-x)<Math.abs(best.x-x)?item:best;},points[0]),tip=$('chart-tooltip');tip.innerHTML='<strong>'+p.value+' visits</strong>'+new Intl.DateTimeFormat('en-GB',{timeZone:'Africa/Accra',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(p.t))+' GMT';tip.hidden=false;tip.style.left=Math.min(r.width-110,Math.max(0,p.x-45))+'px';tip.style.top=Math.max(0,p.y-48)+'px';});
  canvas.addEventListener('mouseleave',function(){$('chart-tooltip').hidden=true;});
  $('refresh').addEventListener('click',function(){refresh(true);});
  window.addEventListener('resize',sizeCanvas);document.addEventListener('visibilitychange',function(){if(!document.hidden)refresh(false);});
  sizeCanvas();refresh(false);setInterval(function(){if(!document.hidden)refresh(false);},10000);
})();
