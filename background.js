// Bridges content scripts / popup to the native `say` host, and routes hotkeys.

const HOST_NAME = 'com.webreader.host';
let port = null;
let readerTabId = null;
let voicesWaiters = [];

function connect() {
  port = browser.runtime.connectNative(HOST_NAME);

  port.onMessage.addListener((msg) => {
    if (msg.type === 'voices') {
      voicesWaiters.forEach((resolve) => resolve(msg.voices || []));
      voicesWaiters = [];
    } else if (msg.type === 'end') {
      if (readerTabId != null) {
        browser.tabs.sendMessage(readerTabId, { event: 'sentence-end', id: msg.id }).catch(() => {});
      }
    } else if (msg.type === 'error') {
      if (readerTabId != null) {
        browser.tabs.sendMessage(readerTabId, { event: 'native-error', message: msg.message }).catch(() => {});
      }
    }
  });

  port.onDisconnect.addListener(() => {
    const err = browser.runtime.lastError;
    port = null;
    // Anyone waiting on a voice list gets nothing -> popup falls back to Web Speech
    voicesWaiters.forEach((resolve) => resolve(null));
    voicesWaiters = [];
    if (readerTabId != null) {
      browser.tabs.sendMessage(readerTabId, {
        event: 'native-error',
        message: (err && err.message) || 'Native host disconnected'
      }).catch(() => {});
    }
  });
}

function ensurePort() {
  if (!port) {
    try {
      connect();
    } catch (e) {
      return null;
    }
  }
  return port;
}

browser.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.to !== 'native') return;

  const p = ensurePort();
  if (!p) {
    if (msg.cmd === 'getvoices') sendResponse({ voices: null });
    return true;
  }

  if (msg.cmd === 'getvoices') {
    voicesWaiters.push((voices) => sendResponse({ voices }));
    try {
      p.postMessage({ type: 'voices' });
    } catch (e) {
      sendResponse({ voices: null });
    }
    return true; // async response
  }

  if (msg.cmd === 'speak') {
    // Only one tab may read at a time — stop the previous reader if a new one starts
    if (sender.tab && readerTabId != null && readerTabId !== sender.tab.id) {
      browser.tabs.sendMessage(readerTabId, { cmd: 'stop' }).catch(() => {});
    }
    if (sender.tab) readerTabId = sender.tab.id;
    try {
      p.postMessage({ type: 'speak', id: msg.id, text: msg.text, voice: msg.voice, rate: msg.rate });
    } catch (e) {
      if (readerTabId != null) {
        browser.tabs.sendMessage(readerTabId, { event: 'native-error', message: 'post failed' }).catch(() => {});
      }
    }
    return;
  }

  if (msg.cmd === 'stop')   {
    if (sender.tab && sender.tab.id === readerTabId) readerTabId = null;
    try { p.postMessage({ type: 'stop' }); } catch (e) {}
    return;
  }
  if (msg.cmd === 'pause')  { try { p.postMessage({ type: 'pause' }); }  catch (e) {} return; }
  if (msg.cmd === 'resume') { try { p.postMessage({ type: 'resume' }); } catch (e) {} return; }
});

// Keyboard shortcuts -> active tab content script
browser.commands.onCommand.addListener((command) => {
  browser.tabs.query({ active: true, currentWindow: true }).then((tabs) => {
    if (!tabs[0]) return;
    if (command === 'toggle-read') browser.tabs.sendMessage(tabs[0].id, { cmd: 'toggle' }).catch(() => {});
    if (command === 'stop-read')   browser.tabs.sendMessage(tabs[0].id, { cmd: 'stop' }).catch(() => {});
  });
});
