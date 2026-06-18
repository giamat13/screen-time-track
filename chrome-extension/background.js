// Service worker: figures out the active tab + whether its media is playing,
// then POSTs that to the Screen Time desktop app on 127.0.0.1.
const ENDPOINT = 'http://127.0.0.1:47832/state';

// tabId -> { playing, ad }: media state in that tab (reported by content.js).
const mediaState = new Map();

function domainOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

async function getActiveTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    return tab || null;
  } catch { return null; }
}

async function pushState() {
  const tab = await getActiveTab();

  // Is a Chrome window actually the focused application? If not, report
  // inactive so the desktop app counts whatever else is in the foreground.
  let focused = true;
  try {
    const w = await chrome.windows.getLastFocused();
    focused = !!(w && w.focused);
  } catch {}

  let payload;
  if (!tab || !tab.url || !/^https?:/.test(tab.url) || !focused) {
    payload = { active: false };
  } else {
    const ms = mediaState.get(tab.id) || {};
    payload = {
      active: true,
      url: tab.url,
      title: tab.title || '',
      domain: domainOf(tab.url),
      audible: !!tab.audible,
      playing: ms.playing === true || !!tab.audible,
      ad: ms.ad === true
    };
  }

  try {
    await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  } catch (e) { /* desktop app not running — that's fine, just retry next time */ }
}

chrome.tabs.onActivated.addListener(() => pushState());
chrome.tabs.onUpdated.addListener((id, info) => {
  if (info.url || info.title || info.audible !== undefined || info.status === 'complete') pushState();
});
chrome.windows.onFocusChanged.addListener(() => pushState());
chrome.tabs.onRemoved.addListener((id) => mediaState.delete(id));

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg && msg.type === 'media' && sender.tab) {
    mediaState.set(sender.tab.id, { playing: !!msg.playing, ad: !!msg.ad });
    pushState();
  }
});

// Heartbeat backstop in case events are missed or the worker was restarted.
chrome.alarms.create('hb', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'hb') pushState(); });

// Report immediately on install / browser start.
pushState();
