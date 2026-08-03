// Persistent data store (JSON file in userData). Aggregates time per day per app.
const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const log = require('./log');

const DATA_FILE = path.join(app.getPath('userData'), 'screen-time-data.json');
const BACKUP_FILE = DATA_FILE + '.bak';
const TMP_FILE = DATA_FILE + '.tmp';
// Two builds (the installed app and one launched from the repo) share this userData
// dir, and Electron's single-instance lock does not hold across them. Two instances
// each flushing their own in-memory state means the one that started from empty
// defaults wins — which is how a full history gets erased. This file records who owns
// the data; a process that does not own it refuses to write.
const OWNER_FILE = path.join(app.getPath('userData'), 'owner.json');
const OWNER_STALE_MS = 90 * 1000;
// Dated generational copies — the only thing that survives a wipe of both files above.
// Written to two places on purpose: the userData copy is convenient, but it dies with
// the folder it protects. Documents is covered by File History / OneDrive, so a copy
// there survives losing the profile folder entirely.
const SNAPSHOT_DIRS = [
  path.join(app.getPath('userData'), 'backups'),
  path.join(app.getPath('documents'), 'ScreenTime Backups'),
];
// One snapshot per 3-hour slot. Nothing here is ever auto-deleted — deleting old
// copies is exactly what left nothing to recover from. Prune by hand if it matters;
// at a few hundred KB per file this costs well under a GB a year.
const SNAPSHOT_SLOT_HOURS = 3;
let lastSnapshotSlot = null;
// Separate tiny file for an in-force break lock. Kept out of the main data file
// on purpose: it must be written *synchronously* on every lock tick so a hard
// power-off leaves an at-most-1s-stale record, independent of the 4s debounce
// the main store uses.
const LOCK_FILE = path.join(app.getPath('userData'), 'lock-state.json');

function defaults() {
  return {
    version: 1,
    installedAt: new Date().toISOString(),
    days: {}, // 'YYYY-MM-DD' -> { apps: { name: seconds }, total, firstSeen, lastSeen }
    goals: {}, // { appName: targetSeconds }
    globalLimit: 0, // total daily screen-time cap across all apps (seconds); 0 = off
    goalsSnapshots: [], // [{ effectiveDate: 'YYYY-MM-DD', goals: {...}, globalLimit: N }]
    budgetRollover: { forDate: null, seconds: 0 }, // yesterday's unused time budget, frozen at midnight
    reminders: [], // [{ id, time: 'HH:MM', message, enabled }]
    habits: [], // [{ id, name, emoji, color, freqType: 'daily'|'weekly', target, timeReward, createdAt, entries: [{ ts, amount }] }]
    otherUsers: [], // [{ id, name, startedAt, endedAt }] — sessions logged while "Not Me" was on
    streaks: { current: 0, best: 0, lastCheckedDate: null, metDays: {}, freezers: 5, frozenDays: {} },
    forest: {
      coins: 0,
      coinsEarned: 0, // lifetime, for the coins-100 achievement
      unlockedSpecies: ['oak'],
      selectedSpecies: 'oak',
      trees: [], // [{ id, species, tag, taskId, plannedSec, actualSec, startedAt, endedAt, result: 'success'|'dead'|'givenup', mode }]
      tags: ['Study', 'Work', 'Writing'],
      tasks: [], // [{ id, title, done, createdAt, doneAt, focusSec, treeCount }]
      distractions: { mode: 'blocklist', apps: [] },
      achievements: {}, // id -> unlockedAt ISO
      settings: { allowPause: true, warningSec: 10 },
      activeSession: null // crash-recovery snapshot; non-null on boot => that tree died
    },
    settings: {
      tracking: true,
      idleThreshold: 30, // seconds with no input => not counted
      pollInterval: 2, // seconds between samples
      autoLaunch: true,
      minimizeToTray: true,
      studyMode: false, // when on, time is still tracked but excluded from daily limits
      notMe: false, // when on, someone else is at the computer — nothing is tracked at all
      browserDetail: true, // relabel browser time to the real site via the extension
      countMediaWhenIdle: true, // keep counting while a video/track is playing
      mediaIdleCap: 600, // after this many idle seconds, stop counting media (you left)
      breakReminder: {
        enabled: false,
        checkIntervalMinutes: 60,
        devMode: false,             // use a seconds-based interval for quick testing
        checkIntervalSeconds: 10,   // interval used when devMode is on
        beepFrequency: 1000,
        beepDuration: 200,
        beepIntervalSeconds: 0.4,

        // ---- lock system -----------------------------------------------------
        breakLockMinutes: 5,        // how long a full break locks the computer
        ignoreBeepMinutes: 5,       // ignore the alarm this long => auto full lock
        approveShortLockSeconds: 10,// "approve me" from the prompt locks this long
        approveMinLockSeconds: 20,  // "approve me" on the lock screen needs this much lock time first

        // ---- call-aware cadence ----------------------------------------------
        // While on a call (Zoom/Discord/Meet/etc.), use these instead — e.g. less
        // frequent but longer breaks. 0 = disabled, falls back to the normal values.
        callCheckIntervalMinutes: 0,
        callBreakLockMinutes: 0,

        // ---- telegram escalation --------------------------------------------
        // When you press "approve me", the watchers are messaged. If one of them
        // replies /cancel or a negative keyword, we react based on how long the
        // reply took to arrive (elapsed since the message was sent).
        cancelWindowSeconds: 10,    // reply within this => lock immediately
        tier1Minutes: 1,            // reply within this => tier1Beep then lock
        tier1BeepSeconds: 30,
        tier2Minutes: 5,            // reply within this => tier2Beep then lock
        tier2BeepSeconds: 60,
        tier3Minutes: 10,           // reply within this => tier3Beep then lock
        tier3BeepSeconds: 300,
        tier3PlusBeepSeconds: 300,  // reply after tier3Minutes => this beep then lock

        telegram: {
          enabled: false,
          botToken: '',
          chatIds: [],              // group and/or private chat ids (or @usernames) to notify
          introSent: false,         // whether the first-time explanation was delivered
          knownUsers: {},           // learned @username(lowercase) -> chat id, from /start etc.
        },
      },
      timeBudget: {
        enabled: false,     // when on, exceeding the budget locks the machine (see timeBudget.js)
        startMinutes: 60,   // daily screen-time allowance before the lock kicks in; habits with
                             // a timeReward top this up for the day (see getTimeBudgetEarnedSecondsToday)
        rollover: true,     // on by default whenever the feature is on: yesterday's unused
                             // allowance (if any) is added to today's budget (see getRolloverSecondsFromYesterday)
      },
    }
  };
}

// ---- durable writes --------------------------------------------------------
// THE data-loss bug. fs.writeFileSync returns as soon as the bytes are in the OS
// page cache; it does not mean they reached the disk. NTFS journals *metadata*
// (the file's new length) but not file *data*, so an unclean shutdown before the
// cache flushes replays a file of exactly the right size filled with zeros.
//
// That is not a theory: after the 2026-07-27 power loss both screen-time-data.json
// and its .bak were 110406 bytes of 0x00 — same length as the last good save, no
// content. Three wipes, three unclean shutdowns in the Windows event log. The
// write-to-temp-then-rename dance below is worthless without this fsync, because
// renaming a file whose data never landed just gives the zeros a permanent name.
function writeFileSyncDurable(file, contents) {
  const fd = fs.openSync(file, 'w');
  try {
    fs.writeFileSync(fd, contents);
    fs.fsyncSync(fd);   // block until the platter/SSD actually has it
  } finally {
    fs.closeSync(fd);
  }
}

// A file of the right length full of NULs is the fingerprint of the failure
// above. Worth naming explicitly in the log — "JSON parse error" alone sent the
// last two investigations after the wrong cause.
function looksZeroed(raw) {
  return raw.length > 0 && !/[^\0]/.test(raw);
}

let data = defaults();
let saveTimer = null;
// Set when a data file exists on disk but we could not read it. While true the
// store refuses to write, so a transient read error can never be laundered into
// an empty-defaults save that destroys the only copies we have.
let loadFailed = false;
// Set when a different live instance owns the data file; we then never write.
let foreignOwner = false;

// Every place a full copy of the data might live, most-authoritative first.
// DATA_FILE and BACKUP_FILE are written from the same in-memory state in the same
// flush, so they die together — as they did on 2026-07-27. The dated snapshots are
// the only independent generation, so they belong in this chain: up to
// SNAPSHOT_SLOT_HOURS stale beats the empty defaults that used to be the only
// other option, and beats a human restoring it by hand.
function recoveryCandidates() {
  const snaps = [];
  for (const dir of SNAPSHOT_DIRS) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch (e) { continue; }   // missing dir is normal
    for (const n of names) {
      if (!n.startsWith('screen-time-data.') || !n.endsWith('.json')) continue;
      const file = path.join(dir, n);
      try { snaps.push({ file, kind: 'snapshot', mtime: fs.statSync(file).mtimeMs }); }
      catch (e) { /* vanished under us */ }
    }
  }
  snaps.sort((a, b) => b.mtime - a.mtime);   // newest snapshot first
  return [{ file: DATA_FILE, kind: 'main' }, { file: BACKUP_FILE, kind: 'backup' }, ...snaps];
}

// Move a copy we could not parse out of the way instead of letting the next flush
// overwrite it. The bytes are evidence — the zeroed pair from 2026-07-27 is what
// identified the real cause, and they would have been gone by morning.
function quarantine(file) {
  try {
    const dir = path.join(app.getPath('userData'), 'corrupt');
    fs.mkdirSync(dir, { recursive: true });
    const dest = path.join(dir, `${path.basename(file)}.${Date.now()}`);
    fs.copyFileSync(file, dest);
    log.warn('store.load.quarantined', { from: file, to: dest });
  } catch (e) {
    log.error('store.load.quarantine_failed', { file, err: e.message });
  }
}

// Walk the chain and return the first copy that parses.
function readBestCopy() {
  const failures = [];
  for (const cand of recoveryCandidates()) {
    let raw;
    try {
      raw = fs.readFileSync(cand.file, 'utf8');
    } catch (e) {
      if (e.code !== 'ENOENT') log.warn('store.load.unreadable', { kind: cand.kind, file: cand.file, err: e.message });
      continue;                                   // a missing copy is normal, not a failure
    }
    const zeroed = looksZeroed(raw);
    try {
      const parsed = JSON.parse(raw);
      log.info('store.load.candidate_ok', {
        kind: cand.kind, file: cand.file, bytes: raw.length,
        days: Object.keys(parsed.days || {}).length,
        habits: (parsed.habits || []).length,
        installedAt: parsed.installedAt,
        skippedBroken: failures.length,
      });
      return { parsed, cand, failures };
    } catch (e) {
      failures.push({ kind: cand.kind, file: cand.file, bytes: raw.length, zeroed });
      log.error('store.load.candidate_corrupt', {
        kind: cand.kind, file: cand.file, bytes: raw.length,
        allZeros: zeroed,
        diagnosis: zeroed
          ? 'file has correct length but no content — unclean shutdown before the page cache flushed (missing fsync)'
          : 'malformed JSON — truncated or partially written',
        head: JSON.stringify(raw.slice(0, 80)),
        err: e.message,
      });
      if (cand.kind !== 'snapshot') quarantine(cand.file);
    }
  }
  return { parsed: null, cand: null, failures };
}

function load() {
  claimOwnership();
  try {
    const { parsed, cand, failures } = readBestCopy();
    if (parsed && failures.length) {
      // We are alive only because of a fallback. Say so loudly — this is the line
      // that should be at the top of the next investigation.
      log.error('store.load.RECOVERED_FROM_FALLBACK', {
        recoveredFrom: cand.kind, file: cand.file,
        lostCopies: failures.map((f) => `${f.kind}${f.zeroed ? '(zeroed)' : '(corrupt)'}`).join(','),
        note: cand.kind === 'snapshot'
          ? 'up to 3h of tracking may be missing — both live copies were unusable'
          : 'main file was unusable, backup carried the data',
      });
    }
    if (parsed !== null) {
      data = Object.assign(defaults(), parsed);
      data.settings = Object.assign(defaults().settings, parsed.settings || {});
      if (parsed.settings?.breakReminder) {
        data.settings.breakReminder = Object.assign(defaults().settings.breakReminder, parsed.settings.breakReminder);
        data.settings.breakReminder.telegram = Object.assign(
          defaults().settings.breakReminder.telegram,
          parsed.settings.breakReminder.telegram || {}
        );
      }
      data.days = parsed.days || {};
      data.goals = parsed.goals || {};
      data.globalLimit = parsed.globalLimit || 0;
      data.goalsSnapshots = parsed.goalsSnapshots || [];
      // Migrate: if no snapshots exist yet, seed one from the current goals.
      // Use today as the effectiveDate so past days without goals aren't counted.
      if (!data.goalsSnapshots.length && (Object.keys(data.goals).length || data.globalLimit)) {
        data.goalsSnapshots = [{ effectiveDate: dateKey(), goals: Object.assign({}, data.goals), globalLimit: data.globalLimit || 0 }];
      }
      // One-time fix: old migration used installedAt as effectiveDate, which retroactively
      // applied goals to days before they were set and inflated the streak.
      // Detect the pattern: single snapshot whose date matches installedAt (not today).
      if (
        data.goalsSnapshots.length === 1 &&
        data.installedAt &&
        data.goalsSnapshots[0].effectiveDate === data.installedAt.split('T')[0] &&
        data.goalsSnapshots[0].effectiveDate < dateKey()
      ) {
        data.goalsSnapshots[0].effectiveDate = dateKey();
        data.streaks = defaults().streaks;
      }
      data.reminders = parsed.reminders || [];
      data.habits = parsed.habits || [];
      data.otherUsers = parsed.otherUsers || [];
      if (parsed.streaks) {
        data.streaks = Object.assign(defaults().streaks, parsed.streaks);
        data.streaks.metDays = parsed.streaks.metDays || {};
        data.streaks.frozenDays = parsed.streaks.frozenDays || {};
      }
      // Deep-merge forest so new keys get defaults while user data survives.
      data.forest = Object.assign(defaults().forest, parsed.forest || {});
      if (parsed.forest) {
        data.forest.distractions = Object.assign(defaults().forest.distractions, parsed.forest.distractions || {});
        data.forest.settings = Object.assign(defaults().forest.settings, parsed.forest.settings || {});
      }
      log.info('store.load.ok', {
        source: cand.kind,
        days: Object.keys(data.days).length,
        firstDay: Object.keys(data.days).sort()[0],
        lastDay: Object.keys(data.days).sort().slice(-1)[0],
        totalHours: +(Object.values(data.days).reduce((s, d) => s + (d.total || 0), 0) / 3600).toFixed(2),
        habits: (data.habits || []).length,
        goals: Object.keys(data.goals || {}).length,
        trees: (data.forest.trees || []).length,
        coins: data.forest.coins,
        streak: data.streaks && data.streaks.current,
        readOnly: isReadOnly(),
      });
    } else if (failures.length) {
      // Copies existed but none parsed. Empty defaults in memory are fine; *saving*
      // them would overwrite every copy with nothing — the exact path that turns one
      // bad read into total loss. Go read-only and let the user decide.
      loadFailed = true;
      log.error('store.load.ALL_COPIES_UNREADABLE', {
        tried: failures.length,
        detail: failures.map((f) => `${f.kind}:${f.bytes}b${f.zeroed ? ':ZEROED' : ''}`).join(' '),
        action: 'saving disabled — originals copied to the corrupt/ folder',
      });
    } else {
      log.info('store.load.fresh_install', { dataFile: DATA_FILE });
    }
  } catch (e) {
    log.error('store.load.threw', { err: e.message, stack: e.stack });
    // Same rule as above: never let a failed read become an empty-defaults save.
    loadFailed = fs.existsSync(DATA_FILE) || fs.existsSync(BACKUP_FILE);
    data = defaults();
  }
  return data;
}

// True when the store is refusing to write, either because it could not read existing
// data or because another live instance owns the file.
function isReadOnly() { return loadFailed || foreignOwner; }

function readOwner() {
  try {
    if (!fs.existsSync(OWNER_FILE)) return null;
    return JSON.parse(fs.readFileSync(OWNER_FILE, 'utf8'));
  } catch (e) { return null; }
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; }       // signal 0 only tests existence
  catch (e) { return e.code === 'EPERM'; }         // alive but owned by someone else
}

// Another instance owns the data if it wrote the owner file recently and is still up.
function ownedByOther() {
  const owner = readOwner();
  if (!owner || owner.pid === process.pid) return false;
  if (Date.now() - (owner.ts || 0) > OWNER_STALE_MS) return false;  // crashed instance
  return pidAlive(owner.pid);
}

function claimOwnership() {
  const prev = readOwner();
  foreignOwner = ownedByOther();
  if (foreignOwner) {
    log.error('store.owner.refused', {
      ownerPid: prev.pid, ownerExe: prev.exe,
      ageMs: Date.now() - (prev.ts || 0),
      me: process.execPath,
      action: 'saving disabled for this instance so it cannot clobber the live one',
    });
    return false;
  }
  if (prev && prev.pid !== process.pid) {
    log.warn('store.owner.taking_over', {
      stalePid: prev.pid, staleExe: prev.exe,
      ageMs: Date.now() - (prev.ts || 0),
      alive: pidAlive(prev.pid),
      why: Date.now() - (prev.ts || 0) > OWNER_STALE_MS ? 'claim expired' : 'owner process is gone',
    });
  }
  try {
    fs.writeFileSync(OWNER_FILE, JSON.stringify({ pid: process.pid, exe: process.execPath, ts: Date.now() }));
    log.info('store.owner.claimed', { exe: process.execPath });
  } catch (e) { log.error('store.owner.claim_failed', { err: e.message }); }
  return true;
}

function releaseOwnership() {
  try {
    const owner = readOwner();
    if (owner && owner.pid === process.pid) {
      fs.unlinkSync(OWNER_FILE);
      log.info('store.owner.released', {});
    } else {
      log.warn('store.owner.release_skipped', { ownerPid: owner && owner.pid, me: process.pid });
    }
  } catch (e) { log.warn('store.owner.release_failed', { err: e.message }); }
}

function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; flush(); }, 4000);
}

// ---- in-force break lock (survives app exit / reboot) ----------------------
// A break lock records its absolute end time (epoch ms). Because that end time
// is wall-clock, the break keeps "ticking" even while the machine is powered
// off — reboot to escape and you just come back to whatever is left (or to no
// lock at all if the whole break elapsed while you were off).
// Durable, not merely synchronous: writeFileSync alone would leave this in the page
// cache, and "survives a hard power-off" is the entire point of the file.
function saveLockState(state) {
  try { writeFileSyncDurable(LOCK_FILE, JSON.stringify(state)); }
  catch (e) { log.error('store.lock.save_failed', { err: e.message, state }); }
}

function readLockState() {
  try {
    if (fs.existsSync(LOCK_FILE)) {
      const s = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));
      log.info('store.lock.read', { ...s, remainingMs: s && s.endsAt ? s.endsAt - Date.now() : null });
      return s;
    }
  } catch (e) { log.error('store.lock.read_failed', { err: e.message }); }
  return null;
}

function clearLockState() {
  try {
    if (fs.existsSync(LOCK_FILE)) { fs.unlinkSync(LOCK_FILE); log.info('store.lock.cleared', {}); }
  } catch (e) { log.error('store.lock.clear_failed', { err: e.message }); }
}

// Keep one copy per 3-hour slot, so a wipe that a guard *doesn't* catch is still
// recoverable. DATA_FILE and BACKUP_FILE are written from the same in-memory state and
// are always the same generation — they protect against a torn write, not bad data.
function snapshotSlot(d = new Date()) {
  const hour = Math.floor(d.getHours() / SNAPSHOT_SLOT_HOURS) * SNAPSHOT_SLOT_HOURS;
  return `${dateKey(d)}_${String(hour).padStart(2, '0')}`;
}

function rollingSnapshot(json) {
  const slot = snapshotSlot();
  if (lastSnapshotSlot === slot) return;
  lastSnapshotSlot = slot;
  for (const dir of SNAPSHOT_DIRS) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `screen-time-data.${slot}.json`);
      // First write of the slot wins: it holds the state as it was before anything
      // in this window had a chance to damage it.
      if (!fs.existsSync(file)) {
        writeFileSyncDurable(file, json);
        log.info('store.snapshot.written', { slot, file, bytes: json.length });
      }
      // Carry the forensic log along with the data it explains, so the record
      // survives losing the whole profile folder (Documents is covered by File
      // History / OneDrive; userData is not). Overwritten each slot — the log
      // only grows, so the newest copy is always the most complete.
      try {
        const src = log.currentFile();
        if (fs.existsSync(src)) {
          fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });
          fs.copyFileSync(src, path.join(dir, 'logs', path.basename(src)));
        }
      } catch (e) { log.warn('store.snapshot.log_copy_failed', { dir, err: e.message }); }
    } catch (e) {
      log.error('store.snapshot.failed', { dir, slot, err: e.message });
    }
  }
}

// Last successful flush, so the next one can notice the payload shrinking — the
// signature of the in-memory state having been reset under us.
const lastFlush = { bytes: 0, days: 0, loggedAt: 0, count: 0 };

function flush() {
  if (loadFailed) {                           // never overwrite data we failed to read
    log.warn('store.flush.blocked', { reason: 'load-failed', pendingDays: Object.keys(data.days).length });
    return;
  }
  if (foreignOwner || ownedByOther()) {       // never clobber a live instance's data
    if (!foreignOwner) {
      const o = readOwner();
      log.error('store.flush.blocked', { reason: 'foreign-owner', ownerPid: o && o.pid, ownerExe: o && o.exe });
    }
    foreignOwner = true;
    return;
  }
  try {
    // Keep the claim fresh so a second instance can tell we are still alive.
    fs.writeFileSync(OWNER_FILE, JSON.stringify({ pid: process.pid, exe: process.execPath, ts: Date.now() }));
  } catch (e) { log.warn('store.flush.owner_refresh_failed', { err: e.message }); }

  const started = Date.now();
  let json;
  try {
    // Write both from the same known-good in-memory snapshot — never copy DATA_FILE's
    // raw bytes into the backup, or a crash-corrupted main file would clobber the one
    // copy we could still recover from.
    json = JSON.stringify(data);
  } catch (e) {
    log.error('store.flush.serialize_failed', { err: e.message, stack: e.stack });
    return;
  }

  const days = Object.keys(data.days).length;
  if (lastFlush.bytes && (json.length < lastFlush.bytes * 0.9 || days < lastFlush.days)) {
    // The guards above are meant to make this impossible. If it ever fires, this is
    // the line that names the bug we have been unable to reproduce.
    log.error('store.flush.SHRANK', {
      wasBytes: lastFlush.bytes, nowBytes: json.length,
      wasDays: lastFlush.days, nowDays: days,
      habits: (data.habits || []).length,
      trees: (data.forest.trees || []).length,
      stack: new Error('flush shrink').stack,
    });
  }

  try {
    rollingSnapshot(json);
    // Temp file + rename so a crash mid-write can't leave a half-written main file.
    // The fsync inside writeFileSyncDurable is what makes the rename mean anything:
    // without it the rename is journaled while the data is not, and a power loss
    // publishes a correctly-named file full of zeros.
    writeFileSyncDurable(TMP_FILE, json);
    fs.renameSync(TMP_FILE, DATA_FILE);
    writeFileSyncDurable(BACKUP_FILE, json);
  } catch (e) {
    log.error('store.flush.failed', { err: e.message, code: e.code, stack: e.stack, bytes: json.length });
    return;
  }

  lastFlush.count++;
  const changed = json.length !== lastFlush.bytes || days !== lastFlush.days;
  // Every flush is logged at most once a minute — enough to be a heartbeat that
  // pins down how far the app got before it died, without 15k lines a day.
  if (changed && Date.now() - lastFlush.loggedAt > 60000) {
    log.info('store.flush.ok', {
      bytes: json.length, deltaBytes: json.length - lastFlush.bytes, days,
      todaySec: Math.round((data.days[dateKey()] || {}).total || 0),
      flushes: lastFlush.count, ms: Date.now() - started,
    });
    lastFlush.loggedAt = Date.now();
  }
  lastFlush.bytes = json.length;
  lastFlush.days = days;
}

function dateKey(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function ensureDay(key) {
  if (!data.days[key]) {
    const now = new Date().toISOString();
    // Freeze what yesterday left over before the new day starts, using the budget
    // settings that were actually in force then. Recomputing it later would let a
    // change to startMinutes today silently rewrite yesterday's leftover.
    const carried = unusedBudgetOn(prevKey(key));
    data.days[key] = { apps: {}, total: 0, firstSeen: now, lastSeen: now, hours: new Array(24).fill(0), studyApps: {}, study: 0 };
    data.budgetRollover = { forDate: key, seconds: carried };
    // Day rollover: one line a day, and the cheapest way to prove the history was
    // still intact at midnight if it is missing the morning after.
    log.info('store.day.created', { day: key, daysNow: Object.keys(data.days).length, rolloverSeconds: Math.round(carried) });
  }
  // Backfill buckets for days created before those features existed.
  if (!Array.isArray(data.days[key].hours)) data.days[key].hours = new Array(24).fill(0);
  if (!data.days[key].studyApps) data.days[key].studyApps = {};
  if (typeof data.days[key].study !== 'number') data.days[key].study = 0;
  return data.days[key];
}

// `isStudy` time still counts toward the displayed totals, but is tracked in a
// parallel bucket so it can be excluded from daily limits / streak checks.
function addTime(appName, seconds, isStudy = false) {
  if (!appName || seconds <= 0) return;
  const day = ensureDay(dateKey());
  day.apps[appName] = (day.apps[appName] || 0) + seconds;
  day.total += seconds;
  day.hours[new Date().getHours()] += seconds;
  if (isStudy) {
    day.studyApps[appName] = (day.studyApps[appName] || 0) + seconds;
    day.study += seconds;
  }
  day.lastSeen = new Date().toISOString();
  scheduleSave();
}

// Undo up to `seconds` previously added by addTime for a specific past day/hour —
// used when the tracker later realizes a stretch it counted was actually idle time
// (idle detection only crosses its threshold after the fact).
function subtractTime(dayKey, appName, seconds, hour, isStudy = false) {
  if (!appName || seconds <= 0) return;
  const day = data.days[dayKey];
  if (!day) return;
  const cur = day.apps[appName] || 0;
  const dec = Math.min(cur, seconds);
  if (dec <= 0) return;
  day.apps[appName] = cur - dec;
  if (day.apps[appName] <= 0) delete day.apps[appName];
  day.total = Math.max(0, day.total - dec);
  if (Array.isArray(day.hours) && hour >= 0 && hour < 24) {
    day.hours[hour] = Math.max(0, day.hours[hour] - dec);
  }
  if (isStudy && day.studyApps) {
    const curStudy = day.studyApps[appName] || 0;
    const decStudy = Math.min(curStudy, dec);
    if (decStudy > 0) {
      day.studyApps[appName] = curStudy - decStudy;
      if (day.studyApps[appName] <= 0) delete day.studyApps[appName];
      day.study = Math.max(0, day.study - decStudy);
    }
  }
  scheduleSave();
}

// DEBUG: subtract `seconds` from today's total, taken off the largest apps first.
// Used by the Dev tools to test streaks/limits without waiting out real time.
function debugSubtractToday(seconds) {
  seconds = Math.max(0, Math.round(Number(seconds) || 0));
  const key = dateKey();
  const day = data.days[key];
  // Dev-only, but it deliberately destroys real recorded time. If today's total ever
  // looks wrong, this line answers "did someone press the debug button?" instantly.
  log.warn('store.debug.subtract_today', { seconds, dayTotalBefore: day && Math.round(day.total) });
  if (seconds <= 0 || !day) return getToday();
  const hour = new Date().getHours();
  let remaining = seconds;
  const appsDesc = Object.entries(day.apps).sort((a, b) => b[1] - a[1]);
  for (const [name, sec] of appsDesc) {
    if (remaining <= 0) break;
    const take = Math.min(sec, remaining);
    subtractTime(key, name, take, hour);
    remaining -= take;
  }
  return getToday();
}

// DEBUG: grant extra streak freezers to a habit (on top of the earned ones).
function debugAddHabitFreezers(id, count) {
  const h = (data.habits || []).find((x) => x.id === id);
  if (!h) return null;
  h.freezerBonus = Math.max(0, (h.freezerBonus || 0) + (Math.round(Number(count)) || 0));
  flush();
  return enrichHabit(h);
}

// ---- "Not Me" sessions (who was using the computer while tracking was off) ----
function startOtherUser(name) {
  if (!data.otherUsers) data.otherUsers = [];
  const open = data.otherUsers.find((e) => !e.endedAt);
  if (open) open.endedAt = new Date().toISOString(); // safety: close a dangling session first
  const entry = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2),
    name: String(name || '').trim().slice(0, 40) || 'Someone else',
    startedAt: new Date().toISOString(),
    endedAt: null,
  };
  data.otherUsers.push(entry);
  flush();
  return entry;
}

function endOtherUser() {
  const open = (data.otherUsers || []).find((e) => !e.endedAt);
  if (!open) return null;
  open.endedAt = new Date().toISOString();
  flush();
  return open;
}

function getOtherUsersLog(limit = 50) {
  return (data.otherUsers || []).slice(-limit).reverse().map((e) => ({
    ...e,
    seconds: Math.round(((e.endedAt ? new Date(e.endedAt) : new Date()) - new Date(e.startedAt)) / 1000),
  }));
}

function getToday() {
  return ensureDay(dateKey());
}

// Aggregate a window of `days` days. `endOffset` shifts the window back in time:
// 0 = window ends today, 7 = window ends 7 days ago, etc. (used by date navigation).
function rangeData(days, endOffset = 0) {
  const result = { apps: {}, total: 0, perDay: [], daysWithData: 0, hours: new Array(24).fill(0), studyApps: {}, study: 0 };
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i - endOffset);
    const key = dateKey(d);
    const day = data.days[key];
    const total = day ? day.total : 0;
    result.perDay.push({ date: key, total });
    if (day && day.total > 0) {
      result.daysWithData++;
      for (const [a, s] of Object.entries(day.apps)) result.apps[a] = (result.apps[a] || 0) + s;
      if (Array.isArray(day.hours)) for (let h = 0; h < 24; h++) result.hours[h] += day.hours[h] || 0;
      if (day.studyApps) for (const [a, s] of Object.entries(day.studyApps)) result.studyApps[a] = (result.studyApps[a] || 0) + s;
      result.study += day.study || 0;
      result.total += day.total;
    }
  }
  return result;
}

// Average screen time per day-of-week over the last `lookback` days.
// Returns 7 entries (Sun..Sat) with avg seconds; flags the lowest non-empty day.
function dayOfWeekStats(lookback = 30) {
  const sums = new Array(7).fill(0);
  const counts = new Array(7).fill(0);
  for (let i = 0; i < lookback; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const day = data.days[dateKey(d)];
    if (day && day.total > 0) {
      sums[d.getDay()] += day.total;
      counts[d.getDay()]++;
    }
  }
  const week = sums.map((s, i) => ({ dow: i, avg: counts[i] ? Math.round(s / counts[i]) : 0, days: counts[i] }));
  const active = week.filter((w) => w.days > 0);
  let lowest = null, highest = null;
  if (active.length) {
    lowest = active.reduce((m, w) => (w.avg < m.avg ? w : m));
    highest = active.reduce((m, w) => (w.avg > m.avg ? w : m));
  }
  return { week, lowest, highest };
}

// Compare the average of the last 7 days against the 7 before that.
function trendAnalysis() {
  const recent = rangeData(7, 0);
  const prior = rangeData(7, 7);
  const recentAvg = recent.daysWithData ? recent.total / recent.daysWithData : 0;
  const priorAvg = prior.daysWithData ? prior.total / prior.daysWithData : 0;
  let pct;
  if (priorAvg > 0) pct = Math.round(((recentAvg - priorAvg) / priorAvg) * 100);
  else pct = recentAvg > 0 ? 100 : 0;
  return {
    recentAvg: Math.round(recentAvg),
    priorAvg: Math.round(priorAvg),
    pct,
    direction: pct > 5 ? 'up' : pct < -5 ? 'down' : 'flat'
  };
}

function dayTotal(offset = 0) {
  const d = new Date();
  d.setDate(d.getDate() - offset);
  const day = data.days[dateKey(d)];
  return day ? day.total : 0;
}

function getGoals() { return data.goals || {}; }

// Record current goals + globalLimit as a snapshot effective today.
// If today already has a snapshot, update it in place.
function recordGoalsSnapshot() {
  if (!data.goalsSnapshots) data.goalsSnapshots = [];
  const today = dateKey();
  const existing = data.goalsSnapshots.find((s) => s.effectiveDate === today);
  if (existing) {
    existing.goals = Object.assign({}, data.goals);
    existing.globalLimit = data.globalLimit || 0;
  } else {
    data.goalsSnapshots.push({ effectiveDate: today, goals: Object.assign({}, data.goals), globalLimit: data.globalLimit || 0 });
  }
}

// Return the goals and globalLimit that were in effect on a given day.
function getGoalsForDate(key) {
  const snapshots = data.goalsSnapshots || [];
  const applicable = snapshots
    .filter((s) => s.effectiveDate <= key)
    .sort((a, b) => b.effectiveDate.localeCompare(a.effectiveDate))[0];
  if (applicable) return { goals: applicable.goals || {}, globalLimit: applicable.globalLimit || 0 };
  // No snapshot predates this key — no goals were active
  return { goals: {}, globalLimit: 0 };
}

function setGoal(appName, targetSeconds) {
  if (!data.goals) data.goals = {};
  if (!targetSeconds || targetSeconds <= 0) {
    delete data.goals[appName];
  } else {
    data.goals[appName] = Math.round(targetSeconds);
  }
  recordGoalsSnapshot();
  flush();
  return data.goals;
}

function getPlaySecondsForDay(key) {
  const day = data.days[key];
  if (!day) return 0;
  return Math.max(0, (day.total || 0) - (day.study || 0));
}
function getTodayPlaySeconds() { return getPlaySecondsForDay(dateKey()); }

function prevKey(key) {
  const d = new Date(`${key}T12:00:00`);
  d.setDate(d.getDate() - 1);
  return dateKey(d);
}

// How much of `key`'s allowance went unused. Requires an actual tracked day; no
// day record means no leftover, rather than assuming a fresh install's silent
// "day" was entirely unused.
function unusedBudgetOn(key) {
  const cfg = (data.settings && data.settings.timeBudget) || {};
  if (!data.days[key]) return 0;
  const start = Math.max(0, Math.round((cfg.startMinutes || 0) * 60));
  return Math.max(0, start + getTimeBudgetEarnedSecondsForDay(key) - getPlaySecondsForDay(key));
}

// Yesterday's unused allowance, if rollover is on. Frozen into data.budgetRollover
// by ensureDay() the moment the new day is created, so it survives restarts and
// isn't rewritten when today's startMinutes changes. The live fallback only runs
// for a day record created before this was stored (i.e. right after upgrading).
function getRolloverSecondsFromYesterday() {
  const cfg = (data.settings && data.settings.timeBudget) || {};
  if (cfg.rollover === false) return 0;
  const today = dateKey();
  const saved = data.budgetRollover;
  if (saved && saved.forDate === today) return Math.max(0, saved.seconds || 0);
  return unusedBudgetOn(prevKey(today));
}

function getTimeBudgetStatus() {
  const cfg = (data.settings && data.settings.timeBudget) || { enabled: false, startMinutes: 60, rollover: true };
  const startSeconds = Math.max(0, Math.round((cfg.startMinutes || 0) * 60));
  const earnedSeconds = getTimeBudgetEarnedSecondsToday();
  const rolloverSeconds = getRolloverSecondsFromYesterday();
  return {
    enabled: !!cfg.enabled,
    startMinutes: cfg.startMinutes || 0,
    rollover: cfg.rollover !== false,
    startSeconds,
    earnedSeconds,
    rolloverSeconds,
    budgetSeconds: startSeconds + earnedSeconds + rolloverSeconds,
    usedSeconds: getTodayPlaySeconds(),
  };
}

function checkGoalsMet(key) {
  const { goals, globalLimit } = getGoalsForDate(key);
  if (Object.keys(goals).length === 0 && !globalLimit) return null; // nothing to enforce
  const day = data.days[key];
  if (!day) return null; // no tracking that day => neutral, doesn't count toward the streak
  const studyApps = day.studyApps || {};
  const playTotal = day.total - (day.study || 0); // study time doesn't count against limits
  if (globalLimit && playTotal > globalLimit) return false; // total screen time exceeded
  for (const [appName, targetSec] of Object.entries(goals)) {
    const actual = ((day.apps && day.apps[appName]) || 0) - (studyApps[appName] || 0);
    if (actual > targetSec) return false; // exceeded limit
  }
  return true;
}

// Streaks start with 5 freezers and earn another every 3 met days. When a day is
// missed, a freezer is spent to keep the streak alive (the streak drops by one
// instead of resetting).
const FREEZER_EVERY = 3;
const STARTING_FREEZERS = 5;

function syncStreaks() {
  if (!data.streaks) data.streaks = defaults().streaks;
  if (!data.streaks.metDays) data.streaks.metDays = {};
  const today = dateKey();
  const goals = data.goals || {};
  // Habits now feed the same streak as screen-time goals, so the streak is active when
  // either is configured.
  const active = Object.keys(goals).length > 0 || (data.globalLimit || 0) > 0 || habitsConfigured();
  if (active) {
    // Re-evaluate the last 30 days so the calendar stays current
    for (let i = 30; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      data.streaks.metDays[dateKey(d)] = checkDayMet(dateKey(d));
    }
  }

  // Trim metDays to a 90-day rolling window so stale entries from old goals/habits
  // don't inflate the streak or best count.
  const cutoff = dateKey(new Date(Date.now() - 90 * 86400000));
  for (const k of Object.keys(data.streaks.metDays)) {
    if (k < cutoff) delete data.streaks.metDays[k];
  }

  // Forward-simulate from the oldest evaluated day to today so freezers
  // accrue and get spent deterministically.
  const keys = Object.keys(data.streaks.metDays).sort();
  let streak = 0, freezers = STARTING_FREEZERS, best = 0;
  const frozen = {};
  for (const k of keys) {
    const met = data.streaks.metDays[k];
    if (met === true) {
      streak++;
      if (streak % FREEZER_EVERY === 0) freezers++;
    } else if (met === false) {
      if (freezers > 0) {
        freezers--;
        frozen[k] = true;
        // freezer saves the streak and leaves the current count intact
      } else {
        streak = 0;
        freezers = 0;
      }
    }
    // null/undefined => neutral day, leaves the streak untouched
    if (streak > best) best = streak;
  }

  data.streaks.current = streak;
  data.streaks.freezers = freezers;
  data.streaks.frozenDays = frozen;
  data.streaks.best = best;
  data.streaks.lastCheckedDate = today;
}

function getGlobalLimit() { return data.globalLimit || 0; }

function setGlobalLimit(seconds) {
  data.globalLimit = (!seconds || seconds <= 0) ? 0 : Math.round(seconds);
  recordGoalsSnapshot();
  flush();
  return data.globalLimit;
}

function getStreaks() {
  syncStreaks();
  scheduleSave();
  return data.streaks;
}

function weeklyReport() {
  syncStreaks();
  const result = { days: [], total: 0, apps: {}, prevWeekTotal: 0 };
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = dateKey(d);
    const day = data.days[key];
    const dayTotal = day ? day.total : 0;
    const apps = day ? (day.apps || {}) : {};
    const goalMet = (data.streaks.metDays && data.streaks.metDays[key]) ?? null;
    result.days.push({ date: key, total: dayTotal, apps, goalMet });
    result.total += dayTotal;
    for (const [a, s] of Object.entries(apps)) result.apps[a] = (result.apps[a] || 0) + s;
  }
  for (let i = 13; i >= 7; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const day = data.days[dateKey(d)];
    result.prevWeekTotal += day ? day.total : 0;
  }
  return result;
}

function getReminders() { return data.reminders || []; }

function setReminder(r) {
  if (!data.reminders) data.reminders = [];
  const idx = data.reminders.findIndex((x) => x.id === r.id);
  if (idx >= 0) data.reminders[idx] = r;
  else data.reminders.push(r);
  flush();
  return data.reminders;
}

function deleteReminder(id) {
  data.reminders = (data.reminders || []).filter((r) => r.id !== id);
  flush();
  return data.reminders;
}

// ---------- habits ----------
// Habits are user-defined recurring actions, measured either by count ("Drink water
// 8×/day") or by time ("Read 30 min/day"). Every completion is stored as a timestamped
// entry; the daily/weekly aggregates, streaks, XP, levels and hour-of-day stats are all
// derived from those entries so nothing can drift out of sync. Manual entries can be
// backdated to a chosen day & time, which feeds both the per-habit and main streak.
const HABIT_XP_PER_UNIT = { count: 10, minutes: 1, custom: 10 };
const HABIT_TARGET_MAX = { count: 50, minutes: 1440, custom: 100 };
const HABIT_FREEZERS_START = 3;   // each habit starts with this many freeze periods
const HABIT_FREEZER_EVERY  = 3;   // earn one more freeze period every N consecutive met periods

// Cumulative XP needed grows by a fixed step each level, giving a gentle ramp:
// L2 @ 50xp, L3 @ 125, L4 @ 225, L5 @ 350 …
function levelFromXp(xp) {
  let level = 1, acc = 0, need = 50;
  while (xp >= acc + need) { acc += need; level++; need += 25; }
  return { level, xpInto: xp - acc, xpForNext: need };
}

// Sunday-anchored start of the week containing `d`.
function weekStart(d = new Date()) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  x.setDate(x.getDate() - x.getDay());
  return x;
}

// Longest run of consecutive met periods. `keys` are date strings (day for daily,
// week-start for weekly); `stepDays` is the spacing that counts as "consecutive".
function bestRun(keys, stepDays) {
  const sorted = [...keys].sort();
  let best = 0, cur = 0, prev = null;
  for (const k of sorted) {
    const d = new Date(k + 'T00:00:00');
    if (prev && Math.round((d - prev) / 86400000) === stepDays) cur++;
    else cur = 1;
    if (cur > best) best = cur;
    prev = d;
  }
  return best;
}

function habitUnit(h) { return h.unit === 'minutes' ? 'minutes' : h.unit === 'custom' ? 'custom' : 'count'; }
function clampTarget(unit, v) { const n = parseInt(v, 10); return isNaN(n) ? 1 : Math.max(0, Math.min(HABIT_TARGET_MAX[unit] || 50, n)); }

// Periods (days, or week-starts for weekly habits) the user has explicitly paused —
// a deliberate day/week off that is neutral for both the habit's own streak and the
// main streak, unlike a freezer which is spent automatically to save a real miss.
function habitPausedSet(h) {
  return new Set(Array.isArray(h.pausedPeriods) ? h.pausedPeriods : []);
}

// Set of paused period keys, expanded to include an indefinite ("forever")
// pause from its start period through today/this-week — bounded to "now" on
// purpose, so this stays cheap instead of pre-generating years of future keys.
function effectivePausedSet(h) {
  const set = habitPausedSet(h);
  if (h.pausedForever && h.pausedForeverSince) {
    const weekly = h.freqType === 'weekly';
    const step = weekly ? 7 : 1;
    let d = new Date(h.pausedForeverSince + 'T00:00:00');
    const now = new Date();
    let guard = 0;
    while (d <= now && guard < 3660) {
      set.add(dateKey(d));
      d.setDate(d.getDate() + step);
      guard++;
    }
  }
  return set;
}

function currentPeriodKey(weekly) {
  return weekly ? dateKey(weekStart()) : dateKey();
}

// Migrate any legacy day-count `log` into the timestamped `entries` model (one entry
// per day at noon), then return the entries array (the single source of truth).
function habitEntries(h) {
  if (!Array.isArray(h.entries)) {
    const e = [];
    if (h.log && typeof h.log === 'object') {
      for (const [day, amt] of Object.entries(h.log)) {
        if (amt > 0) e.push({ ts: `${day}T12:00:00.000`, amount: amt });
      }
    }
    h.entries = e;
    delete h.log;
  }
  return h.entries;
}

// Sum entries per calendar day -> { 'YYYY-MM-DD': totalAmount }.
function dayMapOf(h) {
  const map = {};
  for (const en of habitEntries(h)) {
    const k = dateKey(new Date(en.ts));
    // rounded because amounts can be fractional (0.25, 0.5) — raw float sums
    // drift just under a target and would silently fail a met-day check.
    map[k] = Math.round(((map[k] || 0) + (en.amount || 0)) * 100) / 100;
  }
  return map;
}

function dailyStreakMap(map, target) {
  let streak = 0;
  for (let i = 0; i < 366; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const c = map[dateKey(d)] || 0;
    if (c >= target) streak++;
    else if (i === 0) continue; // today still in progress — don't break the streak yet
    else break;
  }
  return streak;
}

function weekSumMap(map, ws) {
  let sum = 0;
  for (let j = 0; j < 7; j++) {
    const d = new Date(ws);
    d.setDate(d.getDate() + j);
    sum += map[dateKey(d)] || 0;
  }
  return sum;
}

function weeklyStreakMap(map, target) {
  let streak = 0;
  for (let i = 0; i < 260; i++) {
    const ws = weekStart();
    ws.setDate(ws.getDate() - i * 7);
    if (weekSumMap(map, ws) >= target) streak++;
    else if (i === 0) continue; // current week still in progress
    else break;
  }
  return streak;
}

// Compute streak with per-habit freeze periods (daily or weekly).
// Returns { streak, freezers, frozenPeriods } where frozenPeriods is an array of
// date strings (YYYY-MM-DD) that were saved by a freeze.
// Walks the full history forward so earnings and spends stay consistent.
function calcHabitStreak(map, createdAt, target, weekly, pausedSet = new Set(), bonusFreezers = 0) {
  const today = dateKey();
  const created = createdAt ? dateKey(new Date(createdAt)) : today;

  // Build ordered list of periods to evaluate (daily: each day; weekly: each week-start).
  const periods = [];
  if (weekly) {
    const ws0 = weekStart(new Date(created + 'T00:00:00'));
    const wsNow = weekStart();
    for (let cur = new Date(ws0); cur <= wsNow; cur.setDate(cur.getDate() + 7)) {
      periods.push({ key: dateKey(cur), ws: new Date(cur) });
    }
  } else {
    const d = new Date(created + 'T00:00:00');
    const now = new Date();
    while (d <= now) {
      periods.push({ key: dateKey(d) });
      d.setDate(d.getDate() + 1);
    }
  }

  let streak = 0, freezers = HABIT_FREEZERS_START + Math.max(0, bonusFreezers), metRun = 0;
  const frozenPeriods = [];

  for (const p of periods) {
    const isToday = weekly
      ? p.key === dateKey(weekStart())  // current (in-progress) week
      : p.key === today;

    if (pausedSet.has(p.key)) continue; // paused period — a day/week off, neutral for the streak

    const met = weekly
      ? weekSumMap(map, p.ws) >= target
      : (map[p.key] || 0) >= target;

    if (met) {
      streak++;
      metRun++;
      if (metRun > 0 && metRun % HABIT_FREEZER_EVERY === 0) freezers++;
    } else if (isToday) {
      // current period still in progress — don't penalise
    } else {
      if (freezers > 0) {
        freezers--;
        frozenPeriods.push(p.key);
        // streak continues but no +1 for this period; metRun resets
        metRun = 0;
      } else {
        streak = 0;
        metRun = 0;
        frozenPeriods.length = 0; // discard; old frozen periods pre-date the current streak
      }
    }
  }

  return { streak, freezers, frozenPeriods };
}

// Decorate a stored habit with all derived stats the UI needs.
function enrichHabit(h) {
  const unit = habitUnit(h);
  const target = clampTarget(unit, h.target);
  const trackOnly = target === 0; // no goal — just log freely
  const effectiveTarget = trackOnly ? 1 : target; // for streak/met calculations
  const today = dateKey();
  const weekly = h.freqType === 'weekly';
  const map = dayMapOf(h);
  const entries = habitEntries(h);

  let totalDone = 0;
  for (const v of Object.values(map)) totalDone += v;

  const pausedSet = effectivePausedSet(h);
  const paused = pausedSet.has(currentPeriodKey(weekly));

  // How much of the current pause is still ahead, so the UI can say "paused for N"
  // instead of implying it has to be renewed today.
  let pausedPeriodsLeft = 0;
  if (paused) {
    const step = weekly ? 7 : 1;
    const d = weekly ? weekStart() : new Date();
    while (pausedSet.has(dateKey(d)) && pausedPeriodsLeft < 400) {
      pausedPeriodsLeft++;
      d.setDate(d.getDate() + step);
    }
  }

  let periodCount, best;
  const { streak, freezers, frozenPeriods } = calcHabitStreak(map, h.createdAt, effectiveTarget, weekly, pausedSet, h.freezerBonus || 0);
  if (weekly) {
    periodCount = weekSumMap(map, weekStart());
    const metWeeks = [];
    for (let i = 0; i < 260; i++) {
      const ws = weekStart();
      ws.setDate(ws.getDate() - i * 7);
      if (weekSumMap(map, ws) >= effectiveTarget) metWeeks.push(dateKey(ws));
    }
    best = bestRun(metWeeks, 7);
  } else {
    periodCount = map[today] || 0;
    best = bestRun(Object.keys(map).filter((k) => map[k] >= effectiveTarget), 1);
  }

  const xp = Math.round(totalDone * HABIT_XP_PER_UNIT[unit]);
  const lvl = levelFromXp(xp);

  // last 14 days of activity for the mini-calendar / heatmap strip
  const history = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const k = dateKey(d);
    const c = map[k] || 0;
    history.push({ date: k, count: c, met: trackOnly ? c > 0 : c >= target, dow: d.getDay() });
  }

  // hour-of-day distribution: when do completions actually happen?
  const hours = new Array(24).fill(0);
  for (const en of entries) hours[new Date(en.ts).getHours()] += en.amount || 0;
  let peakHour = -1, peakVal = 0;
  hours.forEach((v, i) => { if (v > peakVal) { peakVal = v; peakHour = i; } });

  const frozenSet = new Set(frozenPeriods);
  // mark frozen/paused periods in history strip (weekly habits pause a whole week,
  // so a day is paused if the week it falls in was paused)
  const historyWithFreeze = history.map((d) => {
    const periodKey = weekly ? dateKey(weekStart(new Date(d.date + 'T00:00:00'))) : d.date;
    return { ...d, frozen: frozenSet.has(d.date), paused: pausedSet.has(periodKey) };
  });

  return {
    id: h.id,
    name: h.name,
    emoji: h.emoji,
    color: h.color,
    freqType: weekly ? 'weekly' : 'daily',
    unit,
    customUnit: h.customUnit,
    target,
    timeReward: h.timeReward || 0,
    trackOnly,
    createdAt: h.createdAt,
    todayCount: map[today] || 0,
    periodCount,
    periodTarget: target,
    periodDone: trackOnly ? periodCount > 0 : periodCount >= target,
    streak,
    bestStreak: Math.max(best, streak),
    freezers,
    frozenPeriods,
    paused,
    pausedForever: !!h.pausedForever,
    pausedPeriodsLeft,
    totalDone,
    entryCount: entries.length,
    xp,
    level: lvl.level,
    xpInto: lvl.xpInto,
    xpForNext: lvl.xpForNext,
    history: historyWithFreeze,
    hours,
    peakHour
  };
}

function getHabits() {
  return (data.habits || []).map(enrichHabit);
}

function addHabit(h) {
  if (!data.habits) data.habits = [];
  const unit = h.unit === 'minutes' ? 'minutes' : h.unit === 'custom' ? 'custom' : 'count';
  const habit = {
    id: h.id || (Date.now().toString(36) + Math.random().toString(36).slice(2)),
    name: (h.name || 'Habit').toString().slice(0, 60),
    emoji: h.emoji || '✅',
    color: h.color || '#2e9bff',
    freqType: h.freqType === 'weekly' ? 'weekly' : 'daily',
    unit,
    customUnit: unit === 'custom' ? (String(h.customUnit || '').trim().slice(0, 20) || 'units') : undefined,
    target: clampTarget(unit, h.target),
    timeReward: Math.max(0, parseInt(h.timeReward, 10) || 0),
    createdAt: new Date().toISOString(),
    entries: []
  };
  data.habits.push(habit);
  flush();
  return enrichHabit(habit);
}

function updateHabit(id, partial) {
  const h = (data.habits || []).find((x) => x.id === id);
  if (!h) return null;
  partial = partial || {};
  if (partial.name != null) h.name = String(partial.name).slice(0, 60);
  if (partial.emoji != null) h.emoji = partial.emoji;
  if (partial.color != null) h.color = partial.color;
  if (partial.freqType != null) h.freqType = partial.freqType === 'weekly' ? 'weekly' : 'daily';
  if (partial.unit != null) h.unit = partial.unit === 'minutes' ? 'minutes' : partial.unit === 'custom' ? 'custom' : 'count';
  if (partial.customUnit != null) h.customUnit = String(partial.customUnit).trim().slice(0, 20) || 'units';
  if (partial.target != null) h.target = clampTarget(habitUnit(h), partial.target);
  if (partial.timeReward != null) h.timeReward = Math.max(0, parseInt(partial.timeReward, 10) || 0);
  flush();
  return enrichHabit(h);
}

function deleteHabit(id) {
  const gone = (data.habits || []).find((x) => x.id === id);
  data.habits = (data.habits || []).filter((x) => x.id !== id);
  // Destructive and irreversible from the UI — always worth a line.
  log.warn('store.habit.deleted', {
    id, name: gone && gone.name, entries: gone && (gone.entries || []).length,
    remaining: data.habits.length,
  });
  flush();
  return getHabits();
}

// Toggle a deliberate day/week off for the current period (today for daily habits,
// this week for weekly ones). Unlike a freezer, this is manual and doesn't cost
// anything — it just excludes the period from both the habit's own streak and the
// main streak instead of counting it as a miss.
// `periods` > 1 pauses that many periods in a row starting now (days for a daily
// habit, weeks for a weekly one), so a break longer than a day doesn't have to be
// re-armed every morning. Toggling while paused ends the whole run, not just today.
function toggleHabitPause(id, periods = 1) {
  const h = (data.habits || []).find((x) => x.id === id);
  if (!h) return null;
  if (!Array.isArray(h.pausedPeriods)) h.pausedPeriods = [];
  const weekly = h.freqType === 'weekly';
  const key = currentPeriodKey(weekly);

  if (h.pausedForever || h.pausedPeriods.includes(key)) {
    // Resuming (from either an indefinite pause or a dated one): clear the
    // forever flag and drop the current period and everything still ahead of
    // it, so one click cancels the rest of a multi-day pause too.
    h.pausedForever = false;
    h.pausedForeverSince = undefined;
    h.pausedPeriods = h.pausedPeriods.filter((k) => k < key);
  } else if (periods === 'forever') {
    h.pausedForever = true;
    h.pausedForeverSince = key; // period this indefinite pause started from
  } else {
    const n = Math.min(Math.max(Math.round(Number(periods)) || 1, 1), 365);
    const start = weekly ? weekStart() : new Date();
    for (let i = 0; i < n; i++) {
      const d = new Date(start);
      d.setDate(d.getDate() + i * (weekly ? 7 : 1));
      const k = dateKey(d);
      if (!h.pausedPeriods.includes(k)) h.pausedPeriods.push(k);
    }
    h.pausedPeriods.sort();
  }
  flush();
  return enrichHabit(h);
}

// Record a completion. `amount` > 0 adds it; < 0 undoes that much from today.
// `when` (optional) = { date: 'YYYY-MM-DD', time: 'HH:MM' } to backdate the entry for
// statistics; omitted means "now".
function logHabit(id, amount = 1, when = null) {
  const h = (data.habits || []).find((x) => x.id === id);
  if (!h) return null;
  const entries = habitEntries(h);
  amount = Math.round((Number(amount) || 0) * 100) / 100; // fractional logs allowed (0.25, 0.5)

  if (amount > 0) {
    let ts;
    if (when && when.date) {
      const time = (when.time && /^\d{2}:\d{2}$/.test(when.time)) ? when.time : '12:00';
      ts = new Date(`${when.date}T${time}:00`).toISOString();
    } else {
      ts = new Date().toISOString();
    }
    entries.push({ ts, amount });
  } else if (amount < 0) {
    // Undo: peel `-amount` off today's most recent entries.
    let remove = -amount;
    const today = dateKey();
    for (let i = entries.length - 1; i >= 0 && remove > 0; i--) {
      if (dateKey(new Date(entries[i].ts)) !== today) continue;
      if (entries[i].amount <= remove) { remove -= entries[i].amount; entries.splice(i, 1); }
      else { entries[i].amount -= remove; remove = 0; }
    }
  }
  flush();
  return enrichHabit(h);
}

// How many screen-time minutes a single log entry of `amount` earns for habit
// `h`. Flat "per 1" scaling for every habit type: count/custom earns
// timeReward per unit logged, minutes habits earn timeReward per minute logged.
function timeRewardMinutesFor(h, amount) {
  const reward = Math.max(0, Number(h.timeReward) || 0);
  if (!reward || !(amount > 0)) return 0;
  return reward * amount;
}

// Sum of timeReward minutes across every positive habit-log entry made on the
// given day, for habits that have a reward configured. Feeds the time-budget
// lock (see timeBudget.js) — every logged completion tops up that day's
// screen-time allowance.
function getTimeBudgetEarnedSecondsForDay(key) {
  let sec = 0;
  for (const h of (data.habits || [])) {
    if (!(Number(h.timeReward) > 0)) continue;
    for (const en of habitEntries(h)) {
      if (en.amount > 0 && dateKey(new Date(en.ts)) === key) sec += timeRewardMinutesFor(h, en.amount) * 60;
    }
  }
  return sec;
}
function getTimeBudgetEarnedSecondsToday() {
  return getTimeBudgetEarnedSecondsForDay(dateKey());
}

// ---- main-streak unification ----
// Daily habits are strict: a past day fails if any daily habit that existed then was
// not fully met. Weekly habits are judged once, on the Saturday that closes their week.
// The current (in-progress) day/week is never marked as failed — only "pending".
// A day obligates a habit if the habit already existed then, OR there is a logged
// entry on that day (so backdated completions count, but creating a habit never
// retroactively fails the days before you started it).
function dailyHabitsState(key) {
  const dailies = (data.habits || []).filter((h) => h.freqType === 'daily');
  if (!dailies.length) return 'na';
  const today = dateKey();
  let any = false, allMet = true;
  for (const h of dailies) {
    const map = dayMapOf(h);
    const created = h.createdAt ? dateKey(new Date(h.createdAt)) : key;
    if (key < created && !(map[key] > 0)) continue; // didn't exist yet and nothing logged
    if (clampTarget(habitUnit(h), h.target) === 0) continue; // track-only habit never blocks streak
    if (effectivePausedSet(h).has(key)) continue; // paused that day — doesn't obligate the main streak either
    any = true;
    if ((map[key] || 0) < clampTarget(habitUnit(h), h.target)) allMet = false;
  }
  if (!any) return 'na';
  if (allMet) return true;
  return key >= today ? 'pending' : false; // today still in progress => not a miss yet
}

function weeklyHabitsState(key) {
  const d = new Date(key + 'T00:00:00');
  if (d.getDay() !== 6) return 'na';                 // only Saturday represents its week
  const ws = weekStart(d);
  if (dateKey(weekStart()) === dateKey(ws)) return 'na'; // current week not finished
  const weeklies = (data.habits || []).filter((h) => h.freqType === 'weekly');
  const wsKey = dateKey(ws);
  let any = false;
  for (const h of weeklies) {
    const created = h.createdAt ? dateKey(new Date(h.createdAt)) : key;
    const sum = weekSumMap(dayMapOf(h), ws);
    if (wsKey < created && !(sum > 0)) continue; // habit didn't exist that week, nothing logged
    if (clampTarget(habitUnit(h), h.target) === 0) continue; // track-only habit never blocks streak
    if (effectivePausedSet(h).has(wsKey)) continue; // paused that week — doesn't obligate the main streak either
    any = true;
    if (sum < clampTarget(habitUnit(h), h.target)) return false;
  }
  return any ? true : 'na';
}

// Combine screen-time goals + daily habits + weekly-habit week-ends into one verdict.
// false beats everything (a real miss); a still-pending piece keeps the day neutral.
function checkDayMet(key) {
  const goals = checkGoalsMet(key); // null | true | false
  const states = [goals === null ? 'na' : goals, dailyHabitsState(key), weeklyHabitsState(key)];
  const real = states.filter((s) => s !== 'na');
  if (!real.length) return null;
  if (real.some((s) => s === false)) return false;
  if (real.some((s) => s === 'pending')) return null;
  return true;
}

function habitsConfigured() {
  return (data.habits || []).length > 0;
}

function getSettings() { return data.settings; }
function setSettings(partial) {
  partial = partial || {};
  const next = Object.assign({}, data.settings, partial);
  // breakReminder is nested — merge it so partial updates don't drop other keys
  if (partial.breakReminder) {
    next.breakReminder = Object.assign({}, data.settings.breakReminder, partial.breakReminder);
    // telegram is a second level of nesting — merge it too so a partial update
    // (e.g. just flipping introSent) doesn't wipe the token / chat ids.
    if (partial.breakReminder.telegram) {
      next.breakReminder.telegram = Object.assign(
        {}, data.settings.breakReminder.telegram, partial.breakReminder.telegram
      );
    }
  }
  if (partial.timeBudget) {
    next.timeBudget = Object.assign({}, data.settings.timeBudget, partial.timeBudget);
  }
  // Log which keys actually moved, with the token redacted — settings changes are a
  // prime suspect whenever behaviour changes "for no reason".
  const changed = {};
  for (const k of Object.keys(partial)) {
    if (k === 'breakReminder') continue;      // nested; summarised below
    if (JSON.stringify(data.settings[k]) !== JSON.stringify(next[k])) changed[k] = next[k];
  }
  if (partial.breakReminder) {
    const br = { ...next.breakReminder };
    if (br.telegram) br.telegram = { ...br.telegram, botToken: br.telegram.botToken ? '<set>' : '' };
    changed.breakReminder = br;
  }
  if (Object.keys(changed).length) log.info('store.settings.changed', changed);
  data.settings = next;
  flush();
  return data.settings;
}

// ---------------- forest (focus-timer gamification) ----------------
function getForest() {
  if (!data.forest) data.forest = defaults().forest;
  return data.forest;
}

// Public view: everything the renderer needs (activeSession stays internal).
function getForestData() {
  const f = getForest();
  return {
    coins: f.coins,
    coinsEarned: f.coinsEarned,
    unlockedSpecies: f.unlockedSpecies,
    selectedSpecies: f.selectedSpecies,
    trees: f.trees,
    tags: f.tags,
    tasks: f.tasks,
    distractions: f.distractions,
    achievements: f.achievements,
    settings: f.settings
  };
}

function forestAddTree(tree) {
  const f = getForest();
  f.trees.push(tree);
  if (tree.taskId) {
    const task = f.tasks.find((t) => t.id === tree.taskId);
    if (task && tree.result === 'success') {
      task.focusSec += tree.actualSec;
      task.treeCount += 1;
    }
  }
  scheduleSave();
  return tree;
}

function forestAddCoins(n) {
  const f = getForest();
  f.coins += n;
  if (n > 0) f.coinsEarned += n;
  scheduleSave();
  return f.coins;
}

function forestBuySpecies(id, price) {
  const f = getForest();
  if (f.unlockedSpecies.includes(id)) return { ok: false, reason: 'owned', coins: f.coins };
  if (f.coins < price) return { ok: false, reason: 'coins', coins: f.coins };
  f.coins -= price;
  f.unlockedSpecies.push(id);
  scheduleSave();
  return { ok: true, coins: f.coins };
}

function forestSelectSpecies(id) {
  const f = getForest();
  if (f.unlockedSpecies.includes(id)) { f.selectedSpecies = id; scheduleSave(); }
  return f.selectedSpecies;
}

function forestSetDistractions(d) {
  const f = getForest();
  f.distractions = {
    mode: d.mode === 'allowlist' ? 'allowlist' : 'blocklist',
    apps: Array.isArray(d.apps) ? d.apps.filter((a) => typeof a === 'string' && a.trim()).map((a) => a.trim()) : []
  };
  scheduleSave();
  return f.distractions;
}

function forestSetTags(tags) {
  const f = getForest();
  if (Array.isArray(tags)) {
    f.tags = tags.filter((t) => typeof t === 'string' && t.trim()).map((t) => t.trim()).slice(0, 20);
    if (!f.tags.length) f.tags = ['Focus'];
    scheduleSave();
  }
  return f.tags;
}

function forestSetSettings(partial) {
  const f = getForest();
  f.settings = Object.assign({}, f.settings, partial || {});
  scheduleSave();
  return f.settings;
}

function forestSetActiveSession(snapshot) {
  getForest().activeSession = snapshot;
  scheduleSave();
}

function forestUnlockAchievement(id) {
  const f = getForest();
  if (f.achievements[id]) return false;
  f.achievements[id] = new Date().toISOString();
  scheduleSave();
  return true;
}

function forestAddTask(title) {
  const f = getForest();
  const t = {
    id: 'task_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    title: String(title || '').trim().slice(0, 120),
    done: false,
    createdAt: new Date().toISOString(),
    doneAt: null,
    focusSec: 0,
    treeCount: 0
  };
  if (!t.title) return null;
  f.tasks.push(t);
  scheduleSave();
  return t;
}

function forestToggleTask(id) {
  const f = getForest();
  const t = f.tasks.find((x) => x.id === id);
  if (!t) return null;
  t.done = !t.done;
  t.doneAt = t.done ? new Date().toISOString() : null;
  scheduleSave();
  return t;
}

function forestDeleteTask(id) {
  const f = getForest();
  f.tasks = f.tasks.filter((x) => x.id !== id);
  scheduleSave();
  return true;
}

module.exports = {
  DATA_FILE,
  load,
  flush,
  isReadOnly,
  releaseOwnership,
  saveLockState,
  readLockState,
  clearLockState,
  dateKey,
  addTime,
  subtractTime,
  debugSubtractToday,
  startOtherUser,
  endOtherUser,
  getOtherUsersLog,
  getToday,
  rangeData,
  dayTotal,
  getSettings,
  setSettings,
  getGoals,
  setGoal,
  getGlobalLimit,
  setGlobalLimit,
  getTimeBudgetStatus,
  getTodayPlaySeconds,
  timeRewardMinutesFor,
  getStreaks,
  weeklyReport,
  dayOfWeekStats,
  trendAnalysis,
  getReminders,
  setReminder,
  deleteReminder,
  getHabits,
  addHabit,
  updateHabit,
  deleteHabit,
  logHabit,
  toggleHabitPause,
  debugAddHabitFreezers,
  getForest,
  getForestData,
  forestAddTree,
  forestAddCoins,
  forestBuySpecies,
  forestSelectSpecies,
  forestSetDistractions,
  forestSetTags,
  forestSetSettings,
  forestSetActiveSession,
  forestUnlockAchievement,
  forestAddTask,
  forestToggleTask,
  forestDeleteTask,
  raw: () => data
};
