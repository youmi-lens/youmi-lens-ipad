#!/usr/bin/env node
/**
 * Pinned backend billing contract — generator and verifier.
 *
 * `guest-purchase-architecture.test.mjs` asserts a few facts about the BACKEND's guest/ownership implementation.
 * It used to read them from a sibling `../../youmi-lens` checkout, which depends on the machine and on whichever
 * revision happens to be checked out. It now reads `scripts/fixtures/backend-billing-contract.json`, a snapshot of ONLY
 * the surface those assertions need, pinned to one backend revision.
 *
 * A snapshot cannot notice the backend changing. That is this script's job:
 *
 *   node scripts/backend-billing-contract.mjs --verify   --backend <path-to-backend-git-checkout>
 *   node scripts/backend-billing-contract.mjs --generate --backend <path-to-backend-git-checkout> --revision <sha>
 *
 * There is deliberately NO default path and NO search for a checkout: the backend location is always passed in
 * explicitly. Everything is read from git objects at the pinned revision, never from the working tree, so the state of
 * the checkout (branch, dirty files) cannot influence the result. `--verify` fails if the revision is missing, if any
 * pinned file's blob hash differs, or if any pinned fragment/fact no longer matches.
 *
 * The behaviour itself is enforced where it belongs, in the backend repository's `subscriptionAtomic.test.mjs`
 * (real PostgreSQL); this contract only pins what the iPad client's design assumes.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const FIXTURE_URL = new URL('./fixtures/backend-billing-contract.json', import.meta.url);
const MIGRATION = 'supabase/migrations/20261003011254_billing_atomic_subscription_persistence.sql';
const SUBSCRIPTIONS = 'server/iapSubscriptions.mjs';
const ROUTES = 'server/iapRoutes.mjs';

/** Each entry is one line of the migration that the iPad assertions depend on, located by a literal needle. */
const MIGRATION_NEEDLES = [
  ['token-must-match-user', "if v_token<>p_user_id then raise exception 'subscription_token_mismatch'"],
  ['owner-conflict-guard', 'v_notification or v_caller_anonymous or not v_owner_anonymous'],
  ['owner-conflict-raise', "raise exception 'subscription_owner_conflict'"],
  ['promotion-checks-anonymous-owner', 'v_owner_anonymous=billing_private.lock_auth_identity(b.user_id)'],
  ['promotion-retires-guest-state', "update public.app_store_subscription_states set status='expired'"],
  ['promotion-scoped-to-old-owner', "where original_transaction_id=v_original and user_id=b.user_id and owner_state='active'"],
];
const ROUTE_NEEDLES = [
  ['already-linked-class', 'class AlreadyLinkedError extends Error'],
  ['already-linked-code', 'iap_already_linked'],
];

function git(backend, args) {
  return execFileSync('git', ['-C', backend, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}
const show = (backend, revision, path) => git(backend, ['show', `${revision}:${path}`]);
const blob = (backend, revision, path) => git(backend, ['rev-parse', `${revision}:${path}`]).trim();

function firstLine(text, needle) {
  const index = text.split('\n').findIndex((line) => line.includes(needle));
  if (index < 0) throw new Error(`pinned fragment not found: ${needle}`);
  return { line: index + 1, text: text.split('\n')[index].trim() };
}

function functionText(source, signature) {
  const start = source.indexOf(signature);
  if (start < 0) throw new Error(`function not found: ${signature}`);
  const end = source.indexOf('\n}\n', start);
  return source.slice(start, end + 2);
}

/** Computes the whole contract from git objects at `revision`. Used by both --generate and --verify. */
export function extractContract(backend, revision) {
  const full = git(backend, ['rev-parse', '--verify', `${revision}^{commit}`]).trim();
  const subscriptions = show(backend, full, SUBSCRIPTIONS);
  const routes = show(backend, full, ROUTES);
  const migration = show(backend, full, MIGRATION);
  return {
    provenance: {
      backendRepository: 'https://github.com/youmi-lens/youmi-lens',
      revision: full,
      revisionSubject: git(backend, ['log', '-1', '--format=%s', full]).trim(),
      note: 'Billing permanent-hardening revision; pull request youmi-lens/youmi-lens#47. Ownership behaviour is enforced by the backend subscriptionAtomic.test.mjs (real PostgreSQL).',
      files: {
        [SUBSCRIPTIONS]: blob(backend, full, SUBSCRIPTIONS),
        [ROUTES]: blob(backend, full, ROUTES),
        [MIGRATION]: blob(backend, full, MIGRATION),
      },
    },
    subscriptions: { verifyAndPersistSubscription: functionText(subscriptions, 'export async function verifyAndPersistSubscription') },
    routes: {
      fragments: Object.fromEntries(ROUTE_NEEDLES.map(([id, needle]) => [id, firstLine(routes, needle)])),
      // Whole-file negative fact: no `res.json({ ... signedPayload ... })` anywhere in the routes.
      echoesSignedPayloadInJson: /res\.json\(\{[^}]*signedPayload/.test(routes),
    },
    migration: { fragments: Object.fromEntries(MIGRATION_NEEDLES.map(([id, needle]) => [id, firstLine(migration, needle)])) },
  };
}

export function loadFixture() {
  return JSON.parse(readFileSync(FIXTURE_URL, 'utf8'));
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function main() {
  const mode = process.argv.includes('--generate') ? 'generate' : process.argv.includes('--verify') ? 'verify' : null;
  const backend = argument('--backend');
  if (!mode || !backend) {
    console.error('usage: backend-billing-contract.mjs (--verify | --generate --revision <sha>) --backend <git checkout path>');
    process.exit(2);
  }
  if (mode === 'generate') {
    const revision = argument('--revision');
    if (!revision) { console.error('--generate requires --revision <sha>'); process.exit(2); }
    writeFileSync(fileURLToPath(FIXTURE_URL), `${JSON.stringify(extractContract(backend, revision), null, 2)}\n`);
    console.log(`wrote ${fileURLToPath(FIXTURE_URL)} @ ${revision}`);
    return;
  }
  const pinned = loadFixture();
  let fresh;
  try {
    fresh = extractContract(backend, pinned.provenance.revision);
  } catch (error) {
    console.error(`FAIL: cannot read pinned revision ${pinned.provenance.revision} from ${backend}: ${error.message}`);
    process.exit(1);
  }
  const same = JSON.stringify(fresh) === JSON.stringify(pinned);
  if (!same) {
    for (const key of Object.keys(fresh)) {
      if (JSON.stringify(fresh[key]) !== JSON.stringify(pinned[key])) console.error(`FAIL: pinned "${key}" differs from backend ${pinned.provenance.revision}`);
    }
    process.exit(1);
  }
  console.log(`OK: fixture matches backend ${pinned.provenance.revision} (${pinned.provenance.revisionSubject})`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
