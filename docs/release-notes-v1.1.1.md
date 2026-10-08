# Screen Time 1.1.1

## What is new
- **ActivityWatch import** — if ActivityWatch is installed and running, Screen Time fills hours it missed (app closed, crash) from ActivityWatch's active-window data. Read-only: nothing is ever written to ActivityWatch. Idle/AFK time and "Not Me" sessions are never counted, and hours Screen Time already recorded are left alone. Turn off with `settings.activityWatch.enabled`.

Your data is not touched by an update. Stored locally in `%APPDATA%/screen-time-track`.
