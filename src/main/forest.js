// Forest focus-session engine. A session "plants a tree": the tree grows while
// the user stays away from distracting apps; switching to one starts a short
// warning countdown, and if the user doesn't come back the tree dies.
//
// The engine is dependency-injected (store facade, notifier, event sink, and a
// tick driven from outside) so its state machine can be exercised from a plain
// node script without Electron.

const SPECIES = [
  { id: 'oak', name: 'Oak', price: 0 },
  { id: 'pine', name: 'Pine', price: 60 },
  { id: 'cherry', name: 'Cherry Blossom', price: 120 },
  { id: 'lemon', name: 'Lemon Tree', price: 180 },
  { id: 'willow', name: 'Willow', price: 260 },
  { id: 'cactus', name: 'Cactus', price: 340 },
  { id: 'maple', name: 'Autumn Maple', price: 450 },
  { id: 'baobab', name: 'Baobab', price: 600 }
];

const MIN_TIMER_SEC = 10 * 60;
const MAX_TIMER_SEC = 120 * 60;
const MIN_STOPWATCH_SEC = 10 * 60; // shorter stopwatch sessions kill the tree
const SNAPSHOT_EVERY_SEC = 15;

// Windows shows the tracker's own process under these names — never treat the
// app itself as a distraction in allowlist mode.
const SELF_NAMES = new Set(['screen time', 'screentime', 'electron']);

const ACHIEVEMENTS = [
  { id: 'first-tree', name: 'First Tree', desc: 'Complete your first focus session' },
  { id: 'trees-10', name: 'Grove', desc: 'Grow 10 trees' },
  { id: 'trees-50', name: 'Forest', desc: 'Grow 50 trees' },
  { id: 'focus-24h', name: 'Deep Roots', desc: '24 hours of successful focus' },
  { id: 'session-2h', name: 'Marathon', desc: 'Complete a 2-hour session' },
  { id: 'streak-7', name: 'Evergreen', desc: 'Grow a tree 7 days in a row' },
  { id: 'coins-100', name: 'Saver', desc: 'Earn 100 coins in total' },
  { id: 'species-4', name: 'Collector', desc: 'Own 4 tree species' },
  { id: 'tasks-10', name: 'Achiever', desc: 'Complete 10 tasks' }
];

function createForestEngine({ store, notify, sendEvent, now = () => Date.now() }) {
  let session = null; // { id, mode, plannedSec, species, tag, taskId, startedAtMs, startedAt, actualSec, state, warningLeft, sinceSnapshot }

  // ---- crash recovery: a leftover snapshot means the app died mid-session ----
  function recoverCrashed() {
    const snap = store.getForest().activeSession;
    if (!snap) return null;
    store.forestSetActiveSession(null);
    const tree = {
      id: snap.id,
      species: snap.species,
      tag: snap.tag,
      taskId: snap.taskId || null,
      plannedSec: snap.plannedSec,
      actualSec: snap.actualSec || 0,
      startedAt: snap.startedAt,
      endedAt: new Date(now()).toISOString(),
      result: 'dead',
      mode: snap.mode
    };
    store.forestAddTree(tree);
    return tree;
  }

  function snapshot() {
    if (!session) return store.forestSetActiveSession(null);
    store.forestSetActiveSession({
      id: session.id,
      mode: session.mode,
      plannedSec: session.plannedSec,
      species: session.species,
      tag: session.tag,
      taskId: session.taskId,
      startedAt: session.startedAt,
      actualSec: session.actualSec
    });
  }

  function stage() {
    if (!session) return 0;
    if (session.mode === 'timer') {
      const p = session.actualSec / Math.max(session.plannedSec, 1);
      return p < 0.25 ? 0 : p < 0.5 ? 1 : p < 0.75 ? 2 : 3;
    }
    // stopwatch: grow by absolute focused time
    const m = session.actualSec / 60;
    return m < 10 ? 0 : m < 30 ? 1 : m < 60 ? 2 : 3;
  }

  function liveView() {
    if (!session) return null;
    return {
      id: session.id,
      mode: session.mode,
      state: session.state,
      species: session.species,
      tag: session.tag,
      taskId: session.taskId,
      plannedSec: session.plannedSec,
      elapsedSec: session.actualSec,
      warningLeft: session.state === 'warning' ? session.warningLeft : null,
      startedAt: session.startedAt,
      stage: stage()
    };
  }

  function start({ mode, plannedSec, species, tag, taskId }) {
    if (session) return { ok: false, reason: 'active' };
    const f = store.getForest();
    mode = mode === 'stopwatch' ? 'stopwatch' : 'timer';
    plannedSec = mode === 'timer'
      ? Math.min(MAX_TIMER_SEC, Math.max(MIN_TIMER_SEC, Math.round(plannedSec || 0)))
      : 0;
    if (!f.unlockedSpecies.includes(species)) species = f.selectedSpecies;
    session = {
      id: 'tree_' + now().toString(36) + Math.random().toString(36).slice(2, 6),
      mode,
      plannedSec,
      species,
      tag: typeof tag === 'string' && tag.trim() ? tag.trim() : null,
      taskId: taskId || null,
      startedAtMs: now(),
      startedAt: new Date(now()).toISOString(),
      actualSec: 0,
      state: 'growing',
      warningLeft: 0,
      sinceSnapshot: 0
    };
    store.forestSelectSpecies(species);
    snapshot();
    sendEvent('forest-tick', liveView());
    return { ok: true, session: liveView() };
  }

  // Called every second from outside (main: setInterval; tests: manually).
  function tick() {
    if (!session) return;
    if (session.state === 'growing') {
      session.actualSec += 1;
      session.sinceSnapshot += 1;
      if (session.mode === 'timer' && session.actualSec >= session.plannedSec) {
        return end('success');
      }
      if (session.sinceSnapshot >= SNAPSHOT_EVERY_SEC) {
        session.sinceSnapshot = 0;
        snapshot();
      }
    } else if (session.state === 'warning') {
      session.warningLeft -= 1;
      if (session.warningLeft <= 0) return end('dead');
    }
    sendEvent('forest-tick', liveView());
  }

  // Called with the foreground app name on every tracker tick.
  function onForegroundApp(appName) {
    if (!session || session.state === 'paused') return;
    const distracting = isDistracting(appName);
    if (distracting && session.state === 'growing') {
      session.state = 'warning';
      session.warningLeft = store.getForest().settings.warningSec || 10;
      notify('Your tree is in danger! 🌱', `Leave ${appName} or your tree will die in ${session.warningLeft}s.`);
      sendEvent('forest-tick', liveView());
    } else if (!distracting && session.state === 'warning') {
      session.state = 'growing';
      session.warningLeft = 0;
      sendEvent('forest-tick', liveView());
    }
  }

  function isDistracting(appName) {
    if (!appName) return false;
    const f = store.getForest();
    const name = String(appName).toLowerCase();
    const listed = f.distractions.apps.some((a) => a.toLowerCase() === name);
    if (f.distractions.mode === 'allowlist') {
      return !listed && !SELF_NAMES.has(name);
    }
    return listed;
  }

  function pause() {
    if (!session || session.state !== 'growing') return { ok: false };
    if (!store.getForest().settings.allowPause) return { ok: false, reason: 'disabled' };
    session.state = 'paused';
    sendEvent('forest-tick', liveView());
    return { ok: true };
  }

  function resume() {
    if (!session || session.state !== 'paused') return { ok: false };
    session.state = 'growing';
    sendEvent('forest-tick', liveView());
    return { ok: true };
  }

  function giveup() {
    if (!session) return { ok: false };
    return end('givenup');
  }

  // Stopwatch finish: long enough → success, too short → the tree dies.
  function finish() {
    if (!session || session.mode !== 'stopwatch') return { ok: false };
    return end(session.actualSec >= MIN_STOPWATCH_SEC ? 'success' : 'dead');
  }

  function coinsFor(sec) {
    const minutes = Math.floor(sec / 60);
    let coins = Math.floor(minutes / 2);
    if (minutes >= 60) coins = Math.round(coins * 1.5);
    return coins;
  }

  function end(result) {
    const s = session;
    session = null;
    store.forestSetActiveSession(null);
    const tree = {
      id: s.id,
      species: s.species,
      tag: s.tag,
      taskId: s.taskId,
      plannedSec: s.plannedSec,
      actualSec: s.actualSec,
      startedAt: s.startedAt,
      endedAt: new Date(now()).toISOString(),
      result,
      mode: s.mode
    };
    store.forestAddTree(tree);
    const coinsEarned = result === 'success' ? coinsFor(s.actualSec) : 0;
    if (coinsEarned) store.forestAddCoins(coinsEarned);
    const newAchievements = checkAchievements();
    sendEvent('forest-ended', { result, coinsEarned, tree, newAchievements });
    if (result === 'dead') notify('Your tree died 🥀', 'Stay focused next time to grow your forest.');
    return { ok: true, result, coinsEarned, tree, newAchievements };
  }

  function checkAchievements() {
    const f = store.getForest();
    const success = f.trees.filter((t) => t.result === 'success');
    const focusSec = success.reduce((s, t) => s + t.actualSec, 0);
    const days = new Set(success.map((t) => t.startedAt.slice(0, 10)));
    const streak = consecutiveDayStreak(days);
    const doneTasks = f.tasks.filter((t) => t.done).length;
    const met = {
      'first-tree': success.length >= 1,
      'trees-10': success.length >= 10,
      'trees-50': success.length >= 50,
      'focus-24h': focusSec >= 24 * 3600,
      'session-2h': success.some((t) => t.actualSec >= 2 * 3600),
      'streak-7': streak >= 7,
      'coins-100': f.coinsEarned >= 100,
      'species-4': f.unlockedSpecies.length >= 4,
      'tasks-10': doneTasks >= 10
    };
    const unlocked = [];
    for (const a of ACHIEVEMENTS) {
      if (met[a.id] && store.forestUnlockAchievement(a.id)) unlocked.push(a);
    }
    return unlocked;
  }

  function consecutiveDayStreak(daySet) {
    if (!daySet.size) return 0;
    const days = [...daySet].sort();
    let best = 1, cur = 1;
    for (let i = 1; i < days.length; i++) {
      const prev = new Date(days[i - 1] + 'T00:00:00');
      const diff = (new Date(days[i] + 'T00:00:00') - prev) / 86400000;
      cur = diff === 1 ? cur + 1 : 1;
      if (cur > best) best = cur;
    }
    return best;
  }

  return {
    SPECIES,
    ACHIEVEMENTS,
    recoverCrashed,
    start,
    tick,
    onForegroundApp,
    pause,
    resume,
    giveup,
    finish,
    liveView,
    checkAchievements,
    // exposed for tests
    _coinsFor: coinsFor
  };
}

module.exports = { createForestEngine, SPECIES, ACHIEVEMENTS };
