const { spawn } = require('child_process');

// Best-effort, admin-free block of Task Manager (the one thing reachable from
// Ctrl+Alt+Del / Ctrl+Shift+Esc that could kill the lock/beep process).
//
// True Ctrl+Alt+Del interception is impossible from user-mode — it's a
// hardcoded "secure attention sequence" in Windows specifically so no app,
// malicious or not, can spoof/suppress it. What IS reachable without admin
// rights is the per-user (HKCU, not HKLM) DisableTaskMgr policy: writing it
// doesn't need elevation, and Task Manager checks it on every launch attempt.
// It's soft — an already-open Task Manager isn't force-closed, and a
// sufficiently technical user could still undo the registry key manually —
// but it closes the obvious escape hatch without asking for admin/UAC.
const KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Policies\\System';

function run(args) {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve(false);
    const p = spawn('reg.exe', args, { windowsHide: true });
    p.on('error', () => resolve(false));
    p.on('exit', (code) => resolve(code === 0));
  });
}

function block() {
  return run(['add', KEY, '/v', 'DisableTaskMgr', '/t', 'REG_DWORD', '/d', '1', '/f']);
}

// Always safe to call even if the value was never set (reg delete on a
// missing value just fails quietly) — used defensively on every app start so
// a crash mid-lock never leaves Task Manager blocked forever.
function unblock() {
  return run(['delete', KEY, '/v', 'DisableTaskMgr', '/f']);
}

module.exports = { block, unblock };
