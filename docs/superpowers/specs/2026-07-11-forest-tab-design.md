# Forest Tab — Design Spec

Date: 2026-07-11
Status: Approved (user: "מה שהכי טוב" + added Tasks tab, "start, don't wait")

## Goal

Add a "Forest" page to the Screen Time app: a Forest-app-style gamified focus timer.
The user plants a virtual tree for a focus session; the tree grows through visual
stages during the session; switching to a distracting app triggers a 10-second
warning and then kills the tree. Completed trees build a personal forest, earn
coins, unlock species, feed stats/achievements, and can be attached to tasks.

Skipped by design (require servers / real money): Plant Together / friends,
real-tree planting, Plus subscription, crystals/elixirs.

All artwork is original SVG inspired by Forest's aesthetic — no copying of
Seekrtech assets. Palette measured from official screenshots during research:
`#145A4E` (deep teal headline), `#274539` (dark forest surface), `#3FA98F`
(mid teal), `#8ED320` (leaf green accent), `#E6FEEC` (pale mint).

## Architecture (Approach A — session lives in main)

Session logic runs in the main process (`src/main/forest.js`) so sessions
survive minimizing to tray, and distraction detection reuses the tracker's
existing 2-second foreground tick. The renderer only renders.

### Data model — `forest` key in store.js `defaults()`

```js
forest: {
  coins: 0,
  unlockedSpecies: ['oak'],
  selectedSpecies: 'oak',
  trees: [],   // { id, species, tag, taskId|null, plannedSec, actualSec,
               //   startedAt, endedAt, result: 'success'|'dead'|'givenup', mode: 'timer'|'stopwatch' }
  tags: ['Study', 'Work', 'Writing'],
  tasks: [],   // { id, title, done, createdAt, doneAt|null, focusSec, treeCount }
  distractions: { mode: 'blocklist', apps: [] },  // mode: 'blocklist'|'allowlist'
  achievements: {},   // id -> unlockedAt ISO string
  settings: { allowPause: true, warningSec: 10 },
  activeSession: null // snapshot for crash recovery; non-null => app died mid-session
}
```

### Session engine — `src/main/forest.js`

State machine: `idle → growing ⇄ warning ⇄ paused → success | dead | givenup`.

- 1s internal interval accumulates `actualSec` while `growing`.
- `onForegroundApp(appName)` called from the tracker tick in main.js:
  - Distracting = (blocklist mode: app is listed) / (allowlist mode: app not
    listed and not this app itself).
  - Distracting while growing → `warning`: OS Notification ("Return or your
    tree dies!"), countdown `warningSec`. Back to non-distracting → `growing`.
    Countdown expires → `dead`.
- Timer mode completes at `plannedSec` → `success`. Stopwatch mode: user calls
  finish; < 10 min → tree dies (as in Forest), ≥ 10 min → success.
- Pause allowed only if `settings.allowPause`; paused time doesn't accumulate,
  distraction checks suspended while paused.
- Coins on success: `floor(minutes / 2)`, ×1.5 (rounded) if ≥ 60 min. Dead or
  given up: 0.
- Every state change + once per ~15s, persist `activeSession` snapshot. On app
  startup, a leftover snapshot is recorded as a dead tree (killing the app
  kills the tree) and cleared.
- Achievements checked after each recorded tree: first-tree, trees-10,
  trees-50, focus-24h (cumulative success time), session-2h, streak-7 (7
  consecutive days with ≥1 successful tree), coins-100 (lifetime earned),
  species-4 (own 4 species), tasks-10 (10 tasks completed).

### IPC surface (preload `window.api`)

- `forest:getState` → { session (live view or null), data (forest store minus activeSession) }
- `forest:start` ({ mode, plannedSec, species, tag, taskId })
- `forest:pause` / `forest:resume` / `forest:giveup` / `forest:finish` (stopwatch)
- `forest:buySpecies` (id) — validates coins, dedupes
- `forest:selectSpecies` (id)
- `forest:setDistractions` ({ mode, apps })
- `forest:setTags` (array)
- `forest:setSettings` (partial)
- Tasks: `forest:tasks:add` (title), `forest:tasks:toggle` (id), `forest:tasks:delete` (id)
- Events main→renderer: `forest-tick` ({ state, elapsedSec, plannedSec,
  warningLeft, stage }), `forest-ended` ({ result, coinsEarned, tree,
  newAchievements })

### Species catalog (8, defined in a shared JS constant)

| id | name | price |
|---|---|---|
| oak | Oak | 0 (default) |
| pine | Pine | 60 |
| cherry | Cherry Blossom | 120 |
| lemon | Lemon Tree | 180 |
| willow | Willow | 260 |
| cactus | Cactus | 340 |
| maple | Autumn Maple | 450 |
| baobab | Baobab | 600 |

### Art system — `src/renderer/forest-art.js`

`window.ForestArt.treeSVG(speciesId, stage, { size })` returns an SVG string.
Stages: 0 sprout, 1 sapling, 2 young, 3 mature, plus `'dead'` (grey-brown bare
branches variant per species). Stage during a session = progress quartile, so
the tree visibly develops as the session advances (user requirement).
Each species = distinct silhouette + palette. Also
`ForestArt.tileSVG(trees)` helpers for the isometric forest grid.

### UI — `page-forest` + sidebar item 🌲, sub-tabs styled like existing range-tabs

1. **Plant** — coin counter; species picker (horizontal scroll of unlocked
   species); tag picker; optional task picker; duration slider 10–120 min
   (step 5) or stopwatch toggle; big Plant button. Active session: large
   timer, growing SVG tree, Pause/Give Up. Warning state: red-tinted overlay
   with countdown. Session end: result card (+ coins, achievements) and a
   skippable "Breathe" overlay (Mindful-Space-style breathing animation).
2. **Tasks** — add/complete/delete tasks; each shows accumulated focus time
   and tree count; planting can attach a session to a task.
3. **My Forest** — isometric CSS-grid diorama of completed trees (day / week /
   month / year navigation like Forest), dead trees rendered withered.
4. **Shop** — species cards with SVG preview, price, Buy/Owned/Selected states.
5. **Stats** — total focus time, success/dead counts, per-tag breakdown,
   last-7-days bar chart of focused minutes.
6. **Achievements** — grid of badges, locked/unlocked with dates.

Distraction list editor lives on the Plant view (small "Distractions…" link →
modal): mode toggle + app-name list seeded from the existing block list.

New renderer files: `forest-art.js`, `forest-ui.js` (both loaded from
index.html after renderer.js; renderer.js's page navigation already works off
`data-page`, so only nav item + section markup are added there).

### Styling

Forest page uses scoped classes (`.forest-*`) layered on the existing dark
theme: dark forest-green card surfaces (#1a2b22 range), #8ED320 accent for
CTAs and growth, #3FA98F for secondary accents, warning state in the app's
existing red. Fonts unchanged (Segoe UI).

## Testing

- `forest.js` engine is dependency-injected (clock via `now()` param, notifier
  callback, store facade) → `scripts/test-forest.js` node script drives the
  state machine through: success flow, warning-recover, warning-death,
  stopwatch under/over 10 min, pause, crash recovery, coins math,
  achievements. Run with `node scripts/test-forest.js`.
- UI verified via existing CDP flow (dev instance, temp/unique data only).

## Out of scope

Real websites blocking during sessions, per-session deep-focus enforcement
(killing apps), sync, sounds/soundscapes (could be a later addition).
