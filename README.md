# Screen Time

A background screen-time tracker for **Windows**. It detects which application is in the
foreground, counts how long you actively use each app (skipping idle time), and shows it all
on a polished dashboard. It runs in the system tray 24/7 and can start automatically at login.

## Features

- **Live tracking** of the active app, with a real-time "Today's Screen Time" counter.
- **Idle aware** — time is not counted when there's no keyboard/mouse input (configurable threshold),
  or while the screen is locked / the PC is asleep.
- **Dashboard** — usage distribution donut, top applications, session summary, today-vs-yesterday trend.
- **Statistics** — daily usage bars and per-app breakdown over 7 / 14 / 30 days.
- **App Blocking** — apps on your block list are closed automatically when launched.
- **Runs in the background** — closing the window minimizes to the tray; tracking keeps going.
- **Start at login** — toggle in Settings (registers the app to launch hidden on sign-in).

## How it works

- A tiny persistent **PowerShell** helper (`src/main/foreground.ps1`) reports the foreground
  window's process every couple of seconds using the Win32 `GetForegroundWindow` API — so there
  are **no native modules to compile**.
- Electron's `powerMonitor.getSystemIdleTime()` provides idle detection.
- Usage is aggregated per day per app into a JSON file in your user-data folder.

## Run it

```bash
npm install      # also generates the app icons
npm start
```

For development with DevTools:

```bash
npm run dev
```

## Build a Windows installer

```bash
npm run dist     # outputs an NSIS installer in dist/
```

After installing, enable **Settings → Start at login** so it runs in the background 24/7.

## Data location

`%APPDATA%/screen-time-track/screen-time-data.json`

All data stays local on your machine.
