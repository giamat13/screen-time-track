# Local API

Screen Time exposes a tiny read-only HTTP API on `127.0.0.1` so other apps on
this machine can read your usage data — in particular, whether you're
present at the computer right now. It never binds outside localhost, so
nothing is reachable from the network.

- Base URL: `http://127.0.0.1:47834`
- Method: `GET` only
- Format: JSON

## `GET /status`

Presence and tracking state, refreshed live.

```json
{
  "present": true,
  "idleSeconds": 0,
  "idleThreshold": 120,
  "tracking": true,
  "locked": false,
  "currentApp": "VS Code",
  "timestamp": 1788526014866
}
```

| Field | Meaning |
|---|---|
| `present` | `true` if the user is at the computer (input seen within `idleThreshold` seconds, and not in study mode which forces `false`). This is the field you want for an "am I here" check. |
| `idleSeconds` | Seconds since the last keyboard/mouse input. |
| `idleThreshold` | The user's configured idle cutoff (seconds) used to compute `present`. |
| `tracking` | Whether Screen Time is currently tracking usage. |
| `locked` | Whether the break/lock screen is currently showing. |
| `currentApp` | Friendly name of the foreground app, or `null`. |
| `timestamp` | Server time (ms since epoch) when the response was generated. |

## `GET /today`

Today's aggregated usage, same shape as the internal daily record.

```json
{
  "apps": { "VS Code": 2.05, "Chrome": 130.4 },
  "total": 132.45,
  "hours": [0, 0, /* ...24 entries, seconds per hour of day... */],
  "study": 0,
  "studyApps": {}
}
```

`apps` and `total`/`study` are seconds.

## Example

```bash
curl http://127.0.0.1:47834/status
```

```js
const r = await fetch('http://127.0.0.1:47834/status');
const { present } = await r.json();
```

If the app isn't running, the request fails to connect (connection refused) —
that itself is a signal Screen Time isn't tracking right now.
