/**
 * Tutorial auto-show eligibility race (lib/tutorialTour.tsx).
 *
 * Proven root cause (physical repro on a genuinely new production account):
 * the auto-show effect used to write `autoCheckedScopeRef.current = scopeId`
 * the MOMENT the eligibility check started, before the async
 * `loadTutorialCompleted(scopeId)` read resolved. Real auth state is not
 * stable the instant scopeId first turns truthy — a slower, earlier-issued
 * `getSession()` call can still land after a newer sign-in and briefly flip
 * `session` (and therefore `scopeId`) back to null, cancelling the in-flight
 * check via the effect's own cleanup. Because the ref was already written,
 * the scope was permanently marked "checked" even though its result was
 * discarded — so when scopeId returned to the same value moments later, the
 * guard silently blocked any retry, and a genuinely new account could lose
 * its one shot at the tutorial for the rest of the app session.
 *
 * The fix: mark the scope checked only inside the completion callback, after
 * the `cancelled` check — never before the read starts. A cancelled check
 * now leaves the scope unmarked, so the next stable pass for that scope
 * retries it.
 *
 * This needs real microtask-ordered async simulation (not the source-level
 * regex idiom used elsewhere), because it's fundamentally a timing property.
 * `simulateEffect` below is a direct, line-for-line mirror of the fixed
 * lib/tutorialTour.tsx effect body — verified to match by the structural
 * checks in scripts/tutorial-tour.test.mjs (E1/E1b), so this simulation and
 * the real source cannot silently drift apart.
 */
import assert from 'node:assert/strict';

let passed = 0;
const check = async (label, fn) => {
  await fn();
  passed += 1;
  console.log(`  ok  ${label}`);
};

/**
 * Mirrors the real effect body exactly:
 *   if (autoCheckedScopeRef.current === scopeId) return;
 *   let cancelled = false;
 *   void loadTutorialCompleted(scopeId).then((completed) => {
 *     if (cancelled) return;
 *     autoCheckedScopeRef.current = scopeId;
 *     if (completed) return;
 *     setMomentIndex(0);
 *     setVisible(true);
 *   });
 *   return () => { cancelled = true; };
 *
 * `state.autoCheckedScope` stands in for the ref; `state.shown` records the
 * LAST scopeId the (simulated) tutorial was shown for; `readCompleted` is an
 * injectable async storage read so tests can control resolution order.
 */
function simulateEffect(state, scopeId, readCompleted) {
  if (state.autoCheckedScope === scopeId) return () => {};
  let cancelled = false;
  void readCompleted(scopeId).then((completed) => {
    if (cancelled) return;
    state.autoCheckedScope = scopeId;
    if (completed) return;
    state.shown = scopeId;
  });
  return () => {
    cancelled = true;
  };
}

const microtask = () => Promise.resolve();
const settle = async (ticks = 8) => {
  for (let i = 0; i < ticks; i += 1) await microtask();
};

console.log('1/2. Baseline behavior is preserved (no race involved)');

await check('a brand-new account (no completion key) sees the tutorial', async () => {
  const state = { autoCheckedScope: null, shown: null };
  const storage = {};
  simulateEffect(state, 'brand-new-user', async (id) => storage[id] === 'true');
  await settle();
  assert.equal(state.shown, 'brand-new-user');
  assert.equal(state.autoCheckedScope, 'brand-new-user');
});

await check('a completed account does not see the tutorial again', async () => {
  const state = { autoCheckedScope: null, shown: null };
  const storage = { 'completed-user': 'true' };
  simulateEffect(state, 'completed-user', async (id) => storage[id] === 'true');
  await settle();
  assert.equal(state.shown, null);
  assert.equal(state.autoCheckedScope, 'completed-user');
});

console.log('\n3. KEY REGRESSION — a cancelled in-flight check retries on the next stable pass for the SAME scope');

await check('cancel the check before AsyncStorage resolves, then bring the same scope back — the tutorial must still show', async () => {
  const state = { autoCheckedScope: null, shown: null };
  const storage = {}; // never completed — a genuinely new account
  const slowRead = async (id) => {
    await settle(4); // simulate a real AsyncStorage round-trip taking a few ticks
    return storage[id] === 'true';
  };

  // T3: effect starts for the real, new account.
  const cleanup = simulateEffect(state, 'new-user-real-id', slowRead);
  // T4: auth flips scopeId away before the read resolves (getSession() vs
  // onAuthStateChange race) — React runs this effect's cleanup.
  cleanup();
  // Let the now-cancelled read actually resolve.
  await settle();
  assert.equal(state.shown, null, 'a cancelled check must never show the tutorial');
  assert.equal(state.autoCheckedScope, null, 'a cancelled check must NOT mark the scope checked — this is the exact bug being fixed');

  // T7: scopeId returns to the SAME real account id (session reasserts itself).
  simulateEffect(state, 'new-user-real-id', slowRead);
  await settle();
  assert.equal(state.shown, 'new-user-real-id', 'the retried check must show the tutorial for the still-not-completed account');
  assert.equal(state.autoCheckedScope, 'new-user-real-id');
});

console.log('\n4. A cancelled check for account A cannot leak into a later check for account B');

await check('A cancels quickly, B becomes active and completes its own check — A never gets marked, never shown, and cannot clobber B afterward', async () => {
  const state = { autoCheckedScope: null, shown: null };
  const storage = {};
  const slowReadA = async (id) => {
    await settle(6); // A resolves LATE
    return storage[id] === 'true';
  };
  const fastReadB = async (id) => {
    await settle(1); // B resolves fast, well before A
    return storage[id] === 'true';
  };

  const cleanupA = simulateEffect(state, 'account-a', slowReadA);
  cleanupA(); // A cancelled almost immediately (auth moved on)
  simulateEffect(state, 'account-b', fastReadB);

  await settle(2);
  assert.equal(state.shown, 'account-b', 'B must get its own tutorial');
  assert.equal(state.autoCheckedScope, 'account-b', 'B must be marked checked, not A');

  // Let A's stale read finish resolving too — it must still no-op.
  await settle(8);
  assert.equal(state.shown, 'account-b', "account A's late resolution must not show A's tutorial");
  assert.equal(state.autoCheckedScope, 'account-b', "account A's late resolution must not overwrite B's checked scope");
});

console.log('\n5. Account switch stays isolated: A completed, logout, brand-new B still gets the tutorial');

await check('a completed account A logging out and a genuinely new account B signing in on the same device — B is unaffected by A', async () => {
  const storage = { 'account-a': 'true' }; // A already completed the tour
  const stateA = { autoCheckedScope: null, shown: null };
  simulateEffect(stateA, 'account-a', async (id) => storage[id] === 'true');
  await settle();
  assert.equal(stateA.shown, null, 'A (already completed) does not see it again');

  // Logout/login on the same device is a fresh provider instance in the real
  // app (TutorialTourProvider is mounted once at the root and its ref lives
  // for the life of that instance) — model that as fresh state.
  const stateB = { autoCheckedScope: null, shown: null };
  simulateEffect(stateB, 'account-b', async (id) => storage[id] === 'true');
  await settle();
  assert.equal(stateB.shown, 'account-b', 'a genuinely new account B must get the tutorial regardless of A\'s history');
});

console.log(`\ntutorial-auto-show-race: ${passed} checks passed`);
