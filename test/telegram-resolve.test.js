// Minimal self-check for username -> chat id resolution used when sending.
// Run: node test/telegram-resolve.test.js
const assert = require('assert');
const { TelegramBot } = require('../src/main/telegram');

const bot = new TelegramBot({ getConfig: () => ({}) });
const cfg = { knownUsers: { giamat13: '5248424014' } };

// numeric id passes through untouched
assert.strictEqual(bot._resolveTarget('5248424014', cfg), '5248424014');
assert.strictEqual(bot._resolveTarget('-1001234567890', cfg), '-1001234567890');
// @username resolves to the learned numeric id (case-insensitive, @ optional)
assert.strictEqual(bot._resolveTarget('@giamat13', cfg), '5248424014');
assert.strictEqual(bot._resolveTarget('GiaMat13', cfg), '5248424014');
// an unknown username can't be sent to -> null (caller reports "send /start first")
assert.strictEqual(bot._resolveTarget('@nobody', cfg), null);

console.log('OK');
