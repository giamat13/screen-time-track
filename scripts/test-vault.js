// Exercises the vault feature (sweep split, daily growth accrual, deposit/withdraw)
// against store.js directly, with a temp userData dir and a stubbed `electron` module
// (store.js requires `electron` at load time; see test/budget-rollover.test.js for the
// same stub pattern).
// Run: node scripts/test-vault.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'st-vault-test-'));
const realLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'electron') return { app: { getPath: () => userData } };
  return realLoad.call(this, request, ...rest);
};

const store = require('../src/main/store.js');
store.load();

let failures = 0;
function check(name, cond) {
  if (cond) { console.log('  ok', name); }
  else { failures++; console.error('  FAIL', name); }
}
function approx(a, b, tol) { return Math.abs(a - b) <= tol; }

console.log('sweep split (unused budget divides between vault and rollover)');
{
  store.setSettings({ vault: { enabled: true, sweepPercent: 75, weeklyGrowthPercent: 0 } });
  store.setSettings({ timeBudget: { enabled: true, rollover: true } });
  store.setGlobalLimit(60 * 60); // 1h/day

  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const yKey = store.dateKey(yesterday);
  // 20m used out of 60m allowance => 40m unused
  store.raw().days[yKey] = {
    apps: { Chrome: 1200 }, total: 1200, study: 0, studyApps: {},
    hours: new Array(24).fill(0), firstSeen: yesterday.toISOString(), lastSeen: yesterday.toISOString(),
    vaultDeposited: 0, vaultWithdrawn: 0,
  };

  const vaultBefore = store.getVaultStatus().seconds;
  store.addTime('Chrome', 10); // first touch of today -> creates the day -> triggers the sweep
  const rollover = store.getTimeBudgetStatus().rolloverSeconds;
  const sweptToVault = store.getVaultStatus().seconds - vaultBefore;

  check('75% of unused went to the vault', approx(sweptToVault, 40 * 60 * 0.75, 1));
  check('remaining 25% became rollover', approx(rollover, 40 * 60 * 0.25, 1));
  check('sweep + rollover reconstruct the original unused total', approx(sweptToVault + rollover, 40 * 60, 1));
}

console.log('daily growth accrual (compounds to weeklyGrowthPercent after 7 days)');
{
  store.setSettings({ vault: { enabled: true, sweepPercent: 0, weeklyGrowthPercent: 10 } });
  const before = store.getVaultStatus().seconds; // settles "now", pins lastAccrualDate to today
  const sevenAgo = new Date();
  sevenAgo.setDate(sevenAgo.getDate() - 7);
  store.raw().vault.lastAccrualDate = store.dateKey(sevenAgo);
  const after = store.getVaultStatus().seconds;
  check('7 elapsed days at 10%/week grows ~10%', approx(after, before * 1.10, Math.max(0.5, before * 0.0005)));

  const again = store.getVaultStatus().seconds;
  check('0 elapsed days is a no-op', again === after);
}

console.log('changing the growth rate applies going forward only');
{
  store.setSettings({ vault: { enabled: true, sweepPercent: 0, weeklyGrowthPercent: 10 } });
  const threeAgo = new Date();
  threeAgo.setDate(threeAgo.getDate() - 3);
  store.raw().vault.lastAccrualDate = store.dateKey(threeAgo);
  const settled = store.getVaultStatus().seconds; // accrues 3 days at 10%/week, lastAccrualDate -> today
  store.setSettings({ vault: { weeklyGrowthPercent: 50 } });
  const immediatelyAfter = store.getVaultStatus().seconds; // still today -> 0 elapsed days
  check('rate change does not retroactively touch already-accrued balance', immediatelyAfter === settled);
}

console.log('deposit (clamped to remaining budget, reduces budgetSeconds)');
{
  store.setSettings({ vault: { enabled: true, sweepPercent: 75, weeklyGrowthPercent: 0 } });
  store.setGlobalLimit(60 * 60);
  const status0 = store.getTimeBudgetStatus();
  const remaining = status0.budgetSeconds - status0.usedSeconds;

  const vaultBefore = store.getVaultStatus().seconds;
  store.depositToVault(remaining + 10000); // over-ask, must clamp
  const status1 = store.getTimeBudgetStatus();
  const vaultAfter = store.getVaultStatus().seconds;

  check('deposit clamped to remaining budget', approx(vaultAfter - vaultBefore, remaining, 1));
  check('budgetSeconds reduced by the deposited amount', approx(status1.budgetSeconds, status0.budgetSeconds - remaining, 1));
}

console.log('withdraw (clamped to vault balance, increases budgetSeconds)');
{
  const vaultBalance = store.getVaultStatus().seconds;
  const status0 = store.getTimeBudgetStatus();
  store.withdrawFromVault(vaultBalance + 10000); // over-ask, must clamp
  const status1 = store.getTimeBudgetStatus();
  const vaultAfter = store.getVaultStatus().seconds;

  check('withdraw clamped to vault balance', approx(vaultAfter, 0, 1));
  check('budgetSeconds increased by the withdrawn amount', approx(status1.budgetSeconds, status0.budgetSeconds + vaultBalance, 1));
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nAll vault tests passed');
process.exit(failures ? 1 : 0);
