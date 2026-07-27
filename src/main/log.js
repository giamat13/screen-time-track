// Append-only forensic log.
//
// Why this exists: the data file has been destroyed three times and every
// post-mortem started from zero information — no record of what the app was
// doing, whether it even got to write, or whether the machine went down under
// it. This module is the black box. It is deliberately chatty: a line costs
// ~100 bytes and the next incident is worth far more than the disk.
//
// Every line is fsync'd before we return. That is not paranoia — the events
// worth logging here are precisely the ones followed by a crash or a power
// cut, and a log line sitting in the OS page cache is exactly as lost as the
// data it was supposed to explain. (That is the same failure that destroyed
// the data file itself; see writeFileSyncDurable in store.js.)
const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const LOG_DIR = path.join(app.getPath('userData'), 'logs');
// Exists only while the app is running. Still there at startup => the previous
// run never reached before-quit: a crash, a kill, or a power loss. That single
// bit separates "the app has a bug" from "the machine went down mid-write",
// which is the question every wipe so far has left unanswered.
const RUNNING_FLAG = path.join(app.getPath('userData'), 'running.flag');

let handle = null;      // { day, fd }
let seq = 0;            // per-run line counter; gaps reveal a lost tail
let dropped = 0;        // lines we failed to write (disk full, permissions)

function dayStamp(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function fdFor(day) {
  if (handle && handle.day === day) return handle.fd;
  if (handle) { try { fs.closeSync(handle.fd); } catch (e) { /* rotating anyway */ } }
  fs.mkdirSync(LOG_DIR, { recursive: true });
  // 'a' so a same-day restart appends instead of truncating the record of the
  // run that just died — which is the run we most want to read.
  handle = { day, fd: fs.openSync(path.join(LOG_DIR, `screen-time-${day}.log`), 'a') };
  return handle.fd;
}

function write(level, event, fields) {
  const now = new Date();
  seq++;
  let line = `${now.toISOString()} ${level} #${seq} pid=${process.pid} ${event}`;
  if (fields) {
    for (const [k, v] of Object.entries(fields)) {
      if (v === undefined) continue;
      let s;
      try { s = typeof v === 'string' ? v : JSON.stringify(v); } catch (e) { s = '<unserializable>'; }
      if (s === undefined) s = 'undefined';
      if (s.length > 600) s = s.slice(0, 600) + `…(+${s.length - 600})`;
      line += ` ${k}=${/[\s"]/.test(s) ? JSON.stringify(s) : s}`;
    }
  }
  if (level === 'ERROR' || level === 'WARN') console.error(line);
  else console.log(line);
  try {
    const fd = fdFor(dayStamp(now));
    fs.writeSync(fd, line + '\n');
    fs.fsyncSync(fd);   // survive the power loss we are most likely logging about
    if (dropped) {
      const note = `${now.toISOString()} WARN #${seq} pid=${process.pid} log.dropped_recovered count=${dropped}\n`;
      dropped = 0;
      fs.writeSync(fd, note);
      fs.fsyncSync(fd);
    }
  } catch (e) {
    // Logging must never be the thing that breaks the app. Count the loss so the
    // gap in the sequence numbers is explained once writing works again.
    dropped++;
  }
}

// The file the log is currently being written to — snapshotted alongside the
// data backups so the forensic record survives losing the profile folder.
function currentFile() {
  return path.join(LOG_DIR, `screen-time-${dayStamp()}.log`);
}

// Records this run's start, and reports whether the *previous* run ended cleanly.
// Returns the previous run's marker (with the reason it was still there) or null.
function sessionStart(info) {
  let unclean = null;
  try {
    if (fs.existsSync(RUNNING_FLAG)) {
      try { unclean = JSON.parse(fs.readFileSync(RUNNING_FLAG, 'utf8')); }
      catch (e) { unclean = { unparsable: true }; }
    }
  } catch (e) { /* treat as clean; nothing better to do */ }

  write('INFO', 'session.start', info);
  if (unclean) {
    write('ERROR', 'session.previous_run_did_not_exit_cleanly', {
      ...unclean,
      meaning: 'crash, kill, or power loss — check the tail of the previous log for how far it got',
    });
  } else {
    write('INFO', 'session.previous_run_exited_cleanly', {});
  }

  try {
    fs.writeFileSync(RUNNING_FLAG, JSON.stringify({
      pid: process.pid, startedAt: new Date().toISOString(), ...info,
    }));
  } catch (e) { write('WARN', 'session.flag_write_failed', { err: e.message }); }
  return unclean;
}

function sessionEnd(reason) {
  write('INFO', 'session.end', { reason });
  try { fs.unlinkSync(RUNNING_FLAG); }
  catch (e) { if (e.code !== 'ENOENT') write('WARN', 'session.flag_clear_failed', { err: e.message }); }
  if (handle) { try { fs.closeSync(handle.fd); } catch (e) { /* exiting */ } handle = null; }
}

module.exports = {
  LOG_DIR,
  currentFile,
  sessionStart,
  sessionEnd,
  info: (event, fields) => write('INFO', event, fields),
  warn: (event, fields) => write('WARN', event, fields),
  error: (event, fields) => write('ERROR', event, fields),
};
