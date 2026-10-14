'use strict';
/** The Hans Pulse dashboard page (one self-contained HTML string). Data comes from /api/pulse/<token>. */
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

module.exports = (botName) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#07110c">
<meta name="robots" content="noindex">
<title>${esc(botName)} Pulse</title>
<style>
  :root { --bg:#07110c; --card:rgba(18,30,24,.86); --line:#24382e; --text:#ecf5ef; --mute:#8fa89a; --accent:#25d366; --accent2:#7be3a6; --gold:#ffd166; --bad:#ff6b6b; color-scheme:dark; }
  * { box-sizing:border-box; }
  body { margin:0; min-height:100vh; color:var(--text); font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
         background:radial-gradient(900px 480px at 90% -10%, rgba(37,211,102,.18), transparent 60%), radial-gradient(700px 480px at -10% 105%, rgba(18,161,80,.16), transparent 60%), var(--bg); }
  .wrap { max-width:760px; margin:0 auto; padding:22px 16px 48px; display:flex; flex-direction:column; gap:14px; }
  header { display:flex; align-items:center; gap:12px; }
  .logo { width:46px; height:46px; border-radius:14px; display:grid; place-items:center; font-weight:800; font-size:22px; color:#04210f; background:linear-gradient(135deg,#5bf09a,#1fb85a); flex:none; }
  h1 { margin:0; font-size:21px; letter-spacing:-.3px; }
  .sub { color:var(--mute); font-size:13px; }
  .live { margin-left:auto; display:flex; align-items:center; gap:6px; font-size:12.5px; color:var(--mute); white-space:nowrap; }
  .dot { width:8px; height:8px; border-radius:50%; background:var(--accent); box-shadow:0 0 0 0 rgba(37,211,102,.6); animation:pulse 1.8s infinite; }
  @keyframes pulse { 70% { box-shadow:0 0 0 8px rgba(37,211,102,0); } 100% { box-shadow:0 0 0 0 rgba(37,211,102,0); } }
  @media (prefers-reduced-motion: reduce) { .dot { animation:none; } }
  .card { background:var(--card); border:1px solid var(--line); border-radius:18px; padding:16px; }
  h2 { margin:0 0 10px; font-size:13px; font-weight:600; letter-spacing:.06em; text-transform:uppercase; color:var(--mute); }
  .tiles { display:grid; grid-template-columns:repeat(2,1fr); gap:10px; }
  @media (min-width:600px) { .tiles { grid-template-columns:repeat(4,1fr); } }
  .tile { padding:14px; border:1px solid var(--line); border-radius:14px; background:rgba(255,255,255,.025); min-width:0; }
  .tile b { display:block; font-size:28px; line-height:1.1; letter-spacing:-.5px; font-variant-numeric:tabular-nums; }
  .tile span { color:var(--mute); font-size:12.5px; }
  .small { display:flex; flex-wrap:wrap; gap:8px; margin-top:10px; }
  .pill { padding:5px 10px; border:1px solid var(--line); border-radius:99px; font-size:12.5px; color:#cfe0d6; }
  .pill b { color:var(--text); font-variant-numeric:tabular-nums; }
  .chart { width:100%; overflow-x:auto; }
  svg { display:block; width:100%; height:auto; }
  .legend { display:flex; gap:14px; margin-top:6px; font-size:12.5px; color:var(--mute); }
  .legend i { display:inline-block; width:10px; height:10px; border-radius:3px; margin-right:6px; vertical-align:-1px; }
  .row { display:grid; grid-template-columns:90px 1fr 36px; align-items:center; gap:10px; margin:7px 0; font-size:14px; }
  .row .nm { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .row .bar { height:9px; border-radius:6px; background:#0d1a13; overflow:hidden; }
  .row .bar i { display:block; height:100%; border-radius:6px; background:linear-gradient(90deg,#1fb85a,#5bf09a); }
  .row .ct { text-align:right; color:var(--mute); font-variant-numeric:tabular-nums; }
  .hours { display:grid; grid-template-columns:repeat(24,1fr); gap:3px; align-items:end; height:64px; }
  .hours i { display:block; background:var(--accent); border-radius:3px 3px 0 0; min-height:3px; opacity:.85; }
  .axis { display:flex; justify-content:space-between; margin-top:4px; font-size:11.5px; color:var(--mute); }
  .empty { color:var(--mute); font-size:14px; }
  .pin { margin:0 0 10px; padding:10px 12px; border:1px dashed #3a5a47; border-radius:12px; font-size:14px; color:#d6efdf; }
  .feed { max-height:300px; overflow-y:auto; display:flex; flex-direction:column; gap:8px; padding-right:4px; }
  .msg { font-size:14px; word-wrap:anywhere; }
  .msg .who { font-weight:700; }
  .msg .who.admin { color:var(--gold); }
  .msg .tm { color:var(--mute); font-size:11.5px; margin-left:6px; }
  .msg.ann { padding:8px 10px; border-radius:10px; background:rgba(255,209,102,.08); border:1px solid rgba(255,209,102,.3); }
  form.line { display:flex; gap:8px; margin-top:12px; }
  input { flex:1; min-width:0; padding:12px 13px; font-size:15px; color:var(--text); background:#0a1510; border:1px solid var(--line); border-radius:12px; outline:none; }
  input:focus { border-color:var(--accent); box-shadow:0 0 0 3px rgba(37,211,102,.15); }
  button { padding:12px 16px; font-size:15px; font-weight:700; color:#04210f; background:linear-gradient(135deg,#43e883,#1fb85a); border:0; border-radius:12px; cursor:pointer; }
  button.ghost { color:var(--mute); background:transparent; border:1px solid var(--line); font-weight:500; padding:8px 12px; font-size:13px; }
  button:disabled { opacity:.55; cursor:default; }
  .err { margin-top:8px; min-height:1em; font-size:13.5px; color:var(--bad); }
  details { margin-top:10px; color:var(--mute); font-size:13.5px; }
  details pre { white-space:pre-wrap; font:inherit; margin:8px 0 0; color:#cfe0d6; }
  .foot { text-align:center; font-size:12px; color:var(--mute); }
  .fatal { margin:60px auto; max-width:420px; text-align:center; color:var(--mute); }
</style>
</head>
<body>
<div class="wrap" id="app">
  <div class="fatal" id="loading">Loading your Pulse...</div>
</div>

<script>
(function () {
  var token = location.pathname.split('/').pop();
  var base = '/api/pulse/' + encodeURIComponent(token);
  var app = document.getElementById('app');
  var D = null, built = false;

  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function fmt(n) { return Number(n || 0).toLocaleString('en-US'); }
  function ago(t) {
    if (!t) return 'no activity yet';
    var s = Math.max(0, Math.floor((Date.now() - t) / 1000));
    if (s < 60) return 'just now';
    if (s < 3600) return Math.floor(s / 60) + ' min ago';
    if (s < 86400) return Math.floor(s / 3600) + ' h ago';
    return Math.floor(s / 86400) + ' d ago';
  }
  function hhmm(t) { var d = new Date(t); return ('0' + d.getUTCHours()).slice(-2) + ':' + ('0' + d.getUTCMinutes()).slice(-2); }
  function api(path, body) {
    return fetch(base + (path || ''), body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : undefined)
      .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || 'Something went wrong.'); return j; }); });
  }

  function tile(num, label) { var t = el('div', 'tile'); t.appendChild(el('b', '', fmt(num))); t.appendChild(el('span', '', label)); return t; }
  function pill(label, num) { var p = el('div', 'pill'); p.appendChild(document.createTextNode(label + ' ')); p.appendChild(el('b', '', fmt(num))); return p; }
  function card(title) { var c = el('section', 'card'); if (title) c.appendChild(el('h2', '', title)); return c; }

  function chart(days) {
    var W = 560, H = 170, pl = 30, pr = 6, pt = 8, pb = 22, n = days.length;
    var mx = Math.max(4, Math.max.apply(null, days.map(function (d) { return Math.max(d.cmd, d.msg); })));
    var ns = 'http://www.w3.org/2000/svg';
    var s = document.createElementNS(ns, 'svg'); s.setAttribute('viewBox', '0 0 ' + W + ' ' + H); s.setAttribute('role', 'img'); s.setAttribute('aria-label', 'Commands and messages for the last 14 days');
    function node(name, attrs, text) { var e = document.createElementNS(ns, name); for (var k in attrs) e.setAttribute(k, attrs[k]); if (text != null) e.textContent = text; s.appendChild(e); return e; }
    var gw = (W - pl - pr) / n, bw = Math.min(14, gw / 2 - 2);
    [0, 0.5, 1].forEach(function (f) {
      var y = pt + (H - pt - pb) * (1 - f);
      node('line', { x1: pl, x2: W - pr, y1: y, y2: y, stroke: '#24382e', 'stroke-width': 1 });
      node('text', { x: pl - 6, y: y + 4, 'text-anchor': 'end', fill: '#8fa89a', 'font-size': 11 }, String(Math.round(mx * f)));
    });
    days.forEach(function (d, i) {
      var cx = pl + gw * i + gw / 2;
      [[d.msg, '#2f6f4c', -bw - 1], [d.cmd, '#25d366', 1]].forEach(function (b) {
        var h = (H - pt - pb) * (b[0] / mx);
        node('rect', { x: cx + b[2], y: H - pb - h, width: bw, height: Math.max(h, b[0] ? 2 : 0), rx: 3, fill: b[1] });
      });
      if (i % 2 === n % 2 || n < 8) node('text', { x: cx, y: H - 6, 'text-anchor': 'middle', fill: '#8fa89a', 'font-size': 10.5 }, d.d);
    });
    return s;
  }

  function bars(list) {
    var box = el('div');
    if (!list.length) { box.appendChild(el('div', 'empty', 'No commands yet. Send .menu to your bot and try one.')); return box; }
    var mx = list[0][1];
    list.forEach(function (it) {
      var r = el('div', 'row'); r.appendChild(el('div', 'nm', '.' + it[0]));
      var b = el('div', 'bar'), i = el('i'); i.style.width = Math.max(4, Math.round(100 * it[1] / mx)) + '%'; b.appendChild(i); r.appendChild(b);
      r.appendChild(el('div', 'ct', fmt(it[1]))); box.appendChild(r);
    });
    return box;
  }

  function hours(h) {
    var wrap = el('div'), g = el('div', 'hours'), mx = Math.max(1, Math.max.apply(null, h));
    h.forEach(function (v, i) { var b = el('i'); b.style.height = Math.max(5, Math.round(100 * v / mx)) + '%'; b.title = i + ':00 UTC, ' + v; if (!v) b.style.opacity = '.25'; g.appendChild(b); });
    wrap.appendChild(g);
    var ax = el('div', 'axis'); ['00', '06', '12', '18', '23'].forEach(function (x) { ax.appendChild(el('span', '', x + 'h')); });
    wrap.appendChild(ax);
    return wrap;
  }

  function build() {
    app.textContent = '';
    var t = D.totals || {};
    var hd = el('header'); hd.appendChild(el('div', 'logo', D.name.charAt(0)));
    var hbox = el('div'); hbox.appendChild(el('h1', '', D.name + ' Pulse')); hbox.appendChild(el('div', 'sub', D.number)); hd.appendChild(hbox);
    var lv = el('div', 'live'); lv.appendChild(el('span', 'dot')); lv.appendChild(el('span', '', '')); lv.id = 'lastSeen'; hd.appendChild(lv);
    app.appendChild(hd);

    var c1 = card(); var tl = el('div', 'tiles');
    tl.appendChild(tile(t.cmd, 'Commands run')); tl.appendChild(tile(t.msg, 'Messages seen'));
    tl.appendChild(tile(t.deleted, 'Deleted messages spotted')); tl.appendChild(tile(t.status, 'Statuses seen'));
    c1.appendChild(tl);
    var sm = el('div', 'small');
    sm.appendChild(pill('View-once', t.viewonce)); sm.appendChild(pill('Media', t.media)); sm.appendChild(pill('Calls blocked', t.calls));
    sm.appendChild(pill('Guard actions', t.guard)); sm.appendChild(pill('Community posts', t.comm));
    c1.appendChild(sm); app.appendChild(c1);

    var c2 = card('Last 14 days'); var ch = el('div', 'chart'); ch.appendChild(chart(D.days)); c2.appendChild(ch);
    var lg = el('div', 'legend'); var a = el('span'); var ia = el('i'); ia.style.background = '#25d366'; a.appendChild(ia); a.appendChild(document.createTextNode('Commands'));
    var b = el('span'); var ib = el('i'); ib.style.background = '#2f6f4c'; b.appendChild(ib); b.appendChild(document.createTextNode('Messages')); lg.appendChild(a); lg.appendChild(b); c2.appendChild(lg); app.appendChild(c2);

    var c3 = card('Top commands'); c3.appendChild(bars(D.top)); app.appendChild(c3);
    var c4 = card('Busiest hours (UTC)'); c4.appendChild(hours(D.hours)); app.appendChild(c4);

    var c5 = card('Community'); c5.id = 'comm'; app.appendChild(c5);
    app.appendChild(el('div', 'foot', 'Counts start from the day you linked the bot. Keep this link private.'));
    built = true;
  }

  function renderComm() {
    var c = D.community, box = document.getElementById('comm');
    if (!box) return;
    var keep = document.getElementById('cin') ? document.getElementById('cin').value : '';
    var focus = document.activeElement && document.activeElement.id;
    box.textContent = '';
    box.appendChild(el('h2', '', 'Community  ·  ' + c.members + ' member' + (c.members === 1 ? '' : 's') + (c.open ? '' : '  ·  closed')));
    if (c.pinned) box.appendChild(el('div', 'pin', '📌 ' + c.pinned));
    var feed = el('div', 'feed'); feed.id = 'feed';
    if (!c.feed.length) feed.appendChild(el('div', 'empty', 'No messages yet. Say hello!'));
    c.feed.forEach(function (m) {
      var d = el('div', 'msg' + (m.ann ? ' ann' : '')); var w = el('span', 'who' + (m.admin ? ' admin' : ''), (m.admin ? '👑 ' : '') + m.nick);
      d.appendChild(w); d.appendChild(el('span', 'tm', hhmm(m.t) + ' UTC')); d.appendChild(el('div', '', m.text)); feed.appendChild(d);
    });
    box.appendChild(feed); feed.scrollTop = feed.scrollHeight;
    var err = el('div', 'err'); err.setAttribute('role', 'alert');
    if (c.banned) { box.appendChild(el('div', 'empty', 'You cannot join the community.')); return; }
    if (c.member || c.admin) {
      var f = el('form', 'line'); var inp = el('input'); inp.id = 'cin'; inp.maxLength = 400; inp.placeholder = (c.admin ? 'Post as admin' : 'Message as ' + c.nick) + '...'; inp.autocomplete = 'off'; inp.value = keep;
      var bt = el('button', '', 'Send'); bt.type = 'submit'; f.appendChild(inp); f.appendChild(bt); box.appendChild(f);
      f.addEventListener('submit', function (e) {
        e.preventDefault(); bt.disabled = true; err.textContent = '';
        api('/say', { text: inp.value }).then(function () { inp.value = ''; refresh(); }).catch(function (x) { err.textContent = x.message; }).then(function () { bt.disabled = false; });
      });
      if (focus === 'cin') inp.focus();
      if (!c.admin) { var lv = el('button', 'ghost', 'Leave community'); lv.type = 'button'; lv.style.marginTop = '10px'; lv.addEventListener('click', function () { api('/leave', {}).then(refresh).catch(function (x) { err.textContent = x.message; }); }); box.appendChild(lv); }
    } else if (c.open) {
      var f2 = el('form', 'line'); var ni = el('input'); ni.id = 'nick'; ni.maxLength = 20; ni.placeholder = 'Choose a nickname to join'; ni.autocomplete = 'off';
      var jb = el('button', '', 'Join'); jb.type = 'submit'; f2.appendChild(ni); f2.appendChild(jb); box.appendChild(f2);
      f2.addEventListener('submit', function (e) {
        e.preventDefault(); jb.disabled = true; err.textContent = '';
        api('/join', { nick: ni.value }).then(refresh).catch(function (x) { err.textContent = x.message; }).then(function () { jb.disabled = false; });
      });
      box.appendChild(el('div', 'sub', 'Other members only see your nickname, never your number.'));
    }
    box.appendChild(err);
    var dt = el('details'); dt.appendChild(el('summary', '', 'Community rules')); dt.appendChild(el('pre', '', c.rules)); box.appendChild(dt);
  }

  function refresh() {
    return api('').then(function (d) {
      D = d; if (!built) build(); renderComm();
      var ls = document.getElementById('lastSeen'); if (ls) ls.lastChild.textContent = 'Last activity ' + ago(D.last);
    }).catch(function (e) {
      if (!built) { app.textContent = ''; var f = el('div', 'fatal', e.message); app.appendChild(f); }
    });
  }
  refresh();
  setInterval(function () { if (!document.hidden) refresh(); }, 20000);
})();
</script>
</body>
</html>`;
