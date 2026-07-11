// Exercises the forest session engine state machine without Electron.
// Run: node scripts/test-forest.js
const { createForestEngine } = require('../src/main/forest');

let failures = 0;
function check(name, cond) {
  if (cond) { console.log('  ok', name); }
  else { failures++; console.error('  FAIL', name); }
}

// Minimal in-memory store facade matching what the engine uses.
function makeStore() {
  const forest = {
    coins: 0,
    coinsEarned: 0,
    unlockedSpecies: ['oak'],
    selectedSpecies: 'oak',
    trees: [],
    tags: ['Study'],
    tasks: [],
    distractions: { mode: 'blocklist', apps: ['Discord'] },
    achievements: {},
    settings: { allowPause: true, warningSec: 10 },
    activeSession: null
  };
  return {
    forest,
    getForest: () => forest,
    forestSetActiveSession: (s) => { forest.activeSession = s; },
    forestAddTree: (t) => { forest.trees.push(t); return t; },
    forestAddCoins: (n) => { forest.coins += n; if (n > 0) forest.coinsEarned += n; },
    forestSelectSpecies: (id) => { if (forest.unlockedSpecies.includes(id)) forest.selectedSpecies = id; },
    forestUnlockAchievement: (id) => {
      if (forest.achievements[id]) return false;
      forest.achievements[id] = 'now'; return true;
    }
  };
}

function makeEngine(store) {
  const events = [];
  const notes = [];
  const eng = createForestEngine({
    store,
    notify: (t, b) => notes.push([t, b]),
    sendEvent: (ch, p) => events.push([ch, p])
  });
  return { eng, events, notes };
}

console.log('timer success flow');
{
  const store = makeStore();
  const { eng, events } = makeEngine(store);
  const r = eng.start({ mode: 'timer', plannedSec: 600, species: 'oak', tag: 'Study' });
  check('start ok', r.ok);
  check('snapshot persisted', !!store.forest.activeSession);
  for (let i = 0; i < 600; i++) eng.tick();
  check('session over', eng.liveView() === null);
  check('snapshot cleared', store.forest.activeSession === null);
  const tree = store.forest.trees[0];
  check('tree success', tree && tree.result === 'success');
  check('actualSec = 600', tree.actualSec === 600);
  check('coins 10min => 5', store.forest.coins === 5);
  const ended = events.find(([ch]) => ch === 'forest-ended');
  check('ended event sent', !!ended && ended[1].result === 'success');
  check('first-tree achievement', !!store.forest.achievements['first-tree']);
}

console.log('warning -> recovery');
{
  const store = makeStore();
  const { eng, notes } = makeEngine(store);
  eng.start({ mode: 'timer', plannedSec: 600, species: 'oak' });
  for (let i = 0; i < 60; i++) eng.tick();
  eng.onForegroundApp('Discord');
  check('enters warning', eng.liveView().state === 'warning');
  check('notification fired', notes.length === 1);
  for (let i = 0; i < 5; i++) eng.tick();
  check('countdown at 5', eng.liveView().warningLeft === 5);
  eng.onForegroundApp('Code');
  check('back to growing', eng.liveView().state === 'growing');
  check('no time lost during warning', eng.liveView().elapsedSec === 60);
}

console.log('warning -> death');
{
  const store = makeStore();
  const { eng } = makeEngine(store);
  eng.start({ mode: 'timer', plannedSec: 600, species: 'oak' });
  for (let i = 0; i < 60; i++) eng.tick();
  eng.onForegroundApp('Discord');
  for (let i = 0; i < 10; i++) eng.tick();
  check('session over', eng.liveView() === null);
  check('tree dead', store.forest.trees[0].result === 'dead');
  check('no coins', store.forest.coins === 0);
}

console.log('allowlist mode');
{
  const store = makeStore();
  store.forest.distractions = { mode: 'allowlist', apps: ['Code'] };
  const { eng } = makeEngine(store);
  eng.start({ mode: 'timer', plannedSec: 600, species: 'oak' });
  eng.onForegroundApp('Code');
  check('allowlisted app fine', eng.liveView().state === 'growing');
  eng.onForegroundApp('Screen Time');
  check('self app fine', eng.liveView().state === 'growing');
  eng.onForegroundApp('Random Game');
  check('unlisted app distracts', eng.liveView().state === 'warning');
}

console.log('pause blocks time and distraction checks');
{
  const store = makeStore();
  const { eng } = makeEngine(store);
  eng.start({ mode: 'timer', plannedSec: 600, species: 'oak' });
  for (let i = 0; i < 30; i++) eng.tick();
  check('pause ok', eng.pause().ok);
  for (let i = 0; i < 30; i++) eng.tick();
  check('no time while paused', eng.liveView().elapsedSec === 30);
  eng.onForegroundApp('Discord');
  check('no warning while paused', eng.liveView().state === 'paused');
  eng.resume();
  check('resumed', eng.liveView().state === 'growing');
  store.forest.settings.allowPause = false;
  check('pause disabled by setting', eng.pause().ok === false);
}

console.log('stopwatch under/over threshold');
{
  const store = makeStore();
  const { eng } = makeEngine(store);
  eng.start({ mode: 'stopwatch', species: 'oak' });
  for (let i = 0; i < 5 * 60; i++) eng.tick();
  const r = eng.finish();
  check('short stopwatch => dead', r.result === 'dead');

  eng.start({ mode: 'stopwatch', species: 'oak' });
  for (let i = 0; i < 30 * 60; i++) eng.tick();
  const r2 = eng.finish();
  check('30min stopwatch => success', r2.result === 'success');
  check('coins 30min => 15', store.forest.coins === 15);
}

console.log('coins math with long-session bonus');
{
  const store = makeStore();
  const { eng } = makeEngine(store);
  check('30min = 15', eng._coinsFor(30 * 60) === 15);
  check('59min = 29 (floor 59/2, no bonus)', eng._coinsFor(59 * 60) === 29);
  check('60min = 45 (30 * 1.5)', eng._coinsFor(60 * 60) === 45);
  check('120min = 90', eng._coinsFor(120 * 60) === 90);
}

console.log('give up');
{
  const store = makeStore();
  const { eng } = makeEngine(store);
  eng.start({ mode: 'timer', plannedSec: 600, species: 'oak' });
  for (let i = 0; i < 100; i++) eng.tick();
  const r = eng.giveup();
  check('givenup result', r.result === 'givenup');
  check('no coins', store.forest.coins === 0);
}

console.log('crash recovery');
{
  const store = makeStore();
  store.forest.activeSession = {
    id: 'tree_x', mode: 'timer', plannedSec: 600, species: 'oak',
    tag: null, taskId: null, startedAt: '2026-07-11T10:00:00.000Z', actualSec: 120
  };
  const { eng } = makeEngine(store);
  const tree = eng.recoverCrashed();
  check('recovered as dead', tree && tree.result === 'dead');
  check('snapshot cleared', store.forest.activeSession === null);
  check('in history', store.forest.trees.length === 1);
}

console.log('locked species falls back to selected');
{
  const store = makeStore();
  const { eng } = makeEngine(store);
  eng.start({ mode: 'timer', plannedSec: 600, species: 'baobab' });
  check('falls back to oak', eng.liveView().species === 'oak');
}

console.log('task accumulation on success');
{
  const store = makeStore();
  store.forest.tasks.push({ id: 'task_1', title: 'Write report', done: false, createdAt: '', doneAt: null, focusSec: 0, treeCount: 0 });
  // emulate store's task update on addTree (real store does this)
  const origAdd = store.forestAddTree;
  store.forestAddTree = (t) => {
    origAdd(t);
    if (t.taskId && t.result === 'success') {
      const task = store.forest.tasks.find((x) => x.id === t.taskId);
      if (task) { task.focusSec += t.actualSec; task.treeCount += 1; }
    }
    return t;
  };
  const { eng } = makeEngine(store);
  eng.start({ mode: 'timer', plannedSec: 600, species: 'oak', taskId: 'task_1' });
  for (let i = 0; i < 600; i++) eng.tick();
  check('task focusSec updated', store.forest.tasks[0].focusSec === 600);
  check('task treeCount updated', store.forest.tasks[0].treeCount === 1);
}

console.log(failures ? `\n${failures} FAILURES` : '\nall tests passed');
process.exit(failures ? 1 : 0);
