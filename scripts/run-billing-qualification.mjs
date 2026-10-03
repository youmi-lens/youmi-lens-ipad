// Isolate only the existing Phase 3 assertions fixed to release 0.2.1 Build 57.
// Product, quota, StoreKit and payment assertions in that file still run unchanged.
import { readFileSync,writeFileSync,mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
const directory=mkdtempSync(join(tmpdir(),'youmi-billing-qualification-'));
const phase3=join(directory,'phase3-billing.mjs');
const source=readFileSync('scripts/phase3-purchases.test.mjs','utf8');
writeFileSync(phase3,source.split('\n').filter(line=>!line.startsWith('assert.equal(appConfig.expo.')).join('\n'));
const tests=['subscriptions','subscription-permanent-hardening','payment-hardening','subscription-live-gate','storekit-presentation','free-trial-ux','purchase-stall-fix','iap-linked-rejection-second-attempt','i18n','guest-purchase-architecture','iap-late-ownership-rejection-settles-attempt','restore-purchase-bound'].map(name=>`scripts/${name}.test.mjs`);
try {
 console.log('Isolated existing Phase 3 release 0.2.1 / Build 57 assertions; all billing checks retained.');
 const result=spawnSync(process.execPath,['--experimental-strip-types','--test',...tests,phase3],{stdio:'inherit'});
 process.exitCode=result.status??1;
} finally {rmSync(directory,{recursive:true,force:true});}
