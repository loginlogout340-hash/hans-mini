'use strict';
/** The pairing + payment page (one self-contained HTML string). */
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

module.exports = (botName) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#07110c">
<title>${esc(botName)} - Your own WhatsApp bot</title>
<style>
  :root { --bg:#07110c; --card:rgba(18,30,24,.82); --line:#24382e; --text:#ecf5ef; --mute:#8fa89a; --accent:#25d366; --accent2:#12a150; --bad:#ff6b6b; --gold:#ffd166; }
  * { box-sizing:border-box; }
  html { -webkit-text-size-adjust:100%; }
  body { margin:0; min-height:100vh; color:var(--text); font:16px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
         background:radial-gradient(900px 500px at 85% -10%, rgba(37,211,102,.20), transparent 60%),
                    radial-gradient(700px 500px at -10% 110%, rgba(18,161,80,.18), transparent 60%), var(--bg); }
  .wrap { max-width:460px; margin:0 auto; padding:28px 16px 40px; }
  .hero { text-align:center; margin-bottom:22px; }
  .logo { width:68px; height:68px; margin:0 auto 14px; border-radius:20px; display:grid; place-items:center; font-size:32px; font-weight:800; color:#04210f;
          background:linear-gradient(135deg,#5bf09a,#1fb85a); box-shadow:0 10px 34px rgba(37,211,102,.35); }
  h1 { margin:0; font-size:28px; letter-spacing:-.5px; }
  .tag { margin:6px 0 0; color:var(--mute); font-size:15px; }
  .chips { display:flex; flex-wrap:wrap; justify-content:center; gap:8px; margin:16px 0 0; }
  .chip { padding:5px 11px; font-size:12.5px; border:1px solid var(--line); border-radius:99px; background:rgba(255,255,255,.03); color:#cfe6d8; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:20px; padding:20px; backdrop-filter:blur(8px); }
  .tabs { display:grid; grid-template-columns:1fr 1fr; gap:6px; padding:5px; margin-bottom:6px; background:rgba(0,0,0,.28); border-radius:13px; }
  .tabs.one { grid-template-columns:1fr; }
  .tab { margin:0; padding:10px 6px; font-size:14px; font-weight:600; color:var(--mute); background:transparent; border:0; border-radius:9px; cursor:pointer; }
  .tab.on { color:#04210f; background:var(--accent); }
  label { display:block; margin:14px 0 6px; font-size:13px; color:var(--mute); }
  input { width:100%; padding:13px 14px; font-size:16px; color:var(--text); background:#0a1510; border:1px solid var(--line); border-radius:12px; outline:none; }
  input:focus { border-color:var(--accent); box-shadow:0 0 0 3px rgba(37,211,102,.15); }
  button.main { width:100%; margin-top:18px; padding:14px; font-size:16px; font-weight:700; color:#04210f; border:0; border-radius:12px; cursor:pointer;
                background:linear-gradient(135deg,#43e883,#1fb85a); box-shadow:0 8px 22px rgba(37,211,102,.25); }
  button:disabled { opacity:.55; cursor:default; }
  .ghost { width:100%; margin-top:10px; padding:12px; font-size:15px; color:var(--text); background:transparent; border:1px solid var(--line); border-radius:12px; cursor:pointer; }
  .err { margin-top:14px; color:var(--bad); font-size:14px; min-height:1em; }
  .ok-note { margin-top:14px; padding:11px 13px; font-size:14px; color:#b9f5cf; background:rgba(37,211,102,.10); border:1px solid rgba(37,211,102,.35); border-radius:12px; }
  .price { display:flex; align-items:baseline; justify-content:center; gap:8px; margin:12px 0 2px; }
  .price b { font-size:38px; letter-spacing:-1px; color:var(--gold); }
  .price span { color:var(--mute); font-size:14px; }
  .hint { text-align:center; margin:0 0 4px; color:var(--mute); font-size:13px; }
  .hide { display:none !important; }
  .code { margin:8px 0 4px; text-align:center; font:700 36px/1.2 ui-monospace,Menlo,Consolas,monospace; letter-spacing:3px; color:#eafff2; }
  ol.steps { margin:16px 0 0; padding:0; list-style:none; counter-reset:s; }
  ol.steps li { counter-increment:s; position:relative; margin:9px 0; padding-left:36px; color:#cfe0d6; font-size:14.5px; }
  ol.steps li::before { content:counter(s); position:absolute; left:0; top:0; width:24px; height:24px; border-radius:50%; display:grid; place-items:center; font-size:12px; font-weight:700; color:#04210f; background:var(--accent); }
  .status { margin-top:16px; padding:12px; border:1px solid var(--line); border-radius:12px; font-size:14px; text-align:center; color:var(--mute); }
  .status.ok { border-color:var(--accent); color:var(--accent); }
  .feat { margin-top:20px; display:grid; grid-template-columns:1fr 1fr; gap:10px; }
  .feat div { padding:12px; border:1px solid var(--line); border-radius:14px; background:rgba(255,255,255,.025); font-size:13.5px; color:#cfe0d6; }
  .feat b { display:block; margin-bottom:2px; color:var(--text); font-size:14px; }
  .tut { display:block; margin-top:16px; text-align:center; padding:12px; border:1px dashed #2f4a3b; border-radius:12px; color:#bfe9cf; text-decoration:none; font-size:14.5px; }
  .foot { margin-top:22px; text-align:center; font-size:12.5px; color:var(--mute); }
  .foot b { color:#cfe0d6; }
</style>
</head>
<body>
<div class="wrap">
  <div class="hero">
    <div class="logo">${esc(botName).charAt(0)}</div>
    <h1>${esc(botName)}</h1>
    <p class="tag">Your own WhatsApp bot. Link your number in 2 minutes.</p>
    <div class="chips"><span class="chip">100+ commands</span><span class="chip">AI chat</span><span class="chip">Music</span><span class="chip">Group tools</span><span class="chip">Online 24/7</span></div>
  </div>

  <div class="card">
    <div id="tabs" class="tabs hide">
      <button class="tab on" id="tPay" type="button">Pay and join</button>
      <button class="tab" id="tCode" type="button">I have a code</button>
    </div>

    <form id="form" autocomplete="off">
      <div id="payInfo" class="hide">
        <div class="price"><b id="price">GH₵20</b><span id="per">for 1 month</span></div>
        <p class="hint">Pay with Mobile Money or card. Your access code arrives right after.</p>
      </div>

      <label for="number">Your WhatsApp number (with country code)</label>
      <input id="number" inputmode="numeric" placeholder="233241234567" required>

      <div id="emailBox" class="hide">
        <label for="email">Email (optional, for your receipt)</label>
        <input id="email" type="email" placeholder="you@example.com">
      </div>

      <div id="accessBox" class="hide">
        <label for="access">Access code</label>
        <input id="access" autocapitalize="characters" placeholder="Your access code" autocomplete="off">
      </div>

      <button id="go" class="main" type="submit">Get pairing code</button>
      <div id="note" class="ok-note hide"></div>
      <div id="err" class="err" role="alert"></div>
    </form>

    <div id="result" class="hide">
      <label>Your pairing code</label>
      <div id="code" class="code"></div>
      <button id="copy" class="ghost" type="button">Copy code</button>
      <ol class="steps">
        <li>Open WhatsApp on your phone</li>
        <li>Tap Settings, then Linked devices, then Link a device</li>
        <li>Choose <b>Link with phone number instead</b></li>
        <li>Type the code above</li>
      </ol>
      <div id="status" class="status">Waiting for you to enter the code...</div>
      <button id="again" class="ghost hide" type="button">Start again</button>
    </div>
  </div>

  <a id="tut" class="tut hide" target="_blank" rel="noopener">▶ Watch the tutorial video</a>

  <div class="feat">
    <div><b>Status tools</b>Auto view and like statuses, save them.</div>
    <div><b>Anti-delete</b>See messages people delete.</div>
    <div><b>Group guard</b>Anti-tag, anti-link, welcome messages.</div>
    <div><b>AI and music</b>Ask AI, make pictures, play songs.</div>
  </div>

  <div class="foot">Your bot runs only on your number. Send <b>.unlink</b> in WhatsApp any time to remove it.</div>
</div>

<script>
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var form = $('form'), err = $('err'), go = $('go'), result = $('result'), statusEl = $('status'), note = $('note');
  var timer = null, number = '', info = { restricted: false, payments: false }, mode = 'code';

  function store(k, v) { try { if (v == null) return sessionStorage.getItem(k); sessionStorage.setItem(k, v); } catch (e) { return null; } }
  function showError(m) { err.textContent = m || ''; }
  function post(url, body) {
    return fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); });
  }

  /* which tab is showing */
  function setMode(m) {
    mode = m;
    $('tPay').className = 'tab' + (m === 'pay' ? ' on' : '');
    $('tCode').className = 'tab' + (m === 'code' ? ' on' : '');
    $('payInfo').className = m === 'pay' ? '' : 'hide';
    $('emailBox').className = m === 'pay' ? '' : 'hide';
    $('accessBox').className = (m === 'code' && info.restricted) ? '' : 'hide';
    go.textContent = m === 'pay' ? 'Pay with Paystack' : 'Get pairing code';
    showError('');
  }
  $('tPay').addEventListener('click', function () { setMode('pay'); });
  $('tCode').addEventListener('click', function () { setMode('code'); });

  function reset() {
    clearInterval(timer);
    result.className = 'hide'; form.className = '';
    go.disabled = false; setMode(mode);
    $('again').className = 'ghost hide';
    statusEl.className = 'status'; statusEl.textContent = 'Waiting for you to enter the code...';
  }

  /* page info */
  fetch('/api/info').then(function (r) { return r.json(); }).then(function (j) {
    info = j;
    $('price').textContent = 'GH₵' + j.price;
    $('per').textContent = 'for ' + (j.days === 30 ? '1 month' : j.days + ' days');
    if (j.tutorial) { $('tut').href = j.tutorial; $('tut').className = 'tut'; }
    if (j.payments) {
      $('tabs').className = 'tabs';
      setMode('pay');
    } else {
      $('tabs').className = 'tabs hide';
      setMode('code');
    }
    checkReturn();
  }).catch(function () { setMode('code'); });

  /* coming back from Paystack: ?reference=... */
  function checkReturn() {
    var q = new URLSearchParams(location.search);
    var ref = q.get('reference') || q.get('ref') || q.get('trxref');
    if (!ref) return;
    history.replaceState(null, '', location.pathname);
    setMode('code');
    note.className = 'ok-note'; note.textContent = 'Checking your payment...';
    fetch('/api/pay/verify?ref=' + encodeURIComponent(ref)).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (x) {
        if (!x.ok) { note.className = 'ok-note hide'; showError(x.j.error || 'We could not confirm the payment yet. Wait a minute and refresh this page.'); return; }
        $('number').value = x.j.number;
        $('access').value = x.j.code;
        $('accessBox').className = '';
        var until = new Date(x.j.expiresAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
        note.textContent = 'Payment received! Your access code ' + x.j.code + ' is filled in (valid until ' + until + '). Tap the button to get your pairing code. Save the code somewhere safe.';
      }).catch(function () { note.className = 'ok-note hide'; showError('Could not reach the server. Refresh this page.'); });
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    showError('');
    go.disabled = true;
    var label = go.textContent;
    if (mode === 'pay') {
      go.textContent = 'Opening Paystack...';
      post('/api/pay/start', { number: $('number').value, email: $('email').value }).then(function (x) {
        if (!x.ok) { showError(x.j.error || 'Something went wrong.'); go.disabled = false; go.textContent = label; return; }
        store('hm_number', $('number').value);
        location.href = x.j.url;
      }).catch(function () { showError('Could not reach the server. Check your connection.'); go.disabled = false; go.textContent = label; });
      return;
    }
    go.textContent = 'Getting your code...';
    post('/api/pair', { number: $('number').value, access: $('access').value }).then(function (x) {
      if (!x.ok) { showError(x.j.error || 'Something went wrong.'); go.disabled = false; go.textContent = label; return; }
      number = x.j.number;
      $('code').textContent = x.j.code;
      form.className = 'hide'; result.className = '';
      poll();
    }).catch(function () { showError('Could not reach the server. Check your connection.'); go.disabled = false; go.textContent = label; });
  });

  function poll() {
    var tries = 0;
    clearInterval(timer);
    timer = setInterval(function () {
      tries++;
      fetch('/api/status?number=' + encodeURIComponent(number)).then(function (r) { return r.json(); }).then(function (j) {
        if (j.state === 'connected') {
          clearInterval(timer);
          statusEl.className = 'status ok';
          statusEl.textContent = 'Connected! Open a chat with yourself on WhatsApp and send .menu';
        } else if (j.state === 'none' || tries > 100) {
          clearInterval(timer);
          statusEl.textContent = 'This code has expired.';
          $('again').className = 'ghost';
        }
      }).catch(function () { /* keep trying */ });
    }, 3000);
  }

  $('copy').addEventListener('click', function () {
    var t = $('code').textContent;
    if (navigator.clipboard) navigator.clipboard.writeText(t.replace('-', '')).then(function () { $('copy').textContent = 'Copied'; });
  });
  $('again').addEventListener('click', reset);

  var saved = store('hm_number');
  if (saved) $('number').value = saved;
})();
</script>
</body>
</html>`;
