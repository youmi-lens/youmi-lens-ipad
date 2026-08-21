/**
 * Client deleteAccount response contract.
 * Run: node --experimental-strip-types scripts/account-client.test.mjs
 *
 * Settings only clears local session after deleteAccount resolves; failures must throw.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const accountSrc = fs.readFileSync(path.join(root, 'lib/account.ts'), 'utf8');
const settingsSrc = fs.readFileSync(path.join(root, 'app/(tabs)/settings.tsx'), 'utf8');

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  console.log(`ok - ${name}`);
}

check('deleteAccount throws unless response.ok and payload.ok', () => {
  assert.match(accountSrc, /if \(!response\.ok \|\| !payload\?\.ok\)/);
  assert.match(accountSrc, /throw new Error/);
});

check('settings clears local state only after successful deleteAccount', () => {
  const perform = settingsSrc.slice(
    settingsSrc.indexOf('const performAccountDeletion'),
    settingsSrc.indexOf('const confirmDeleteAccount'),
  );
  const deleteCall = perform.indexOf('await deleteAccount(token)');
  const clearAll = perform.indexOf('await clearAll()');
  const signOut = perform.indexOf('await signOut()');
  const catchBlock = perform.indexOf('} catch (error)');
  assert.ok(deleteCall >= 0 && clearAll > deleteCall && signOut > clearAll);
  assert.ok(catchBlock > signOut);
  assert.match(perform.slice(catchBlock), /deleteFailTitle/);
  assert.doesNotMatch(perform.slice(catchBlock), /clearAll\(/);
  assert.doesNotMatch(perform.slice(catchBlock), /signOut\(/);
});

check('settings shows deleted alert only on success path', () => {
  const perform = settingsSrc.slice(
    settingsSrc.indexOf('const performAccountDeletion'),
    settingsSrc.indexOf('const confirmDeleteAccount'),
  );
  const tryBlock = perform.slice(perform.indexOf('try {'), perform.indexOf('} catch'));
  assert.match(tryBlock, /accountDeletedTitle/);
  const catchBlock = perform.slice(perform.indexOf('} catch'));
  assert.doesNotMatch(catchBlock, /accountDeletedTitle/);
});

console.log(`\n${passed} account-client checks passed`);
