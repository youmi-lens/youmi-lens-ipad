/**
 * Account deletion consistency tests (ordering contract).
 * Run: node --experimental-strip-types scripts/account-deletion.test.mjs
 */
import assert from 'node:assert/strict';

import { runAccountDeletion } from '../lib/accountDeletion.ts';

let passed = 0;
function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed += 1;
      console.log(`ok - ${name}`);
    });
}

const tasks = [];

tasks.push(
  check('G: auth delete failure does not run profile/business cleanup', async () => {
    const steps = [];
    await assert.rejects(
      () =>
        runAccountDeletion({
          userId: 'user-1',
          prepareApple: async () => {
            steps.push('prepare');
          },
          deleteAuthUser: async () => {
            steps.push('auth');
            return { error: { message: 'database error deleting user' } };
          },
          removeStorage: async () => {
            steps.push('storage');
            return { removed: 0 };
          },
          deleteBusinessRows: async () => {
            steps.push('profiles');
            return [{ table: 'profiles' }];
          },
        }),
      (err) => err?.name === 'AuthDeleteFailedError',
    );
    assert.deepEqual(steps, ['prepare', 'auth']);
    assert.ok(!steps.includes('profiles'));
    assert.ok(!steps.includes('storage'));
  }),
);

tasks.push(
  check('H: auth success then business + storage cleanup', async () => {
    const steps = [];
    const result = await runAccountDeletion({
      userId: 'user-2',
      prepareApple: async () => {
        steps.push('prepare');
      },
      deleteAuthUser: async () => {
        steps.push('auth');
        return { error: null };
      },
      removeStorage: async () => {
        steps.push('storage');
        return { removed: 2 };
      },
      deleteBusinessRows: async () => {
        steps.push('profiles');
        return [{ table: 'profiles' }, { table: 'recordings' }];
      },
    });
    assert.equal(result.ok, true);
    assert.equal(result.authDeleted, true);
    assert.deepEqual(steps, ['prepare', 'auth', 'storage', 'profiles']);
    assert.equal(result.cleanupErrors.length, 0);
  }),
);

tasks.push(
  check('I: auth success + cleanup failure still reports authDeleted (no Auth orphan)', async () => {
    const result = await runAccountDeletion({
      userId: 'user-3',
      prepareApple: async () => {},
      deleteAuthUser: async () => ({ error: null }),
      removeStorage: async () => {
        throw new Error('storage timeout');
      },
      deleteBusinessRows: async () => {
        throw new Error('profiles wipe failed');
      },
    });
    assert.equal(result.ok, true);
    assert.equal(result.authDeleted, true);
    assert.equal(result.cleanupErrors.length, 2);
    assert.ok(result.cleanupErrors.some((e) => e.step === 'storage'));
    assert.ok(result.cleanupErrors.some((e) => e.step === 'business_rows'));
  }),
);

tasks.push(
  check('auth user already gone (not found) is treated as success', async () => {
    const result = await runAccountDeletion({
      userId: 'user-4',
      prepareApple: async () => {},
      deleteAuthUser: async () => ({ error: { message: 'User not found' } }),
      removeStorage: async () => ({ removed: 0 }),
      deleteBusinessRows: async () => [],
    });
    assert.equal(result.ok, true);
    assert.equal(result.authDeleted, true);
  }),
);

tasks.push(
  check('prepare failure aborts before auth delete', async () => {
    const steps = [];
    await assert.rejects(() =>
      runAccountDeletion({
        userId: 'user-5',
        prepareApple: async () => {
          steps.push('prepare');
          const err = new Error('Account deletion is temporarily unavailable.');
          err.name = 'AccountDeletionTemporarilyUnavailableError';
          throw err;
        },
        deleteAuthUser: async () => {
          steps.push('auth');
          return { error: null };
        },
        removeStorage: async () => {
          steps.push('storage');
        },
        deleteBusinessRows: async () => {
          steps.push('profiles');
          return [];
        },
      }),
    );
    assert.deepEqual(steps, ['prepare']);
  }),
);

await Promise.all(tasks);
console.log(`\n${passed} account-deletion checks passed`);
