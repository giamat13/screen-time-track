# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Quick Start

```bash
npm install      # Install dependencies and generate app icons
npm start        # Launch the app (Electron in production mode)
npm run dev      # Launch with DevTools open
npm run dist     # Build Windows installer to dist/
```

## Architecture

Screen Time is an **Electron + Node.js + PowerShell** desktop app for Windows that tracks background app usage with idle-time awareness.

### High-level flow

1. **Tracker (`src/main/tracker.js`)** — spawns a persistent PowerShell watcher (`src/main/foreground.ps1`) that polls the foreground window every 2 seconds, emitting JSON line-by-line.
2. **Main process (`src/main/main.js`)** — parses tracker output, applies idle/pause logic, calls `store.addTime()` to aggregate usage per app per day, broadcasts tick events to the renderer.
3. **Store (`src/main/store.js`)** — manages a single JSON file (`%APPDATA%/screen-time-track/screen-time-data.json`) with daily app usage, user settings, and a block list. Uses debounced writes (4s) to minimize I/O.
4. **Renderer (`src/renderer/renderer.js`)** — vanilla JS UI that listens for IPC tick events and renders real-time stats, dashboard, and settings. No frameworks.

### Key architecture points

- **No native modules** — the PowerShell helper avoids compilation overhead; idle detection comes from `powerMonitor.getSystemIdleTime()`.
- **IPC is unidirectional from main to renderer** — main sends `'tick'`, `'tracking-changed'`, and `'blocked-hit'`; renderer pulls state via `ipcMain.handle()`.
- **Foreground watcher is resilient** — if the PowerShell process exits, the tracker auto-restarts after 2 seconds.
- **Name mapping** — `src/main/tracker.js` contains a `NAME_MAP` that normalizes process names to friendly labels (e.g., `chrome` → `Google Chrome`).
- **Block list is enforced eagerly** — when a blocked app is detected, it is killed immediately with `taskkill` and a notification is shown (throttled to 4s).
- **Settings are persisted** — idle threshold, poll interval, tracking state, auto-launch preference, and more live in the store and survive app restarts.
- **Lock system** — `src/main/breakReminder.js` is the brain: a presence timer → beeping alarm → a fullscreen kiosk lock. The prompt offers only "I'm taking a break" (locks immediately) and "Approve me to keep playing" (pings Telegram watchers + a short "get up and check" lock). The kiosk lock window lives in `main.js` (`showLock`/`updateLock`/`hideLock`), renders `src/renderer/lock.html`, and swallows escape shortcuts via `globalShortcut` + `before-input-event`. Note: the Windows Secure Attention Sequence (Ctrl+Alt+Del) can't be blocked from user space — `src/main/taskmgrBlock.js` instead blocks Task Manager itself (the actual escape hatch), with two layers: if the user chose an elevated ("for all users") install, `build/installer.nsh` registered two on-demand Scheduled Tasks (Highest privileges, running as SYSTEM) that the app triggers via `schtasks /run` to flip the machine-wide `HKLM\...\Policies\System\DisableTaskMgr` policy with no further UAC prompt; otherwise it falls back to the same value under `HKCU` (needs zero admin, ever, but is undoable by the same user via Registry Editor). It's toggled in `showLock`/`hideLock` and defensively cleared on every app start and quit so a crash mid-lock can never leave it stuck on. The elevated Scheduled Task path is unverified on real Windows — needs testing.
- **Telegram watchers** (`src/main/telegram.js`) — a dependency-free Bot API client (long-polls `getUpdates`). A `/cancel` or negative keyword (English/Hebrew) reply vetoes an "approve", escalating (immediate lock → beep-then-lock) based on how fast the reply arrives. `/lock` from a watcher forces a break. First-time setup sends the watchers an explanation.

## Important quirks

- **ELECTRON_RUN_AS_NODE**: This env var must be cleared before running Electron, or the renderer will fail to load and `app` will be undefined in preload. See auto-memory for details.
- **Foreground.ps1 unpacking**: The PowerShell script is in `asarUnpack` in `package.json` because it needs to be executable on disk; relative paths in the script must account for both packed (`app.asar.unpacked`) and dev modes.
- **Tray icon fallback**: If `tray.png` is missing, the app falls back to `icon.png`.

## File structure

```
src/
  main/
    main.js           — Electron main process, window/tray/IPC setup
    tracker.js        — Foreground window watcher, idle logic, name mapping
    store.js          — JSON persistence, daily aggregation, settings
    foreground.ps1    — PowerShell script spawned to poll GetForegroundWindow()
  preload/
    preload.js        — Preload script (minimal; mostly empty)
  renderer/
    index.html        — Single HTML page
    styles.css        — Styling (dark theme, donut chart CSS)
    renderer.js       — Vanilla JS: IPC handlers, UI logic, chart rendering

assets/               — icon.png, tray.png, icon.ico (generated by make-assets.js)
scripts/
  make-assets.js      — Generates PNG and ICO icons from a source (runs postinstall)

dist/                 — Built installer and app (created by npm run dist)
```

## Common tasks

**Add a new setting:**
1. Add it to the `defaults()` object in `src/main/store.js`.
2. Expose it via IPC in `src/main/main.js` (handle `settings:get` and `settings:set`).
3. Update the renderer UI in `src/renderer/renderer.js` to read/write it.

**Add a new app name mapping:**
- Edit the `NAME_MAP` in `src/main/tracker.js` and re-run the app.

**Debug the foreground watcher:**
- Run the PowerShell script manually: `powershell -ExecutionPolicy Bypass -File src/main/foreground.ps1 2`.
- It outputs one JSON object per line.

**Verify the Electron UI:**
- Use `npm run dev` to open DevTools.
- For headless verification, see auto-memory: use `--remote-debugging-port` + Node 22 WebSocket.

**Build and test the installer:**
- Run `npm run dist`.
- Installer output goes to `dist/ScreenTime-Setup-*.exe`.
- The built app runs with `--hidden` if opened at login.

## Data file location

`%APPDATA%/screen-time-track/screen-time-data.json`

All data stays local on the user's machine.
