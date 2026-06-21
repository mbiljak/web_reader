(() => {
  if (window.__webReaderActive) return;
  window.__webReaderActive = true;

  // Clear any orphaned caption band left over from a previous load of the extension
  document.querySelectorAll('#__web_reader_rsvp').forEach((e) => e.remove());

  // ---------- State ----------
  let sentences = [];
  let currentIndex = 0;
  let currentRate = 1;          // slider multiplier (0.5–2.5)
  let currentVoiceName = null;
  let rsvpEnabled = false;
  let isPlaying = false;
  let isPaused = false;
  let engine = 'native';        // 'native' (macOS say) or 'web' (Web Speech fallback)
  let nativeSeq = 0;            // id of the in-flight native sentence

  function toWpm(mult) {
    return Math.min(400, Math.max(80, Math.round(175 * mult)));
  }

  // ---------- Text extraction ----------
  // Canvas-based editors (Google Docs) render text on a <canvas>, so there's no
  // selectable DOM text — getSelection() returns empty. Detect them so we can
  // fall back to the clipboard (the user copies with Cmd+C first).
  function isCanvasEditor() {
    return /(^|\.)docs\.google\.com$/.test(location.hostname) &&
      location.pathname.includes('/document/');
  }

  async function extractText() {
    const selection = window.getSelection().toString().trim();
    if (selection.length > 0) return selection;

    if (isCanvasEditor()) {
      try {
        const clip = (await navigator.clipboard.readText()).trim();
        if (clip.length > 0) return clip;
      } catch (e) { /* clipboard blocked or empty */ }
      return '__NEEDS_COPY__';
    }

    try {
      const doc = document.cloneNode(true);
      const article = new Readability(doc).parse();
      if (article && article.textContent && article.textContent.trim().length > 200) {
        return article.textContent.trim();
      }
    } catch (e) { /* fall through */ }
    return document.body.innerText.trim();
  }

  function splitSentences(text) {
    return text
      .replace(/\s+/g, ' ')
      .split(/(?<=[.!?])\s+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }

  // ---------- RSVP "speed caption" overlay ----------
  let rsvpBox = null;
  let rsvpTimer = null;
  let rsvpWords = [];
  let rsvpPos = 0;

  function ensureRsvpBox() {
    if (rsvpBox) return rsvpBox;
    rsvpBox = document.createElement('div');
    rsvpBox.id = '__web_reader_rsvp';
    rsvpBox.style.cssText = [
      'position:fixed', 'top:0', 'left:0', 'right:0', 'z-index:2147483647',
      'background:rgba(20,20,30,0.96)', 'color:#e8e8f0',
      'font-family:Georgia,serif', 'font-size:48px', 'font-weight:600',
      'padding:28px 0', 'text-align:center', 'letter-spacing:0.02em',
      'box-shadow:0 2px 18px rgba(0,0,0,0.4)', 'pointer-events:none', 'display:none'
    ].join(';');
    (document.documentElement || document.body).appendChild(rsvpBox);
    return rsvpBox;
  }

  function removeRsvpBox() {
    // Remove every matching node, not just the referenced one, so nothing lingers
    document.querySelectorAll('#__web_reader_rsvp').forEach((e) => e.remove());
    rsvpBox = null;
  }

  function orpIndex(len) {
    if (len <= 1) return 0;
    if (len <= 5) return 1;
    if (len <= 9) return 2;
    if (len <= 13) return 3;
    return 4;
  }

  function span(text, color) {
    const s = document.createElement('span');
    s.textContent = text;
    if (color) s.style.color = color;
    return s;
  }

  function showWord(word) {
    if (!rsvpEnabled || !isPlaying) return;
    const box = ensureRsvpBox();
    box.style.display = 'block';
    box.textContent = '';
    const clean = (word || '').replace(/[ \t]/g, '');
    if (!clean) { box.textContent = ' '; return; }
    const i = orpIndex(clean.length);
    box.appendChild(span(clean.slice(0, i)));
    box.appendChild(span(clean[i] || '', '#ff4d4d'));
    box.appendChild(span(clean.slice(i + 1)));
  }

  function rsvpTick() {
    if (rsvpPos >= rsvpWords.length) {
      clearInterval(rsvpTimer); rsvpTimer = null; return;
    }
    showWord(rsvpWords[rsvpPos]);
    rsvpPos++;
  }

  // Estimated word pacing for the native engine (say gives no word callbacks)
  function startRsvpTimer(sentence) {
    pauseRsvpTimer();
    if (!rsvpEnabled) return;
    rsvpWords = sentence.split(/\s+/).filter(Boolean);
    rsvpPos = 0;
    ensureRsvpBox().style.display = 'block';
    const interval = Math.max(120, 60000 / (175 * currentRate));
    rsvpTick();
    rsvpTimer = setInterval(rsvpTick, interval);
  }

  function resumeRsvpTimer() {
    if (!rsvpEnabled || engine !== 'native') return;
    if (rsvpPos >= rsvpWords.length) return;
    const interval = Math.max(120, 60000 / (175 * currentRate));
    if (rsvpBox) rsvpBox.style.display = 'block';
    rsvpTimer = setInterval(rsvpTick, interval);
  }

  function pauseRsvpTimer() {
    if (rsvpTimer) { clearInterval(rsvpTimer); rsvpTimer = null; }
  }

  function stopRsvpTimer() {
    pauseRsvpTimer();
    rsvpWords = [];
    rsvpPos = 0;
  }

  // ---------- Web Speech fallback ----------
  function pickWebVoice() {
    if (!currentVoiceName) return null;
    return window.speechSynthesis.getVoices().find((v) => v.name === currentVoiceName) || null;
  }

  function webSpeak(text) {
    const u = new SpeechSynthesisUtterance(text);
    u.rate = currentRate;
    const v = pickWebVoice();
    if (v) u.voice = v;
    u.onboundary = (e) => {
      if (!rsvpEnabled || (e.name && e.name !== 'word')) return;
      const m = text.slice(e.charIndex).match(/^\S+/);
      if (m) showWord(m[0]);
    };
    u.onend = () => {
      if (isPlaying && !isPaused) { currentIndex++; speakCurrent(); }
    };
    u.onerror = (e) => {
      if (e.error !== 'interrupted' && e.error !== 'canceled' && isPlaying && !isPaused) {
        currentIndex++; speakCurrent();
      }
    };
    window.speechSynthesis.speak(u);
  }

  // ---------- Playback core ----------
  function speakCurrent() {
    if (currentIndex >= sentences.length) { finish(); return; }
    const text = sentences[currentIndex];
    if (engine === 'native') {
      nativeSeq++;
      startRsvpTimer(text);
      browser.runtime.sendMessage({
        to: 'native', cmd: 'speak', id: nativeSeq,
        text, voice: currentVoiceName, rate: toWpm(currentRate)
      });
    } else {
      webSpeak(text);
    }
  }

  function finish() {
    isPlaying = false;
    isPaused = false;
    stopRsvpTimer();
    if (rsvpBox) rsvpBox.style.display = 'none';
  }

  async function startPlayback() {
    window.speechSynthesis.cancel();
    const text = await extractText();
    if (text === '__NEEDS_COPY__') {
      flashNotice('Select your text in the Doc and press ⌘C, then play again.');
      return;
    }
    sentences = splitSentences(text);
    if (sentences.length === 0) return;
    currentIndex = 0;
    isPlaying = true;
    isPaused = false;
    engine = 'native';
    if (rsvpEnabled) ensureRsvpBox(); else removeRsvpBox();
    speakCurrent();
  }

  // Brief on-page toast for guidance (e.g. the Google Docs copy step)
  function flashNotice(msg) {
    const n = document.createElement('div');
    n.textContent = msg;
    n.style.cssText = [
      'position:fixed', 'bottom:24px', 'left:50%', 'transform:translateX(-50%)',
      'z-index:2147483647', 'background:rgba(20,20,30,0.96)', 'color:#e8e8f0',
      'font-family:system-ui,sans-serif', 'font-size:14px', 'padding:12px 18px',
      'border-radius:8px', 'box-shadow:0 2px 18px rgba(0,0,0,0.4)', 'pointer-events:none'
    ].join(';');
    document.documentElement.appendChild(n);
    setTimeout(() => n.remove(), 4000);
  }

  function restartCurrent() {
    if (!isPlaying) return;
    isPaused = false;
    if (engine === 'native') browser.runtime.sendMessage({ to: 'native', cmd: 'stop' });
    window.speechSynthesis.cancel();
    pauseRsvpTimer();
    speakCurrent();
  }

  function doStop() {
    isPlaying = false;
    isPaused = false;
    if (engine === 'native') browser.runtime.sendMessage({ to: 'native', cmd: 'stop' });
    window.speechSynthesis.cancel();
    stopRsvpTimer();
    removeRsvpBox();           // fully clear the captions from the screen
    sentences = [];
    currentIndex = 0;
  }

  function doPause() {
    if (!isPlaying || isPaused) return;
    isPaused = true;
    if (engine === 'native') { browser.runtime.sendMessage({ to: 'native', cmd: 'pause' }); pauseRsvpTimer(); }
    else window.speechSynthesis.pause();
  }

  function doResume() {
    if (!isPlaying || !isPaused) return;
    isPaused = false;
    if (engine === 'native') { browser.runtime.sendMessage({ to: 'native', cmd: 'resume' }); resumeRsvpTimer(); }
    else window.speechSynthesis.resume();
  }

  // Read defaults from storage (used by the hotkey, which has no popup values)
  function playFromPrefs() {
    browser.storage.local.get(['wr_rate', 'wr_voice', 'wr_rsvp']).then((p) => {
      currentRate = parseFloat(p.wr_rate) || 1;
      currentVoiceName = p.wr_voice || null;
      rsvpEnabled = p.wr_rsvp === '1';
      startPlayback();
    });
  }

  // ---------- Message handling ----------
  browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // Events relayed from the native host (via background)
    if (message.event === 'sentence-end') {
      if (engine === 'native' && message.id === nativeSeq && isPlaying && !isPaused) {
        pauseRsvpTimer();
        currentIndex++;
        speakCurrent();
      }
      return;
    }
    if (message.event === 'native-error') {
      // macOS host unavailable -> fall back to the browser's Web Speech engine
      if (engine === 'native') {
        engine = 'web';
        if (isPlaying && !isPaused) { pauseRsvpTimer(); webSpeak(sentences[currentIndex]); }
      }
      return;
    }

    const { cmd } = message;

    if (cmd === 'play') {
      currentRate = message.rate || 1;
      currentVoiceName = message.voice || null;
      rsvpEnabled = !!message.rsvp;
      startPlayback();
    } else if (cmd === 'toggle') {
      if (!isPlaying) playFromPrefs();
      else if (isPaused) doResume();
      else doPause();
    } else if (cmd === 'pause') {
      doPause();
    } else if (cmd === 'resume') {
      doResume();
    } else if (cmd === 'stop') {
      doStop();
    } else if (cmd === 'setrate') {
      currentRate = message.rate || 1;
      restartCurrent();
    } else if (cmd === 'setvoice') {
      currentVoiceName = message.voice || null;
      restartCurrent();
    } else if (cmd === 'setrsvp') {
      rsvpEnabled = !!message.rsvp;
      if (!rsvpEnabled) { pauseRsvpTimer(); if (rsvpBox) rsvpBox.style.display = 'none'; }
      else if (isPlaying && !isPaused && engine === 'native') startRsvpTimer(sentences[currentIndex] || '');
    } else if (cmd === 'getwebvoices') {
      // Web Speech voice list (fallback when no native host)
      const voices = window.speechSynthesis.getVoices().map((v) => ({
        name: v.name, lang: v.lang, default: v.default
      }));
      sendResponse({ voices });
      return true;
    }
  });
})();
