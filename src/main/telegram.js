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
  constructor({ getConfig, onMessage, onCommand, onLearnUser }) {
    this._getConfig = getConfig;            // () => { enabled, botToken, chatIds, ... }
    this._onMessage = typeof onMessage === 'function' ? onMessage : () => {};
    this._onCommand = typeof onCommand === 'function' ? onCommand : () => {};
    this._onLearnUser = typeof onLearnUser === 'function' ? onLearnUser : () => {}; // (username, chatId) => persist
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
  // Polls whenever a token is set — not just when "enabled" — so the bot stays
  // alive the whole time the app is open (it can answer /start, etc.). The
  // `enabled` flag gates whether Telegram acts on the break flow (main.js).
  refresh() {
    const cfg = this._cfg();
    if (cfg.botToken) {
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
      knownUsers: (c.knownUsers && typeof c.knownUsers === 'object') ? c.knownUsers : {},
    };
  }

  // Turn a configured entry into something Telegram can send to: a numeric id
  // is used as-is; an @username is resolved to the numeric id we learned when
  // that person messaged the bot (Telegram can't send to a private @username).
  // Returns null if we've never seen that username — the caller reports why.
  _resolveTarget(entry, cfg) {
    const v = String(entry).trim();
    if (/^-?\d+$/.test(v)) return v;
    const name = v.replace(/^@/, '').toLowerCase();
    return (cfg.knownUsers || {})[name] || null;
  }

  // Send to every configured chat. Resolves { ok, error }: ok only when every
  // chat accepted, otherwise error names the first chat that failed and why
  // (e.g. a private @username Telegram can't deliver to → "chat not found").
  sendToAll(text) {
    const cfg = this._cfg();
    if (!cfg.botToken || !cfg.chatIds.length) return Promise.resolve({ ok: false, error: 'no bot token or chat ids set' });
    return Promise.all(cfg.chatIds.map((entry) => {
      const target = this._resolveTarget(entry, cfg);
      if (!target) return Promise.resolve({ id: entry, ok: false, error: `unknown — have ${entry} send /start to the bot first` });
      return this._send(cfg.botToken, target, text).then((r) => ({ id: entry, ...r }));
    })).then((results) => {
      const bad = results.find((r) => !r.ok);
      return bad ? { ok: false, error: `${bad.id}: ${bad.error}` } : { ok: true };
    });
  }

  // Resolves { ok, error }. ok reflects Telegram's own `ok` field, not merely
  // that an HTTP response came back — a rejected chat is a failure.
  _send(token, chatId, text) {
    return new Promise((resolve) => {
      const body = JSON.stringify({ chat_id: String(chatId).trim(), text, disable_web_page_preview: true });
      const req = https.request({
        method: 'POST',
        hostname: 'api.telegram.org',
        path: `/bot${token}/sendMessage`,
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        timeout: 15000,
      }, (res) => {
        let raw = '';
        res.on('data', (d) => { raw += d; });
        res.on('end', () => {
          try {
            const json = JSON.parse(raw);
            resolve(json && json.ok ? { ok: true } : { ok: false, error: (json && json.description) || 'send failed' });
          } catch { resolve({ ok: false, error: 'bad response' }); }
        });
      });
      req.on('error', (e) => resolve({ ok: false, error: (e && e.message) || 'network error' }));
      req.on('timeout', () => { try { req.destroy(); } catch {} resolve({ ok: false, error: 'timeout' }); });
      req.write(body);
      req.end();
    });
  }

  // Long-poll loop. Re-arms itself until stop() is called.
  _poll() {
    if (this._stopped) return;
    const cfg = this._cfg();
    if (!cfg.botToken) { this._stopped = true; return; }

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
    // Allowlist entries can be numeric chat ids or @usernames. Ids match the
    // chat id; usernames match the sender's @username on the incoming reply.
    const ids = new Set();
    const names = new Set();
    for (const c of cfg.chatIds) {
      const v = String(c).trim();
      if (!v) continue;
      if (/^-?\d+$/.test(v)) ids.add(v);
      else names.add(v.replace(/^@/, '').toLowerCase());
    }
    const configured = ids.size || names.size;
    for (const u of updates) {
      this._offset = Math.max(this._offset, (u.update_id || 0) + 1);
      const msg = u.message || u.edited_message || u.channel_post;
      if (!msg || !msg.text) continue;
      const chatId = msg.chat && msg.chat.id != null ? String(msg.chat.id) : '';
      const uname = ((msg.from && msg.from.username) || (msg.chat && msg.chat.username) || '').toLowerCase();
      const text = String(msg.text).trim();
      const at = (msg.date ? msg.date * 1000 : Date.now());
      // In a private chat, remember username -> chat id so the owner can add a
      // watcher by @username and we still know the numeric id needed to send.
      if (uname && chatId && msg.chat && msg.chat.type === 'private' && (cfg.knownUsers || {})[uname] !== chatId) {
        this._onLearnUser(uname, chatId);
      }
      // /start works for anyone (even unauthorized) so a new person gets a reply
      // and learns their id/username to give the owner (who authorizes in the app).
      if (/^\/start(@|\s|$)/i.test(text)) {
        this._send(cfg.botToken, chatId,
          `✅ Screen Time bot is running.\nYour chat id: ${chatId}` +
          (uname ? `\nYour username: @${uname}` : '') +
          `\nTo receive alerts, ask the Screen Time owner to add this in the app.`);
        continue;
      }
      // Only honour everything else from configured chats (by id or @username).
      if (configured && !ids.has(chatId) && !(uname && names.has(uname))) continue;
      if (/^\/lock(@|\s|$)/i.test(text)) {
        this._onCommand('lock', { chatId, text, at });
        continue;
      }
      this._onMessage({ chatId, text, at, negative: isNegativeReply(text) });
    }
  }
}

module.exports = { TelegramBot, isNegativeReply };
