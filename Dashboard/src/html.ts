/**
 * The dashboard page: one server-rendered template in the visual language of
 * the SPUT premium dashboard (Curzon palette, dense monospace layout,
 * Chart.js from CDN). The page carries no data — it fetches /api/series,
 * /api/tags, /api/prices and /api/status from its own origin on load, so a
 * page render is cheap and the JSON responses cache for a minute.
 */

export function dashboardHTML(sub: string): string {
  const title = `r/${sub.toUpperCase()}`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>URANIUM EXUBERANCE — ${title}</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600;700&family=Roboto+Mono:wght@400;500;700&display=swap" rel="stylesheet">
<script src="https://cdn.jsdelivr.net/npm/chart.js@4"></script>
<script src="https://cdn.jsdelivr.net/npm/luxon@3"></script>
<script src="https://cdn.jsdelivr.net/npm/chartjs-adapter-luxon@1"></script>
<style>
:root{
  /* Curzon Uranium brand palette (curzonuranium.com.cy :root tokens) */
  --bg:#FAF9F5; --ink:#1C244B; --navy:#253461; --slatenavy:#324A6D;
  --accent:#037DB4; --slate:#54595F; --pale:#C8D5DC; --faint:#E5E7EB; --wht:#FFFFFF;
  --green:#2E7D52; --red:#B23A2E; --gold:#C6A02E; --ember:#C1611E; --rule:#C6C6C6;
  --mono:"Bloomberg","IBM Plex Mono","Roboto Mono","Andale Mono",monospace;
}
*{box-sizing:border-box}
html,body{margin:0;background:var(--bg)}
body{color:var(--ink);font-family:var(--mono);font-size:13px;line-height:1.35;
  font-variant-numeric:tabular-nums;-webkit-font-smoothing:antialiased}
.up{color:var(--green)} .down{color:var(--red)} .neutral{color:var(--ink)}
.gray{color:var(--slate)}

.titlebar{background:linear-gradient(180deg,var(--navy),var(--ink));
  border-bottom:1px solid var(--rule);padding:5px 12px;display:flex;align-items:center;gap:14px;flex-wrap:wrap}
.titlebar .code{color:var(--wht);font-weight:700;font-size:15px;letter-spacing:.5px}
.titlebar .tags{color:var(--pale);font-size:11px;letter-spacing:.5px}
.titlebar .clock{margin-left:auto;color:var(--pale);font-size:11px}
.subbar{background:var(--slatenavy);color:var(--wht);padding:3px 12px;font-size:11px;
  border-left:3px solid var(--gold);letter-spacing:1px;display:flex;align-items:center;gap:16px;
  border-bottom:1px solid var(--rule)}
.subbar .r{margin-left:auto}
.dot{color:var(--green)} .dot.stale{color:var(--red)}

.gauge{background:var(--wht);border-left:3px solid var(--gold);border-bottom:1px solid var(--rule);
  padding:8px 12px 26px;font-size:11px}
.gauge .glabel{display:flex;align-items:center;gap:10px;color:var(--navy);font-weight:600;
  letter-spacing:1px;text-transform:uppercase;margin-bottom:24px}
.gauge .gband{font-weight:700}
.tape{position:relative;height:26px;width:100%;overflow:visible}
.zone{position:absolute;top:0;bottom:0}
.tick{position:absolute;top:0;bottom:0;width:1px;background:var(--wht);opacity:.7}
.tlab{position:absolute;top:27px;transform:translateX(-50%);color:var(--navy);font-size:9px;white-space:nowrap}
.needle{position:absolute;top:-6px;bottom:-6px;width:3px;background:var(--accent);
  transform:translateX(-1.5px);box-shadow:0 0 0 1px var(--wht)}
.needle::before{content:"";position:absolute;top:-9px;left:50%;transform:translateX(-50%);
  width:0;height:0;border-left:6px solid transparent;border-right:6px solid transparent;
  border-top:9px solid var(--accent);filter:drop-shadow(0 0 1px var(--wht))}
.nval{position:absolute;top:-22px;left:50%;transform:translateX(-50%);color:var(--ink);
  font-weight:700;font-size:10.5px;white-space:nowrap}

.grid{display:grid;gap:1px;background:var(--rule);border-bottom:1px solid var(--rule);
  grid-template-columns:repeat(6,minmax(0,1fr))}
@media(max-width:860px){.grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
.fld{background:var(--wht);padding:8px 12px;min-height:66px}
.fld .k{color:var(--navy);font-size:10.5px;letter-spacing:.8px;text-transform:uppercase;margin-bottom:3px}
.fld .v{font-size:20px;font-weight:700;text-align:right;white-space:nowrap}
.fld .sub{font-size:10.5px;text-align:right;margin-top:2px;color:var(--slate);white-space:nowrap}

.statusbar{background:var(--slatenavy);color:var(--wht);padding:3px 12px;font-size:11px;letter-spacing:1px;
  border-left:3px solid var(--gold);display:flex;gap:16px;align-items:center;
  border-top:1px solid var(--rule);border-bottom:1px solid var(--rule)}
.ranges{margin-left:auto;display:flex;gap:1px}
.ranges button{font-family:var(--mono);font-size:10.5px;letter-spacing:.5px;color:var(--wht);
  background:transparent;border:1px solid rgba(255,255,255,.55);padding:1px 7px;cursor:pointer}
.ranges button.on{background:var(--gold);color:var(--ink);border-color:var(--gold)}
.panel{padding:0}
#pricechart{width:100%;height:300px;padding:10px 10px 4px}
#volchart{width:100%;height:300px;padding:8px 10px 6px}

.tagwrap{background:var(--wht);border-bottom:1px solid var(--rule);padding:0 12px 8px;overflow-x:auto}
table.tags{width:100%;border-collapse:collapse;font-size:12px}
table.tags th{color:var(--navy);font-size:10px;letter-spacing:.8px;text-transform:uppercase;
  text-align:right;padding:6px 8px;border-bottom:1px solid var(--rule);cursor:default}
table.tags th:first-child,table.tags td:first-child{text-align:left}
table.tags td{padding:3px 8px;text-align:right;border-bottom:1px solid var(--faint)}
table.tags td.tag{font-weight:600;color:var(--navy)}
footer{padding:6px 12px;color:var(--slate);font-size:10.5px;line-height:1.5}
</style></head>
<body>
<div class="titlebar">
  <span class="code">${title}</span>
  <span class="tags">REDDIT · VOLUME + VADER TONE · NOWCAST</span>
  <span class="clock" id="clock">EXUBERANCE MONITOR</span>
</div>
<div class="subbar">
  <span>EXUBERANCE / DESPAIR MONITOR</span>
  <span class="r"><span class="dot" id="livedot">●</span> <span id="freshness">LOADING…</span></span>
</div>

<div class="gauge">
  <div class="glabel">CROWD GAUGE — 7D VOLUME Z + 7D SENTIMENT Z, VS TRAILING 365D
    <span class="gband" id="gband">—</span></div>
  <div class="tape" id="tape">
    <div class="zone" style="left:0%;width:25%;background:var(--red)"></div>
    <div class="zone" style="left:25%;width:16.667%;background:var(--ember);opacity:.75"></div>
    <div class="zone" style="left:41.667%;width:16.667%;background:var(--pale)"></div>
    <div class="zone" style="left:58.333%;width:16.667%;background:var(--green);opacity:.55"></div>
    <div class="zone" style="left:75%;width:25%;background:var(--green)"></div>
    <span class="tick" style="left:25%"></span><span class="tick" style="left:41.667%"></span>
    <span class="tick" style="left:50%"></span>
    <span class="tick" style="left:58.333%"></span><span class="tick" style="left:75%"></span>
    <span class="tlab" style="left:0%">−3 DESPAIR</span>
    <span class="tlab" style="left:25%">−1.5</span>
    <span class="tlab" style="left:41.667%">−0.5</span>
    <span class="tlab" style="left:50%">0</span>
    <span class="tlab" style="left:58.333%">+0.5</span>
    <span class="tlab" style="left:75%">+1.5</span>
    <span class="tlab" style="left:100%">+3 EXUBERANCE</span>
    <div class="needle" id="needle" style="display:none"><span class="nval" id="nval"></span></div>
  </div>
</div>

<div class="grid">
  <div class="fld"><div class="k">Gauge</div><div class="v" id="f-gauge">—</div><div class="sub" id="f-band">&nbsp;</div></div>
  <div class="fld"><div class="k">Volume 7D</div><div class="v" id="f-vol">—</div><div class="sub" id="f-pct">items/day</div></div>
  <div class="fld"><div class="k">Volume Z</div><div class="v" id="f-volz">—</div><div class="sub">vs trailing 365d</div></div>
  <div class="fld"><div class="k">Sentiment 7D</div><div class="v" id="f-sent">—</div><div class="sub">mean VADER compound</div></div>
  <div class="fld"><div class="k">Sentiment Z</div><div class="v" id="f-sentz">—</div><div class="sub">vs trailing 365d</div></div>
  <div class="fld"><div class="k">Authors 7D</div><div class="v" id="f-auth">—</div><div class="sub">unique/day</div></div>
</div>

<div class="statusbar">
  <span><span class="dot">●</span> SPUT (U.U) &amp; URNM — INDEXED 100 AT WINDOW START · CLICK LEGEND TO TOGGLE</span>
  <span class="ranges" id="ranges">
    <button data-range="1M">1M</button><button data-range="3M">3M</button>
    <button data-range="6M">6M</button><button data-range="1Y">1Y</button>
    <button data-range="ALL" class="on">ALL</button>
  </span>
</div>
<div class="panel"><canvas id="pricechart"></canvas></div>
<div class="statusbar"><span><span class="dot">●</span> DAILY POSTS+COMMENTS (BARS) · 7D MEAN VADER COMPOUND (LINE) · SHADED TAIL = COLLECTOR STILL FILLING</span></div>
<div class="panel"><canvas id="volchart"></canvas></div>

<div class="statusbar"><span><span class="dot">●</span> PER-TAG ACTIVITY — 7 FULL DAYS VS BASELINES · <span id="tagasof"></span></span></div>
<div class="tagwrap"><table class="tags"><thead>
  <tr><th>Tag</th><th>7D items</th><th>Δ vs 90D</th><th>7D sent</th><th>Vol Z</th></tr>
</thead><tbody id="tagbody"></tbody></table></div>

<footer id="footer">
  NOWCAST, NOT A LEADING INDICATOR — THE BAROMETER LAGS PRICE (LEAD-LAG PRE-TEST, MODEL/FINDINGS.MD).
  SENTIMENT IS DOMAIN-ADAPTED VADER, A DIRECTIONAL TONE GAUGE (3-CLASS AGREEMENT ≈52%, κ≈0.19 VS THE GOLD SET);
  ONLY DAILY AGGREGATES ARE SHOWN, NEVER PER-ITEM SCORES. TRAILING ~2 DAYS OF REDDIT DATA ARE PARTIAL.
  PRICES: YAHOO FINANCE EOD (URNM · U-U.TO), REFRESHED 22:30 UTC WEEKDAYS. OFF_TOPIC HAS NO KEYWORD TERMS AND IS ABSENT FROM THE TAG TABLE.
</footer>

<script>
const NAVY='#253461', GOLD='#C6A02E', ACCENT='#037DB4', GRIDC='#E5E7EB', RULEC='#C6C6C6';
Chart.defaults.color = NAVY;
Chart.defaults.borderColor = GRIDC;
Chart.defaults.font.family = "'IBM Plex Mono','Roboto Mono',monospace";
Chart.defaults.font.size = 11;

const $ = (id) => document.getElementById(id);
const sign = (n, dp=2) => n==null ? '—' : (n>=0?'+':'')+n.toFixed(dp);
const dir = (n) => n==null ? 'neutral' : n>0 ? 'up' : n<0 ? 'down' : 'neutral';
const hexA = (hex,a)=>{const h=hex.replace('#','');const n=parseInt(h,16);return 'rgba('+((n>>16)&255)+','+((n>>8)&255)+','+(n&255)+','+a+')';};

let DAILY=[], PARTIAL_AFTER=null, PRICES={}, charts=[];
const LINK={index:null};

// 7d trailing mean of the daily mean-compound, skipping null (no-text) days.
function smooth7(rows){
  const out=[];
  for(let i=0;i<rows.length;i++){
    if(i<6){ out.push(null); continue; }
    const w=rows.slice(i-6,i+1).map(r=>r.s).filter(v=>v!=null);
    out.push(w.length ? w.reduce((a,b)=>a+b,0)/w.length : null);
  }
  return out;
}

// Rebase a [date, close] series to 100 at the first row inside the window.
function indexed(rows, minDate){
  const inWin = minDate ? rows.filter(r=>r[0]>=minDate) : rows;
  const base = inWin.length ? inWin[0][1] : null;
  return inWin.map(r=>({x:r[0], y: base ? 100*r[1]/base : null, raw:r[1]}));
}

const rangeMin = (r) => {
  if(r==='ALL'||!DAILY.length) return undefined;
  const last=new Date(DAILY[DAILY.length-1].d);
  const d=new Date(last);
  if(r==='1Y') d.setUTCFullYear(d.getUTCFullYear()-1);
  else d.setUTCMonth(d.getUTCMonth()-({'1M':1,'3M':3,'6M':6}[r]));
  return d.toISOString().slice(0,10);
};

// Shade the still-filling collector tail on any chart.
const partialShade = { id:'partialShade', beforeDatasetsDraw(c){
  if(!PARTIAL_AFTER) return;
  const a=c.chartArea, xs=c.scales.x; if(!a||!xs) return;
  let px=xs.getPixelForValue(Date.parse(PARTIAL_AFTER));
  if(px>=a.right) return; px=Math.max(a.left,px);
  const ctx=c.ctx; ctx.save();
  ctx.fillStyle=hexA(NAVY,.07); ctx.fillRect(px,a.top,a.right-px,a.bottom-a.top);
  ctx.restore();
}};

// Linked crosshair across both charts (SPUT-dash pattern, without measure).
function snapTime(c,px){ const xs=c.scales.x; return xs?xs.getValueForPixel(px):null; }
const interact = { id:'interact',
  afterInit(c){
    charts.push(c);
    const cv=c.canvas;
    cv.addEventListener('mousemove',(e)=>{ const p=Chart.helpers.getRelativePosition(e,c);
      LINK.index=snapTime(c,p.x); charts.forEach(k=>k.update('none')); });
    cv.addEventListener('mouseleave',()=>{ LINK.index=null; charts.forEach(k=>k.update('none')); });
  },
  afterDatasetsDraw(c){
    if(LINK.index==null) return;
    const a=c.chartArea, xs=c.scales.x, ctx=c.ctx; if(!a||!xs) return;
    const px=xs.getPixelForValue(LINK.index); if(px<a.left||px>a.right) return;
    ctx.save(); ctx.strokeStyle=hexA('#54595F',.6); ctx.lineWidth=1;
    ctx.beginPath(); ctx.moveTo(px,a.top); ctx.lineTo(px,a.bottom); ctx.stroke(); ctx.restore();
  }
};

let priceChart, volChart;
function buildCharts(){
  const timeScale = { type:'time', time:{unit:'year', tooltipFormat:'yyyy-MM-dd'},
    ticks:{color:NAVY}, grid:{color:GRIDC}, border:{color:RULEC} };
  const tooltipStyle = { backgroundColor:NAVY, borderColor:NAVY, borderWidth:1,
    titleColor:'#FFFFFF', bodyColor:'#FFFFFF' };

  priceChart = new Chart($('pricechart'), {
    type:'line',
    data:{ datasets:[
      { label:'SPUT (U.U)', key:'u-u-to', data:[], borderColor:NAVY, backgroundColor:NAVY,
        borderWidth:1.4, pointRadius:0, tension:.05, spanGaps:true },
      { label:'URNM', key:'urnm', data:[], borderColor:GOLD, backgroundColor:GOLD,
        borderWidth:1.4, pointRadius:0, tension:.05, spanGaps:true },
    ]},
    options:{ responsive:true, maintainAspectRatio:false,
      interaction:{mode:'index', intersect:false},
      scales:{ x:timeScale,
        y:{ title:{display:true,text:'INDEXED (100 = WINDOW START)',color:NAVY},
            grid:{color:GRIDC}, border:{color:RULEC} } },
      plugins:{ legend:{labels:{color:NAVY, boxWidth:14, boxHeight:2}},
        tooltip:{...tooltipStyle, callbacks:{ label:(c)=>' '+c.dataset.label+': '+
          (c.parsed.y==null?'—':c.parsed.y.toFixed(1))+
          (c.raw&&c.raw.raw!=null?'  ($'+c.raw.raw.toFixed(2)+')':'') }}}},
    plugins:[interact, partialShade]
  });

  volChart = new Chart($('volchart'), {
    type:'bar',
    data:{ datasets:[
      { type:'bar', label:'POSTS+COMMENTS', data:[], backgroundColor:hexA(ACCENT,.55),
        borderWidth:0, yAxisID:'y', barPercentage:1, categoryPercentage:1 },
      { type:'line', label:'7D SENTIMENT', data:[], borderColor:GOLD, backgroundColor:GOLD,
        borderWidth:1.6, pointRadius:0, tension:.15, spanGaps:true, yAxisID:'y2' },
    ]},
    options:{ responsive:true, maintainAspectRatio:false,
      interaction:{mode:'index', intersect:false},
      // offset:false — the bar default pads half a tick unit (half a YEAR at
      // the ALL range) of dead space on each side of the axis.
      scales:{ x:{...timeScale, offset:false},
        y:{ position:'left', title:{display:true,text:'ITEMS / DAY',color:NAVY},
            grid:{color:GRIDC}, border:{color:RULEC} },
        y2:{ position:'right', min:-1, max:1,
             title:{display:true,text:'VADER COMPOUND',color:NAVY},
             grid:{drawOnChartArea:false}, border:{color:RULEC} } },
      plugins:{ legend:{labels:{color:NAVY, boxWidth:14, boxHeight:2}},
        tooltip:{...tooltipStyle, callbacks:{ label:(c)=>' '+c.dataset.label+': '+
          (c.parsed.y==null?'—':(c.dataset.yAxisID==='y2'?c.parsed.y.toFixed(3):c.parsed.y)) }}}},
    plugins:[interact, partialShade]
  });
}

function applyRange(range){
  // One shared window for both panels so the linked crosshair lines up:
  // never earlier than the Reddit series, never padded past the last day.
  const min = rangeMin(range) || (DAILY.length ? DAILY[0].d : undefined);
  const max = DAILY.length ? DAILY[DAILY.length-1].d : undefined;
  for(const [i,key] of [[0,'u-u-to'],[1,'urnm']]){
    const series = PRICES[key];
    priceChart.data.datasets[i].data = series ? indexed(series.rows, min) : [];
  }
  const rows = min ? DAILY.filter(r=>r.d>=min) : DAILY;
  const offset = DAILY.length - rows.length;
  const sm = smooth7(DAILY);
  volChart.data.datasets[0].data = rows.map(r=>({x:r.d, y:r.p+r.c}));
  volChart.data.datasets[1].data = rows.map((r,i)=>({x:r.d, y:sm[offset+i]}));
  const unit = rows.length>500 ? 'year' : rows.length>120 ? 'month' : 'week';
  for(const c of [priceChart, volChart]){
    c.options.scales.x.time.unit = unit;
    c.options.scales.x.min = min;
    c.options.scales.x.max = max;
    c.update();
  }
}

function renderGauge(g){
  if(!g){ $('gband').textContent='INSUFFICIENT HISTORY'; return; }
  const pct = Math.max(0, Math.min(100, ((g.value+3)/6)*100));
  const nd=$('needle'); nd.style.display='block'; nd.style.left=pct.toFixed(2)+'%';
  $('nval').textContent = sign(g.value);
  $('gband').textContent = g.band.toUpperCase()+' · AS OF '+g.asof;
  $('f-gauge').textContent = sign(g.value);
  $('f-gauge').className = 'v '+dir(g.value);
  $('f-band').textContent = g.band.toUpperCase();
  $('f-vol').textContent = Math.round(g.vol_7d).toLocaleString('en-US');
  $('f-pct').textContent = 'all-time pctile '+(g.vol_pctile_alltime*100).toFixed(0)+'%';
  $('f-volz').textContent = sign(g.volume_z); $('f-volz').className='v '+dir(g.volume_z);
  $('f-sent').textContent = sign(g.sent_7d,3); $('f-sent').className='v '+dir(g.sent_7d);
  $('f-sentz').textContent = sign(g.sentiment_z); $('f-sentz').className='v '+dir(g.sentiment_z);
}

function renderTags(tags){
  $('tagasof').textContent = 'AS OF '+(tags.asof||'—');
  $('tagbody').innerHTML = tags.tags.map(t=>
    '<tr><td class="tag">'+t.key+'</td>'+
    '<td>'+t.items_7d.toLocaleString('en-US')+'</td>'+
    '<td class="'+dir(t.delta_vs_90d)+'">'+(t.delta_vs_90d==null?'—':sign(t.delta_vs_90d*100,0)+'%')+'</td>'+
    '<td class="'+dir(t.sent_7d)+'">'+(t.sent_7d==null?'—':sign(t.sent_7d,3))+'</td>'+
    '<td class="'+dir(t.volume_z)+'">'+(t.volume_z==null?'—':sign(t.volume_z,1))+'</td></tr>'
  ).join('');
}

function renderStatus(st){
  const dotEl=$('livedot');
  dotEl.className = 'dot'+(st.stale?' stale':'');
  const when = st.generated_at ? new Date(st.generated_at*1000).toISOString().slice(0,16).replace('T',' ')+'Z' : '—';
  const prices = st.prices_updated_at ? new Date(st.prices_updated_at*1000).toISOString().slice(0,10) : '—';
  $('freshness').textContent = (st.stale?'STALE — LAST DERIVE ':'DERIVE ')+when+' · PRICES '+prices;
  $('clock').textContent = 'EXUBERANCE MONITOR · AS OF '+when;
}

async function boot(){
  const [series, tags, prices, status] = await Promise.all(
    ['/api/series','/api/tags','/api/prices','/api/status'].map(u=>fetch(u).then(r=>r.json()))
  );
  DAILY = series.daily||[]; PARTIAL_AFTER = series.partial_after; PRICES = prices;
  const authors7 = DAILY.length>9
    ? DAILY.slice(-9,-2).reduce((a,r)=>a+r.a,0)/7 : null;
  buildCharts();
  applyRange('ALL');
  renderGauge(series.gauge);
  if(authors7!=null) $('f-auth').textContent = Math.round(authors7).toLocaleString('en-US');
  renderTags(tags);
  renderStatus(status);
  document.querySelectorAll('.ranges button').forEach(b=>b.addEventListener('click',()=>{
    document.querySelectorAll('.ranges button').forEach(x=>x.classList.remove('on'));
    b.classList.add('on');
    applyRange(b.dataset.range);
  }));
  // The derive cron lands hourly; refresh the freshness line every 5 minutes.
  setInterval(async()=>{ renderStatus(await fetch('/api/status').then(r=>r.json())); }, 300000);
}
boot().catch(e=>{ $('freshness').textContent='LOAD FAILED — '+e.message; $('livedot').className='dot stale'; });
</script>
</body></html>`;
}
