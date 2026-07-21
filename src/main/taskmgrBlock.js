const { spawn } = require('child_process');

// Blocks Task Manager (the one thing reachable from Ctrl+Alt+Del / Ctrl+Shift+Esc
// that could kill the lock/beep process) while a lock is active.
//
// True Ctrl+Alt+Del interception is impossible from user-mode — it's a
// hardcoded "secure attention sequence" in Windows specifically so no app,
// malicious or not, can spoof/suppress it.
//
// Two layers, strong-to-weak:
//
//   1. Scheduled Task (HKLM). If the user opted into an elevated ("for all
//      users") install, `build/installer.nsh` registered two on-demand
//      Scheduled Tasks (Highest privileges, running as SYSTEM) that flip the
//      *machine-wide* DisableTaskMgr policy. Triggering an already-registered
//      task needs no further UAC prompt — the elevation grant lives in the
//      task definition, established once at install time — and a standard
//      user can't undo an HKLM value from their own Registry Editor.
//   2. Per-user (HKCU) registry fallback. Used when the Scheduled Tasks
//      aren't present (a non-elevated / per-user install). Needs zero admin,
//      ever, but the same user could reopen Registry Editor and delete it.
//
// unblock() always attempts both, so cleanup is correct regardless of which
// layer actually blocked, and a crash mid-lock never leaves either stuck on.
const KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Policies\\System';
const TASK_BLOCK = 'ScreenTimeBlockTaskMgr';
const TASK_UNBLOCK = 'ScreenTimeUnblockTaskMgr';

function run(cmd, args) {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve(false);
    const p = spawn(cmd, args, { windowsHide: true });
    p.on('error', () => resolve(false));
    p.on('exit', (code) => resolve(code === 0));
  });
}

function runScheduledTask(name) {
  return run('schtasks.exe', ['/run', '/tn', name]);
}

function regToggle(add) {
  const args = add
    ? ['add', KEY, '/v', 'DisableTaskMgr', '/t', 'REG_DWORD', '/d', '1', '/f']
    : ['delete', KEY, '/v', 'DisableTaskMgr', '/f'];
  return run('reg.exe', args);
}

async function block() {
  const strong = await runScheduledTask(TASK_BLOCK);
  if (!strong) await regToggle(true); // no elevated task registered — fall back
}

async function unblock() {
  await runScheduledTask(TASK_UNBLOCK);
  await regToggle(false);
}

module.exports = { block, unblock };
