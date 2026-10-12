'use strict';
/** The pairing page (one self-contained HTML string). */
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

module.exports = (botName, codeRequired) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(botName)} - Link your WhatsApp</title>
<style>
  :root { --bg:#0d1117; --card:#161b22; --line:#30363d; --text:#e6edf3; --mute:#8b949e; --accent:#25d366; --bad:#f85149; }
  * { box-sizing: border-box; }
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center; padding:16px;
         background:var(--bg); color:var(--text); font:16px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif; }
  .card { width:100%; max-width:420px; background:var(--card); border:1px solid var(--line); border-radius:16px; padding:24px; }
  h1 { margin:0 0 4px; font-size:22px; }
  p.sub { margin:0 0 20px; color:var(--mute); font-size:14px; }
  label { display:block; margin:14px 0 6px; font-size:13px; color:var(--mute); }
  input { width:100%; padding:12px 14px; font-size:16px; color:var(--text); background:var(--bg);
          border:1px solid var(--line); border-radius:10px; outline:none; }
  input:focus { border-color:var(--accent); }
  button { width:100%; margin-top:18px; padding:13px; font-size:16px; font-weight:600; color:#04210f;
           background:var(--accent); border:0; border-radius:10px; cursor:pointer; }
  button:disabled { opacity:.55; cursor:default; }
  .err { margin-top:14px; color:var(--bad); font-size:14px; min-height:1em; }
  .hide { display:none; }
  .code { margin:8px 0 4px; text-align:center; font:700 34px/1.2 ui-monospace,Menlo,Consolas,monospace; letter-spacing:3px; }
  .ghost { background:transparent; color:var(--text); border:1px solid var(--line); margin-top:10px; }
  ol { margin:16px 0 0; padding-left:20px; color:var(--mute); font-size:14px; }
  ol li { margin:6px 0; }
  .status { margin-top:16px; padding:12px; border:1px solid var(--line); border-radius:10px; font-size:14px; text-align:center; color:var(--mute); }
  .status.ok { border-color:var(--accent); color:var(--accent); }
  .foot { margin-top:18px; text-align:center; font-size:12px; color:var(--mute); }
</style>
</head>
<body>
<div class="card">
  <h1>${esc(botName)}</h1>
  <p class="sub">Link your WhatsApp to get your own bot. No setup needed.</p>

  <form id="form" autocomplete="off">
    <label for="number">Your WhatsApp number (with country code)</label>
    <input id="number" inputmode="numeric" placeholder="233241234567" required>
    <div id="accessBox" class="${codeRequired ? '' : 'hide'}">
      <label for="access">Access code</label>
      <input id="access" type="password" placeholder="Ask the bot owner for a code"${codeRequired ? ' required' : ''}>
    </div>
    <button id="go" type="submit">Get pairing code</button>
    <div id="err" class="err" role="alert"></div>
  </form>

  <div id="result" class="hide">
    <label>Your pairing code</label>
    <div id="code" class="code"></div>
    <button id="copy" class="ghost" type="button">Copy code</button>
    <ol>
      <li>Open WhatsApp on your phone</li>
      <li>Tap Settings, then Linked devices, then Link a device</li>
      <li>Choose <b>Link with phone number instead</b></li>
      <li>Type the code above</li>
    </ol>
    <div id="status" class="status">Waiting for you to enter the code...</div>
    <button id="again" class="ghost hide" type="button">Start again</button>
  </div>

  <div class="foot">Your bot runs only on your number. Send <b>.unlink</b> in WhatsApp any time to remove it.</div>
</div>

<script>
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var form = $('form'), err = $('err'), go = $('go'), result = $('result'), statusEl = $('status');
  var timer = null, number = '';

  function showError(m) { err.textContent = m || ''; }
  function reset() {
    clearInterval(timer);
    result.className = 'hide'; form.className = '';
    go.disabled = false; go.textContent = 'Get pairing code';
    $('again').className = 'ghost hide';
    statusEl.className = 'status'; statusEl.textContent = 'Waiting for you to enter the code...';
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    showError('');
    go.disabled = true; go.textContent = 'Getting your code...';
    fetch('/api/pair', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ number: $('number').value, access: $('access').value })
    }).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (x) {
        if (!x.ok) { showError(x.j.error || 'Something went wrong.'); go.disabled = false; go.textContent = 'Get pairing code'; return; }
        number = x.j.number;
        $('code').textContent = x.j.code;
        form.className = 'hide'; result.className = '';
        poll();
      })
      .catch(function () { showError('Could not reach the server. Check your connection.'); go.disabled = false; go.textContent = 'Get pairing code'; });
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
})();
</script>
</body>
</html>`;
