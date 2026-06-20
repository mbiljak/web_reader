const btnPlay  = document.getElementById('btn-play');
const btnPause = document.getElementById('btn-pause');
const btnStop  = document.getElementById('btn-stop');
const speedEl  = document.getElementById('speed');
const speedVal = document.getElementById('speed-value');
const voiceEl  = document.getElementById('voice');
const rsvpEl   = document.getElementById('rsvp');

// macOS novelty / joke voices to hide
const NOVELTY = new Set([
  'Albert', 'Bad News', 'Bahh', 'Bells', 'Boing', 'Bubbles', 'Cellos',
  'Good News', 'Jester', 'Organ', 'Superstar', 'Trinoids', 'Whisper',
  'Wobble', 'Zarvox', 'Junior', 'Ralph', 'Fred', 'Kathy', 'Princess',
  'Deranged', 'Hysterical', 'Pipe Organ', 'Grandma', 'Grandpa', 'Rocko',
  'Shelley', 'Sandy', 'Flo', 'Eddy', 'Reed'
]);
const ALLOWED = ['en-GB', 'en-US', 'en_GB', 'en_US'];

function isAllowedVoice(v) {
  const lang = v.lang.replace('_', '-');
  if (!ALLOWED.includes(lang)) return false;
  const base = v.name.replace(/\s*\(.*\)\s*$/, '').trim();
  return !NOVELTY.has(base);
}

// ---------- Tab helpers ----------
function withTab(fn) {
  return browser.tabs.query({ active: true, currentWindow: true }).then((tabs) => {
    if (tabs[0]) return fn(tabs[0].id);
  });
}
function send(msg) {
  return withTab((id) => browser.tabs.sendMessage(id, msg));
}

// ---------- Preferences ----------
let prefVoice = null;
browser.storage.local.get(['wr_rate', 'wr_voice', 'wr_rsvp']).then((p) => {
  if (p.wr_rate)  speedEl.value = p.wr_rate;
  if (p.wr_rsvp === '1') rsvpEl.checked = true;
  prefVoice = p.wr_voice || null;
  speedVal.textContent = parseFloat(speedEl.value).toFixed(1) + '×';
  if (prefVoice && voiceEl.querySelector(`option[value="${CSS.escape(prefVoice)}"]`)) {
    voiceEl.value = prefVoice;
  }
});

// ---------- Populate voices ----------
function fillVoices(voices) {
  voices = voices.filter(isAllowedVoice);
  voiceEl.innerHTML = '';
  const def = document.createElement('option');
  def.value = '';
  def.textContent = 'Default voice';
  voiceEl.appendChild(def);

  voices.sort((a, b) => {
    const ag = a.lang.replace('_', '-') === 'en-GB';
    const bg = b.lang.replace('_', '-') === 'en-GB';
    if (ag !== bg) return ag ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  voices.forEach((v) => {
    const opt = document.createElement('option');
    opt.value = v.name;
    const accent = v.lang.replace('_', '-') === 'en-GB' ? 'UK' : 'US';
    opt.textContent = `${v.name} — ${accent}`;
    voiceEl.appendChild(opt);
  });
  if (prefVoice) voiceEl.value = prefVoice;
}

// Try the native macOS `say` voices first; fall back to Web Speech voices
browser.runtime.sendMessage({ to: 'native', cmd: 'getvoices' })
  .then((resp) => {
    if (resp && resp.voices && resp.voices.length) {
      fillVoices(resp.voices);
    } else {
      return withTab((id) => browser.tabs.sendMessage(id, { cmd: 'getwebvoices' }))
        .then((r) => fillVoices((r && r.voices) || []));
    }
  })
  .catch(() => fillVoices([]));

// ---------- Live controls ----------
speedEl.addEventListener('input', () => {
  speedVal.textContent = parseFloat(speedEl.value).toFixed(1) + '×';
});
speedEl.addEventListener('change', () => {
  browser.storage.local.set({ wr_rate: speedEl.value });
  send({ cmd: 'setrate', rate: parseFloat(speedEl.value) });
});
voiceEl.addEventListener('change', () => {
  browser.storage.local.set({ wr_voice: voiceEl.value });
  send({ cmd: 'setvoice', voice: voiceEl.value || null });
});
rsvpEl.addEventListener('change', () => {
  browser.storage.local.set({ wr_rsvp: rsvpEl.checked ? '1' : '0' });
  send({ cmd: 'setrsvp', rsvp: rsvpEl.checked });
});

// ---------- Transport ----------
btnPlay.addEventListener('click', () => {
  send({
    cmd: 'play',
    rate: parseFloat(speedEl.value),
    voice: voiceEl.value || null,
    rsvp: rsvpEl.checked
  });
  btnPlay.disabled = true;
  btnPause.disabled = false;
  btnStop.disabled = false;
});
btnPause.addEventListener('click', () => {
  const paused = btnPause.textContent === '▶';
  if (paused) { send({ cmd: 'resume' }); btnPause.textContent = '⏸'; btnPause.title = 'Pause'; }
  else { send({ cmd: 'pause' }); btnPause.textContent = '▶'; btnPause.title = 'Resume'; }
});
btnStop.addEventListener('click', () => {
  send({ cmd: 'stop' });
  btnPlay.disabled = false;
  btnPause.disabled = true;
  btnPause.textContent = '⏸';
  btnPause.title = 'Pause';
  btnStop.disabled = true;
});
