/**
 * The v2 dashboard page (spec: DASHBOARD.md "Page design (v2)"): a
 * yellowcake-style card layout — centered column, rounded cards, delta
 * badges, timeframe pills — with light/dark themes, one overlay chart
 * (volume bars + indexed prices + sentiment line), press-and-hold
 * measurement on every chart, and per-tag click-through detail charts.
 * The page carries no data; it fetches /api/* from its own origin on load.
 */

export function dashboardHTML(sub: string): string {
  const title = `r/${sub.charAt(0).toUpperCase()}${sub.slice(1)}`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Uranium Exuberance — ${title}</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<script src="https://cdn.jsdelivr.net/npm/chart.js@4"></script>
<script src="https://cdn.jsdelivr.net/npm/luxon@3"></script>
<script src="https://cdn.jsdelivr.net/npm/chartjs-adapter-luxon@1"></script>
<style>
:root{
  --bg:#F4F3EE; --card:#FFFFFF; --card2:#FAF9F4; --border:#E2E0D5; --ink:#191A14;
  --muted:#6E6F64; --gold:#A87B0B; --goldsoft:rgba(168,123,11,.12);
  --green:#1E7A4C; --greensoft:rgba(30,122,76,.12);
  --red:#B23A2E; --redsoft:rgba(178,58,46,.12);
  --accent:#0E6E9E; --tape-neutral:#D5D3C8;
  --sans:'Inter',-apple-system,'Segoe UI',sans-serif;
  --mono:'IBM Plex Mono','Roboto Mono',monospace;
}
html[data-theme="dark"]{
  --bg:#0C0D0A; --card:#14150F; --card2:#191A13; --border:#26271F; --ink:#ECEBE2;
  --muted:#9A9B8E; --gold:#E0A83C; --goldsoft:rgba(224,168,60,.14);
  --green:#5BC48C; --greensoft:rgba(91,196,140,.14);
  --red:#E07862; --redsoft:rgba(224,120,98,.14);
  --accent:#5FB0E0; --tape-neutral:#3A3B32;
}
*{box-sizing:border-box}
html,body{margin:0;background:var(--bg);overflow-x:hidden}
body{color:var(--ink);font-family:var(--sans);font-size:14px;line-height:1.45;
  -webkit-font-smoothing:antialiased}
.mono,.num{font-family:var(--mono);font-variant-numeric:tabular-nums}
a{color:var(--gold)}
.up{color:var(--green)} .down{color:var(--red)}
.badge{display:inline-block;font-family:var(--mono);font-size:11.5px;font-weight:600;
  padding:1px 7px;border-radius:6px;white-space:nowrap}
.badge.up{background:var(--greensoft);color:var(--green)}
.badge.down{background:var(--redsoft);color:var(--red)}
.badge.flat{background:var(--goldsoft);color:var(--gold)}

.topbar{position:sticky;top:0;z-index:5;background:var(--bg);border-bottom:1px solid var(--border)}
.topbar .in{max-width:1160px;margin:0 auto;padding:12px 20px;display:flex;align-items:center;gap:14px;flex-wrap:wrap}
.brand{font-weight:700;font-size:18px}
.brand .accent{color:var(--gold)}
.brand small{color:var(--muted);font-weight:500;margin-left:8px}
.topbar .right{margin-left:auto;display:flex;align-items:center;gap:12px;font-size:12px;color:var(--muted)}
.dot{color:var(--green);font-size:14px} .dot.stale{color:var(--red)}
#themebtn{background:var(--card);border:1px solid var(--border);color:var(--ink);
  border-radius:8px;padding:4px 10px;cursor:pointer;font-family:var(--sans);font-size:12px}

.ticker{border-bottom:1px solid var(--border);background:var(--card)}
.ticker .in{max-width:1160px;margin:0 auto;padding:6px 20px;display:flex;gap:22px;
  font-family:var(--mono);font-size:12px;flex-wrap:wrap;color:var(--muted)}
.ticker b{color:var(--ink);font-weight:600}

.wrap{max-width:1160px;margin:0 auto;padding:18px 20px 40px;display:flex;flex-direction:column;gap:16px}
.card{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:16px 18px}
.card h2{margin:0 0 4px;font-size:15px;font-weight:600}
.card .subtitle{color:var(--muted);font-size:12px;margin-bottom:10px}

.today{display:flex;gap:26px;flex-wrap:wrap;align-items:baseline}
.today .t-label{font-size:11px;letter-spacing:1px;color:var(--gold);font-weight:700;text-transform:uppercase}
.today .item{font-size:13px;color:var(--muted)}
.today .item b{font-family:var(--mono);color:var(--ink);font-size:14px}

.kpis{display:grid;grid-template-columns:repeat(6,1fr);gap:12px}
@media(max-width:980px){.kpis{grid-template-columns:repeat(3,1fr)}}
@media(max-width:620px){.kpis{grid-template-columns:repeat(2,1fr)}}
.kpi{background:var(--card);border:1px solid var(--border);border-radius:12px;
  padding:12px 14px;cursor:pointer;text-align:left;font-family:var(--sans);color:var(--ink);transition:border-color .15s}
.kpi:hover{border-color:var(--gold)}
.kpi.on{border-color:var(--gold);background:var(--card2)}
.kpi .k{font-size:10.5px;letter-spacing:.8px;text-transform:uppercase;color:var(--muted);margin-bottom:5px}
.kpi .v{font-family:var(--mono);font-size:19px;font-weight:600}
.kpi .s{font-size:11px;color:var(--muted);margin-top:4px}

.tape-wrap{padding:26px 4px 4px}
.tape{position:relative;height:22px;border-radius:6px;overflow:visible}
.zone{position:absolute;top:0;bottom:0}
.zone:first-child{border-radius:6px 0 0 6px}.zone:nth-child(5){border-radius:0 6px 6px 0}
.needle{position:absolute;top:-6px;bottom:-6px;width:3px;background:var(--accent);
  transform:translateX(-1.5px);box-shadow:0 0 0 1px var(--card)}
.needle::before{content:"";position:absolute;top:-8px;left:50%;transform:translateX(-50%);
  width:0;height:0;border-left:5px solid transparent;border-right:5px solid transparent;
  border-top:8px solid var(--accent)}
.nval{position:absolute;top:-24px;left:50%;transform:translateX(-50%);
  font-family:var(--mono);font-weight:600;font-size:12px;white-space:nowrap}
.guide{display:flex;gap:10px 18px;flex-wrap:wrap;margin-top:14px;font-size:11.5px;color:var(--muted)}
.guide .g{display:flex;align-items:center;gap:6px}
.guide .sw{width:12px;height:12px;border-radius:3px;display:inline-block}
.guide-note{margin-top:8px;font-size:11.5px;color:var(--muted)}

.chart-head{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:8px}
.pills{margin-left:auto;display:flex;gap:4px}
.pills button{font-family:var(--mono);font-size:11.5px;color:var(--muted);background:transparent;
  border:1px solid var(--border);border-radius:7px;padding:2px 9px;cursor:pointer}
.pills button.on{background:var(--goldsoft);border-color:var(--gold);color:var(--gold);font-weight:600}
.chartbox{position:relative;height:380px}
.chartbox.tagbox{height:260px}
.chartbox canvas{touch-action:pan-y}
.hint{font-size:11px;color:var(--muted);margin-top:8px}

.taggrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(168px,1fr));gap:10px}
.tagcard{background:var(--card2);border:1px solid var(--border);border-radius:10px;
  padding:10px 12px;cursor:pointer;font-family:var(--sans);color:var(--ink);text-align:left;transition:border-color .15s}
.tagcard:hover{border-color:var(--gold)}
.tagcard.on{border-color:var(--gold)}
.tagcard .k{font-family:var(--mono);font-size:12px;font-weight:600;color:var(--gold);margin-bottom:4px}
.tagcard .row{display:flex;justify-content:space-between;align-items:baseline;font-size:12px;color:var(--muted)}
.tagcard .row b{font-family:var(--mono);color:var(--ink)}
#tagdetail{margin-top:14px;border-top:1px solid var(--border);padding-top:14px;display:none}
#tagdetail .chart-head h3{margin:0;font-size:14px}
#tagclose{margin-left:8px;background:transparent;border:1px solid var(--border);color:var(--muted);
  border-radius:7px;padding:2px 9px;cursor:pointer;font-size:11.5px}
details.quiet{margin-top:12px;color:var(--muted);font-size:12.5px}
details.quiet .taggrid{margin-top:10px}

footer{max-width:1160px;margin:0 auto;padding:0 20px 30px;color:var(--muted);font-size:11.5px;line-height:1.6}
</style></head>
<body>
<div class="topbar"><div class="in">
  <span class="brand">${title} <span class="accent">Exuberance Monitor</span><small>Reddit crowd nowcast</small></span>
  <span class="right"><span class="dot" id="livedot">●</span><span id="freshness">loading…</span>
  <button id="themebtn" title="toggle light/dark">◐ theme</button></span>
</div></div>
<div class="ticker"><div class="in" id="ticker">loading…</div></div>

<div class="wrap">
  <div class="card today" id="today"><span class="t-label">Today in ${title}</span></div>

  <div class="kpis" id="kpis"></div>

  <div class="card">
    <h2>Crowd gauge <span class="num" id="gband" style="color:var(--gold)"></span></h2>
    <div class="subtitle">7-day volume z + 7-day sentiment z, each against the trailing 365 days</div>
    <div class="tape-wrap"><div class="tape" id="tape">
      <div class="zone" style="left:0%;width:25%;background:var(--red)"></div>
      <div class="zone" style="left:25%;width:16.667%;background:var(--red);opacity:.45"></div>
      <div class="zone" style="left:41.667%;width:16.667%;background:var(--tape-neutral)"></div>
      <div class="zone" style="left:58.333%;width:16.667%;background:var(--green);opacity:.45"></div>
      <div class="zone" style="left:75%;width:25%;background:var(--green)"></div>
      <div class="needle" id="needle" style="display:none"><span class="nval" id="nval"></span></div>
    </div></div>
    <div class="guide">
      <span class="g"><span class="sw" style="background:var(--red)"></span>≤ −1.5 peak despair</span>
      <span class="g"><span class="sw" style="background:var(--red);opacity:.45"></span>−1.5 … −0.5 despondent</span>
      <span class="g"><span class="sw" style="background:var(--tape-neutral)"></span>−0.5 … +0.5 neutral</span>
      <span class="g"><span class="sw" style="background:var(--green);opacity:.45"></span>+0.5 … +1.5 excited</span>
      <span class="g"><span class="sw" style="background:var(--green)"></span>≥ +1.5 peak exuberance</span>
    </div>
    <div class="guide-note" id="gnote">How it's read: exuberance = unusually many people talking, unusually bullishly;
      despair = silence plus negativity. Both components are shown in the boxes above — the composite is never a black box.</div>
  </div>

  <div class="card">
    <div class="chart-head">
      <div><h2>Activity vs price</h2>
      <div class="subtitle">Daily posts+comments (bars) · SPUT &amp; URNM indexed to 100 at window start · 7d VADER tone</div></div>
      <div class="pills" id="pills">
        <button data-range="1M">1M</button><button data-range="3M">3M</button>
        <button data-range="6M">6M</button><button data-range="1Y">1Y</button>
        <button data-range="ALL" class="on">ALL</button>
      </div>
    </div>
    <div class="chartbox"><canvas id="mainchart"></canvas></div>
    <div class="hint">Click the legend to toggle a series · press and hold, then drag (either direction) to measure change over time · Esc clears · shaded tail = collector still filling</div>
  </div>

  <div class="card">
    <h2>Tags</h2>
    <div class="subtitle" id="tagsub">Per-tag activity, last 7 full days vs baselines — click a tag for its chart</div>
    <div class="taggrid" id="taggrid"></div>
    <details class="quiet"><summary id="quietsum">Quiet tags</summary><div class="taggrid" id="quietgrid"></div></details>
    <div id="tagdetail">
      <div class="chart-head"><h3 id="tagtitle"></h3>
        <div class="pills" id="tagpills">
          <button data-mode="daily" class="on">180D DAILY</button>
          <button data-mode="weekly">FULL WEEKLY</button>
        </div><button id="tagclose">✕ close</button></div>
      <div class="chartbox tagbox"><canvas id="tagchart"></canvas></div>
    </div>
  </div>
</div>

<footer>
  <b>Nowcast, not a leading indicator</b> — the barometer lags price (lead-lag pre-test, Model/FINDINGS.md).
  Sentiment is domain-adapted VADER, a directional tone gauge; only daily aggregates are shown, never per-item scores.
  Trailing ~2 days of Reddit data are partial while the collector fills them. Prices: Yahoo Finance EOD
  (URNM · U-U.TO), refreshed 22:30 UTC weekdays. OFF_TOPIC has no keyword terms and is absent from the tag grid.
</footer>

<script>
'use strict';
const $ = (id) => document.getElementById(id);
const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const sign = (n, dp=2) => n==null ? '—' : (n>=0?'+':'')+n.toFixed(dp);
const pct = (r, dp=0) => r==null ? '—' : (r>=0?'+':'')+(r*100).toFixed(dp)+'%';
const fmtN = (n) => n==null ? '—' : Math.round(n).toLocaleString('en-US');
const dirCls = (n) => n==null ? 'flat' : n>0.0005 ? 'up' : n<-0.0005 ? 'down' : 'flat';
const badge = (r) => '<span class="badge '+dirCls(r)+'">'+pct(r)+'</span>';

// ---------- theme ----------
function themePref(){ return localStorage.getItem('theme')
  || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'); }
function setTheme(t){ document.documentElement.dataset.theme = t; localStorage.setItem('theme', t); }
setTheme(themePref());

// ---------- state ----------
let SERIES=null, TAGS=null, PRICES=null, DAILY=[], SMOOTH=[], RANGE='ALL', ANALOG_WIN=null;
let mainChart=null, tagChart=null, openTag=null, tagMode='daily';
const charts=[]; const LINK={t:null};

function smooth7(rows){
  const out=[];
  for(let i=0;i<rows.length;i++){
    if(i<6){ out.push(null); continue; }
    const w=rows.slice(i-6,i+1).map(r=>r.s).filter(v=>v!=null);
    out.push(w.length ? w.reduce((a,b)=>a+b,0)/w.length : null);
  }
  return out;
}
function indexed(rows, minDate, maxDate){
  const w = rows.filter(r=>(!minDate||r[0]>=minDate)&&(!maxDate||r[0]<=maxDate));
  const base = w.length ? w[0][1] : null;
  return w.map(r=>({x:r[0], y: base?100*r[1]/base:null, raw:r[1]}));
}
const rangeMin = (r) => {
  if(r==='ALL'||!DAILY.length) return DAILY.length?DAILY[0].d:undefined;
  const d=new Date(DAILY[DAILY.length-1].d);
  if(r==='1Y') d.setUTCFullYear(d.getUTCFullYear()-1);
  else d.setUTCMonth(d.getUTCMonth()-({'1M':1,'3M':3,'6M':6}[r]));
  return d.toISOString().slice(0,10);
};

// ---------- shared chart plugins ----------
const hexA=(hex,a)=>{const h=hex.replace('#','');const n=parseInt(h.length===3?h.split('').map(c=>c+c).join(''):h,16);
  return 'rgba('+((n>>16)&255)+','+((n>>8)&255)+','+(n&255)+','+a+')';};

const partialShade = { id:'partialShade', beforeDatasetsDraw(c){
  const pa = SERIES && SERIES.partial_after; if(!pa) return;
  const a=c.chartArea, xs=c.scales.x; if(!a||!xs) return;
  let px=xs.getPixelForValue(Date.parse(pa));
  if(px>=a.right) return; px=Math.max(a.left,px);
  c.ctx.save(); c.ctx.fillStyle=hexA(css('--ink').startsWith('#')?css('--ink'):'#888888',.06);
  c.ctx.fillRect(px,a.top,a.right-px,a.bottom-a.top); c.ctx.restore();
}};

// Press-and-hold measurement + linked crosshair. Datasets opt into the
// readout via dataset.measure: 'abs' (bars), 'pct' (prices), 'delta' (tone).
function nearest(ds, t){
  let best=null, bd=Infinity;
  for(const p of ds.data){ if(p.y==null) continue;
    const d=Math.abs(Date.parse(p.x)-t); if(d<bd){bd=d;best=p;} }
  return best;
}
const interact = { id:'interact',
  afterInit(c){
    charts.push(c);
    c.$m={a:null,b:null,on:false,drag:false};
    const cv=c.canvas;
    const t=(e)=>{const p=Chart.helpers.getRelativePosition(e,c);const xs=c.scales.x;
      return xs?Math.max(xs.min,Math.min(xs.max,xs.getValueForPixel(p.x))):null;};
    cv.addEventListener('pointerdown',(e)=>{ const v=t(e); if(v==null)return;
      c.$m.a=v; c.$m.b=v; c.$m.on=true; c.$m.drag=true; cv.setPointerCapture(e.pointerId); c.update('none'); });
    cv.addEventListener('pointermove',(e)=>{ const v=t(e); if(v==null)return;
      if(c.$m.drag){ c.$m.b=v; c.update('none'); }
      else { LINK.t=v; charts.forEach(k=>k.update('none')); } });
    cv.addEventListener('pointerup',()=>{ c.$m.drag=false;
      if(Math.abs(c.$m.b-c.$m.a)<43200000) c.$m.on=false; c.update('none'); });
    cv.addEventListener('pointerleave',()=>{ if(!c.$m.drag){ LINK.t=null; charts.forEach(k=>k.update('none')); } });
  },
  afterDatasetsDraw(c){
    const a=c.chartArea, xs=c.scales.x, ctx=c.ctx; if(!a||!xs) return;
    if(LINK.t!=null && !c.$m.on){
      const px=xs.getPixelForValue(LINK.t);
      if(px>=a.left&&px<=a.right){ ctx.save(); ctx.strokeStyle=hexA(css('--gold'),.5); ctx.lineWidth=1;
        ctx.beginPath(); ctx.moveTo(px,a.top); ctx.lineTo(px,a.bottom); ctx.stroke(); ctx.restore(); }
    }
    const m=c.$m; if(!m||!m.on||m.a==null||m.b==null) return;
    const t0=Math.min(m.a,m.b), t1=Math.max(m.a,m.b);
    const x0=Math.max(a.left,xs.getPixelForValue(t0)), x1=Math.min(a.right,xs.getPixelForValue(t1));
    ctx.save();
    ctx.fillStyle=hexA(css('--gold'),.10); ctx.fillRect(x0,a.top,x1-x0,a.bottom-a.top);
    ctx.strokeStyle=hexA(css('--gold'),.9); ctx.lineWidth=1;
    ctx.beginPath(); ctx.moveTo(x0,a.top); ctx.lineTo(x0,a.bottom); ctx.moveTo(x1,a.top); ctx.lineTo(x1,a.bottom); ctx.stroke();
    const days=Math.round((t1-t0)/86400000);
    const d0=new Date(t0).toISOString().slice(0,10), d1=new Date(t1).toISOString().slice(0,10);
    const rows=[[d0+' → '+d1+'  ('+days+'d)', null]];
    c.data.datasets.forEach((ds,i)=>{
      if(!ds.measure || !c.isDatasetVisible(i)) return;
      const p0=nearest(ds,t0), p1=nearest(ds,t1); if(!p0||!p1) return;
      const v0=ds.measure==='pct'?(p0.raw??p0.y):p0.y, v1=ds.measure==='pct'?(p1.raw??p1.y):p1.y;
      if(ds.measure==='delta') rows.push([ds.label+'  '+v0.toFixed(3)+' → '+v1.toFixed(3)+'  ('+sign(v1-v0,3)+')', v1-v0]);
      else if(ds.measure==='pct') rows.push([ds.label+'  '+pct(v1/v0-1,1), v1/v0-1]);
      else rows.push([ds.label+'  '+fmtN(v0)+' → '+fmtN(v1)+'  ('+(v0?pct(v1/v0-1,0):'—')+')', v1-v0]);
    });
    ctx.font="600 11px 'IBM Plex Mono',monospace";
    let w=0; rows.forEach(r=>{ w=Math.max(w,ctx.measureText(r[0]).width); });
    const pad=7, lh=15, bw=w+pad*2, bh=rows.length*lh+pad*2;
    let bx=x1+8; if(bx+bw>a.right) bx=x0-bw-8; if(bx<a.left) bx=a.left+6;
    ctx.fillStyle=css('--card'); ctx.strokeStyle=css('--border');
    ctx.beginPath(); ctx.roundRect(bx,a.top+6,bw,bh,6); ctx.fill(); ctx.stroke();
    let ty=a.top+6+pad+10;
    rows.forEach(r=>{ ctx.fillStyle=r[1]==null?css('--muted'):(r[1]>=0?css('--green'):css('--red'));
      ctx.fillText(r[0],bx+pad,ty); ty+=lh; });
    ctx.restore();
  }
};
window.addEventListener('keydown',(e)=>{ if(e.key==='Escape'){
  charts.forEach(c=>{ if(c.$m){c.$m.on=false;} c.update('none'); }); }});

// ---------- charts ----------
function chartDefaults(){
  Chart.defaults.color = css('--muted');
  Chart.defaults.borderColor = css('--border');
  Chart.defaults.font.family = "'Inter',sans-serif";
  Chart.defaults.font.size = 11;
}
function timeScale(){ return { type:'time', time:{unit:'year', tooltipFormat:'yyyy-MM-dd'},
  grid:{color:css('--border')}, border:{color:css('--border')} }; }
function tooltipStyle(){ return { backgroundColor:css('--card'), borderColor:css('--border'), borderWidth:1,
  titleColor:css('--ink'), bodyColor:css('--ink') }; }

function buildMainChart(){
  if(mainChart){ const i=charts.indexOf(mainChart); if(i>=0)charts.splice(i,1); mainChart.destroy(); }
  mainChart = new Chart($('mainchart'), {
    type:'bar',
    data:{ datasets:[
      { type:'bar', label:'Posts+comments', measure:'abs', data:[], yAxisID:'y',
        backgroundColor:hexA(css('--accent'),.45), borderWidth:0, barPercentage:1, categoryPercentage:1 },
      { type:'line', label:'SPUT (U.U)', measure:'pct', key:'u-u-to', data:[], yAxisID:'yr',
        borderColor:css('--ink'), backgroundColor:css('--ink'), borderWidth:1.5, pointRadius:0, tension:.05, spanGaps:true },
      { type:'line', label:'URNM', measure:'pct', key:'urnm', data:[], yAxisID:'yr',
        borderColor:css('--gold'), backgroundColor:css('--gold'), borderWidth:1.5, pointRadius:0, tension:.05, spanGaps:true },
      { type:'line', label:'7d tone', measure:'delta', data:[], yAxisID:'ys',
        borderColor:css('--green'), backgroundColor:css('--green'), borderWidth:1.3, borderDash:[4,3],
        pointRadius:0, tension:.15, spanGaps:true },
    ]},
    options:{ responsive:true, maintainAspectRatio:false, animation:false,
      interaction:{mode:'index', intersect:false},
      scales:{ x:{...timeScale(), offset:false},
        y:{ position:'left', title:{display:true,text:'items / day'}, grid:{color:css('--border')} },
        yr:{ position:'right', title:{display:true,text:'price (100 = window start)'}, grid:{drawOnChartArea:false} },
        ys:{ display:false, min:-1, max:1 } },
      plugins:{ legend:{labels:{color:css('--ink'), boxWidth:12, boxHeight:2}},
        tooltip:{...tooltipStyle(), callbacks:{ label:(c)=>{
          if(c.dataset.yAxisID==='ys') return ' 7d tone: '+(c.parsed.y==null?'—':c.parsed.y.toFixed(3));
          if(c.dataset.yAxisID==='yr') return ' '+c.dataset.label+': '+(c.parsed.y==null?'—':c.parsed.y.toFixed(1))+
            (c.raw&&c.raw.raw!=null?' ($'+c.raw.raw.toFixed(2)+')':'');
          return ' '+c.dataset.label+': '+fmtN(c.parsed.y); }}}}},
    plugins:[interact, partialShade]
  });
  applyRange(RANGE, ANALOG_WIN);
}

function applyRange(range, analogWin){
  RANGE=range; ANALOG_WIN=analogWin||null;
  const min = analogWin ? analogWin[0] : rangeMin(range);
  const max = analogWin ? analogWin[1] : (DAILY.length?DAILY[DAILY.length-1].d:undefined);
  const rows = DAILY.filter(r=>(!min||r.d>=min)&&(!max||r.d<=max));
  const offset = DAILY.findIndex(r=>r.d===(rows[0]&&rows[0].d));
  mainChart.data.datasets[0].data = rows.map(r=>({x:r.d, y:r.p+r.c}));
  mainChart.data.datasets[3].data = rows.map((r,i)=>({x:r.d, y:SMOOTH[offset+i]}));
  for(const [i,key] of [[1,'u-u-to'],[2,'urnm']]){
    const s = PRICES && PRICES[key];
    mainChart.data.datasets[i].data = s ? indexed(s.rows, min, max) : [];
  }
  const unit = rows.length>500?'year':rows.length>120?'month':'week';
  const x = mainChart.options.scales.x;
  x.time.unit=unit; x.min=min; x.max=max;
  mainChart.update();
  document.querySelectorAll('#pills button').forEach(b=>
    b.classList.toggle('on', !analogWin && b.dataset.range===range));
  document.querySelectorAll('.kpi[data-range]').forEach(b=>
    b.classList.toggle('on', !analogWin && b.dataset.range===range));
  const an=$('kpi-analog'); if(an) an.classList.toggle('on', !!analogWin);
}

function buildTagChart(){
  if(tagChart){ const i=charts.indexOf(tagChart); if(i>=0)charts.splice(i,1); tagChart.destroy(); tagChart=null; }
  if(!openTag) return;
  const tag = TAGS.tags.find(t=>t.key===openTag); if(!tag) return;
  const rows = tagMode==='daily' ? tag.daily : tag.weekly;
  tagChart = new Chart($('tagchart'), {
    type:'bar',
    data:{ datasets:[
      { type:'bar', label:(tagMode==='daily'?'items / day':'items / week'), measure:'abs', yAxisID:'y',
        data:rows.map(r=>({x:r[0], y:r[1]})),
        backgroundColor:hexA(css('--gold'),.5), borderWidth:0, barPercentage:1, categoryPercentage:1 },
      { type:'line', label:'mean tone', measure:'delta', yAxisID:'ys',
        data:rows.map(r=>({x:r[0], y:r[2]})),
        borderColor:css('--green'), backgroundColor:css('--green'), borderWidth:1.3,
        pointRadius:0, tension:.15, spanGaps:true },
    ]},
    options:{ responsive:true, maintainAspectRatio:false, animation:false,
      interaction:{mode:'index', intersect:false},
      scales:{ x:{...timeScale(), offset:false,
          time:{unit:(tagMode==='daily'?'month':'year'), tooltipFormat:'yyyy-MM-dd'}},
        y:{ position:'left', grid:{color:css('--border')} },
        ys:{ position:'right', min:-1, max:1, grid:{drawOnChartArea:false},
             title:{display:true,text:'tone'} } },
      plugins:{ legend:{labels:{color:css('--ink'), boxWidth:12, boxHeight:2}},
        tooltip:{...tooltipStyle(), callbacks:{ label:(c)=>' '+c.dataset.label+': '+
          (c.dataset.yAxisID==='ys'?(c.parsed.y==null?'—':c.parsed.y.toFixed(3)):fmtN(c.parsed.y)) }}}},
    plugins:[interact, partialShade]
  });
}

// ---------- render ----------
function renderTicker(){
  const parts=[];
  for(const [key,label] of [['u-u-to','SPUT (U.U)'],['urnm','URNM']]){
    const s=PRICES&&PRICES[key];
    if(s&&s.rows.length>1){
      const [ , last]=s.rows[s.rows.length-1], prev=s.rows[s.rows.length-2][1];
      parts.push('<span><b>'+label+'</b> $'+last.toFixed(2)+' '+badge(last/prev-1)+'</span>');
    } else parts.push('<span><b>'+label+'</b> —</span>');
  }
  const g=SERIES.gauge;
  parts.push(g?'<span><b>GAUGE</b> '+sign(g.value)+' '+g.band.toUpperCase()+'</span>':'');
  parts.push('<span><b>VOL 7D</b> '+(g?fmtN(g.vol_7d):'—')+'/day</span>');
  $('ticker').innerHTML=parts.join('');
}
function renderToday(){
  const g=SERIES.gauge, asofRow = g && DAILY.find(r=>r.d===g.asof);
  $('today').innerHTML = '<span class="t-label">Today in ${title}</span>'
    + '<span class="item">as of <b>'+(g?g.asof:'—')+'</b></span>'
    + '<span class="item">items <b>'+(asofRow?fmtN(asofRow.p+asofRow.c):'—')+'</b></span>'
    + '<span class="item">authors <b>'+(asofRow?fmtN(asofRow.a):'—')+'</b></span>'
    + '<span class="item">7d tone <b>'+(g?sign(g.sent_7d,3):'—')+'</b></span>'
    + '<span class="item">band <b style="color:var(--gold)">'+(g?g.band.toUpperCase():'—')+'</b></span>';
}
function renderKpis(){
  const g=SERIES.gauge, vc=SERIES.volume_changes||{}, an=SERIES.analog;
  const cards=[];
  for(const p of ['1W','1M','3M','1Y']){
    const c=vc[p];
    cards.push('<button class="kpi" data-range="'+({'1W':'1M','1M':'1M','3M':'3M','1Y':'1Y'})[p]+'" data-period="'+p+'">'
      +'<div class="k">Volume '+p+'</div>'
      +'<div class="v">'+(c?fmtN(c.current):'—')+'<span style="font-size:11px;color:var(--muted)">/day</span></div>'
      +'<div class="s">'+(c?badge(c.delta)+' vs prior '+p.toLowerCase():'insufficient history')+'</div></button>');
  }
  cards.push('<button class="kpi" id="kpi-analog">'
    +'<div class="k">Feels like</div>'
    +'<div class="v" style="font-size:14px">'+(an?an.start+' → '+an.end:'—')+'</div>'
    +'<div class="s">'+(an?('<b style="color:var(--gold)">'+an.band.toUpperCase()+'</b> · similarity '+(an.similarity*100).toFixed(0)+'%'):'insufficient history')+'</div></button>');
  cards.push('<button class="kpi" id="kpi-gauge">'
    +'<div class="k">Gauge</div>'
    +'<div class="v '+(g?dirCls(g.value):'')+'">'+(g?sign(g.value):'—')+'</div>'
    +'<div class="s">'+(g?('vol z '+sign(g.volume_z)+' · tone z '+sign(g.sentiment_z)+' · pctile '+(g.vol_pctile_alltime*100).toFixed(0)+'%'):'—')+'</div></button>');
  $('kpis').innerHTML=cards.join('');
  document.querySelectorAll('.kpi[data-range]').forEach(b=>
    b.addEventListener('click',()=>applyRange(b.dataset.range,null)));
  const anBtn=$('kpi-analog');
  if(an) anBtn.addEventListener('click',()=>{
    if(ANALOG_WIN) applyRange('ALL',null);
    else { const pad=(d,n)=>{const t=new Date(d);t.setUTCDate(t.getUTCDate()+n);return t.toISOString().slice(0,10);};
      applyRange('ANALOG',[pad(an.start,-15),pad(an.end,15)]); }
  });
}
function renderGauge(){
  const g=SERIES.gauge;
  if(!g){ $('gband').textContent='insufficient history'; return; }
  const p=Math.max(0,Math.min(100,((g.value+3)/6)*100));
  const nd=$('needle'); nd.style.display='block'; nd.style.left=p.toFixed(2)+'%';
  $('nval').textContent=sign(g.value);
  $('gband').textContent=g.band.toUpperCase()+' · as of '+g.asof;
}
function tagCard(t){
  return '<button class="tagcard'+(openTag===t.key?' on':'')+'" data-tag="'+t.key+'">'
    +'<div class="k">'+t.key+'</div>'
    +'<div class="row"><span>7d items</span><b>'+fmtN(t.items_7d)+'</b></div>'
    +'<div class="row"><span>vs 90d</span><span>'+badge(t.delta_vs_90d)+'</span></div>'
    +'<div class="row"><span>7d tone</span><b class="'+dirCls(t.sent_7d)+'">'+(t.sent_7d==null?'—':sign(t.sent_7d,3))+'</b></div></button>';
}
function renderTags(){
  const active=TAGS.tags.filter(t=>t.items_7d>0), quiet=TAGS.tags.filter(t=>t.items_7d===0);
  $('taggrid').innerHTML=active.map(tagCard).join('');
  $('quietgrid').innerHTML=quiet.map(tagCard).join('');
  $('quietsum').textContent='Quiet tags ('+quiet.length+' with no items in 7d)';
  $('tagsub').textContent='Per-tag activity as of '+(TAGS.asof||'—')+' — click a tag for its chart';
  document.querySelectorAll('.tagcard').forEach(b=>b.addEventListener('click',()=>{
    openTag = openTag===b.dataset.tag ? null : b.dataset.tag;
    $('tagdetail').style.display = openTag ? 'block' : 'none';
    if(openTag){ const t=TAGS.tags.find(x=>x.key===openTag);
      $('tagtitle').textContent=openTag+' — '+fmtN(t.items_7d)+' items / 7d';
      buildTagChart(); $('tagdetail').scrollIntoView({behavior:'smooth',block:'nearest'}); }
    else buildTagChart();
    document.querySelectorAll('.tagcard').forEach(x=>x.classList.toggle('on',x.dataset.tag===openTag));
  }));
}
function renderStatus(st){
  $('livedot').className='dot'+(st.stale?' stale':'');
  const when = st.generated_at ? new Date(st.generated_at*1000).toISOString().slice(0,16).replace('T',' ')+'Z' : '—';
  $('freshness').textContent=(st.stale?'STALE — last derive ':'derive ')+when;
}

function buildAll(){
  chartDefaults();
  buildMainChart();
  buildTagChart();
}

async function boot(){
  const [series, tags, prices, status] = await Promise.all(
    ['/api/series','/api/tags','/api/prices','/api/status'].map(u=>fetch(u).then(r=>r.json()))
  );
  SERIES=series; TAGS=tags; PRICES=prices;
  DAILY=series.daily||[]; SMOOTH=smooth7(DAILY);
  renderTicker(); renderToday(); renderKpis(); renderGauge(); renderTags(); renderStatus(status);
  buildAll();
  document.querySelectorAll('#pills button').forEach(b=>
    b.addEventListener('click',()=>applyRange(b.dataset.range,null)));
  document.querySelectorAll('#tagpills button').forEach(b=>
    b.addEventListener('click',()=>{ tagMode=b.dataset.mode;
      document.querySelectorAll('#tagpills button').forEach(x=>x.classList.toggle('on',x===b));
      buildTagChart(); }));
  $('tagclose').addEventListener('click',()=>{ openTag=null; $('tagdetail').style.display='none';
    buildTagChart(); document.querySelectorAll('.tagcard').forEach(x=>x.classList.remove('on')); });
  $('themebtn').addEventListener('click',()=>{
    setTheme(document.documentElement.dataset.theme==='dark'?'light':'dark'); buildAll(); });
  setInterval(async()=>{ renderStatus(await fetch('/api/status').then(r=>r.json())); }, 300000);
}
boot().catch(e=>{ $('freshness').textContent='load failed — '+e.message; $('livedot').className='dot stale'; });
</script>
</body></html>`;
}
