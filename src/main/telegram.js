const https = require('https');

// Negative / "no you may not keep playing" keywords, English + Hebrew. A reply
// containing any of these (or the /cancel command) is treated as a veto.
const NEGATIVE_KEYWORDS = [
  '/cancel', 'cancel', 'no', 'nope', 'stop', 'lock', 'forbidden', 'denied', 'deny', 'not allowed',
  'אסור', 'לא', 'עצור', 'תפסיק', 'תנעל', 'נעל', 'די', 'אין', 'תפסיקי', 'לך',
];

// Does a Telegram message body count as a veto?
function isNegativeReply(text) {
  if (!text) return false;
  const t = String(text).trim().toLowerCase();
  if (!t) return false;
  return NEGATIVE_KEYWORDS.some((kw) => {
    const k = kw.toLowerCase();
    // whole-word-ish match for short latin words, substring for the rest
    if (/^[a-z/]+$/.test(k)) {
      return new RegExp(`(^|\\b|\\s)${k.replace('/', '\\/')}(\\b|\\s|$)`).test(t);
    }
    return t.includes(k);
  });
}

// Minimal Telegram Bot API client that polls getUpdates and can send messages.
// No third-party dependencies — just Node's https.
class TelegramBot {
  constructor({ getConfig, onMessage, onCommand }) {
    this._getConfig = getConfig;            // () => { enabled, botToken, chatIds, ... }
    this._onMessage = typeof onMessage === 'function' ? onMessage : () => {};
    this._onCommand = typeof onCommand === 'function' ? onCommand : () => {};
    this._offset = 0;                       // getUpdates offset (ack cursor)
    this._polling = false;
    this._stopped = true;
    this._activeReq = null;
  }

  start() {
    this._stopped = false;
    this._poll();
  }

  stop() {
    this._stopped = true;
    if (this._activeReq) { try { this._activeReq.destroy(); } catch {} this._activeReq = null; }
  }

  // React to a settings change: (re)start or stop polling depending on config.
  refresh() {
    const cfg = this._cfg();
    if (cfg.enabled && cfg.botToken) {
      if (this._stopped) this.start();
    } else {
      this.stop();
    }
  }

  _cfg() {
    const c = this._getConfig() || {};
    return {
      enabled: !!c.enabled,
      botToken: c.botToken || '',
      chatIds: Array.isArray(c.chatIds) ? c.chatIds : [],
    };
  }

  // Fire-and-forget send to every configured chat. Returns a promise that
  // resolves once all sends settle (used for the intro message).
  sendToAll(text) {
    const cfg = this._cfg();
    if (!cfg.botToken || !cfg.chatIds.length) return Promise.resolve(false);
    return Promise.all(cfg.chatIds.map((id) => this._send(cfg.botToken, id, text)))
      .then(() => true)
      .catch(() => false);
  }

  _send(token, chatId, text) {
    return new Promise((resolve) => {
      const body = JSON.stringify({ chat_id: String(chatId).trim(), text, disable_web_page_preview: true });
      const req = https.request({
        method: 'POST',
        hostname: 'api.telegram.org',
        path: `/bot${token}/sendMessage`,
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        timeout: 15000,
      }, (res) => { res.on('data', () => {}); res.on('end', () => resolve(true)); });
      req.on('error', () => resolve(false));
      req.on('timeout', () => { try { req.destroy(); } catch {} resolve(false); });
      req.write(body);
      req.end();
    });
  }

  // Long-poll loop. Re-arms itself until stop() is called.
  _poll() {
    if (this._stopped) return;
    const cfg = this._cfg();
    if (!cfg.enabled || !cfg.botToken) { this._stopped = true; return; }

    const path = `/bot${cfg.botToken}/getUpdates?timeout=30&offset=${this._offset}`;
    const req = https.request({
      method: 'GET', hostname: 'api.telegram.org', path, timeout: 40000,
    }, (res) => {
      let raw = '';
      res.on('data', (d) => { raw += d; });
      res.on('end', () => {
        this._activeReq = null;
        try {
          const json = JSON.parse(raw);
          if (json && json.ok && Array.isArray(json.result)) this._handleUpdates(json.result, cfg);
        } catch { /* ignore malformed */ }
        // brief spacing so a hard error doesn't hot-loop
        setTimeout(() => this._poll(), 500);
      });
    });
    req.on('error', () => { this._activeReq = null; if (!this._stopped) setTimeout(() => this._poll(), 3000); });
    req.on('timeout', () => { try { req.destroy(); } catch {} });
    this._activeReq = req;
    req.end();
  }

  _handleUpdates(updates, cfg) {
    const allow = new Set(cfg.chatIds.map((c) => String(c).trim()));
    for (const u of updates) {
      this._offset = Math.max(this._offset, (u.update_id || 0) + 1);
      const msg = u.message || u.edited_message || u.channel_post;
      if (!msg || !msg.text) continue;
      const chatId = msg.chat && msg.chat.id != null ? String(msg.chat.id) : '';
      // Only honour messages from configured chats.
      if (allow.size && !allow.has(chatId)) continue;
      const text = String(msg.text).trim();
      const at = (msg.date ? msg.date * 1000 : Date.now());
      if (/^\/lock(@|\s|$)/i.test(text)) {
        this._onCommand('lock', { chatId, text, at });
        continue;
      }
      this._onMessage({ chatId, text, at, negative: isNegativeReply(text) });
    }
  }
}

module.exports = { TelegramBot, isNegativeReply };
