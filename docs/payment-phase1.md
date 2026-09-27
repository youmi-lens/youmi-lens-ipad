# Payment hardening — Phase 1

Base: `c49088dc695291bb82777c8ffa7db02adff63891`.
Worktree branch: `codex/payment-hardening`.

Settings and Plans now use `subscriptionService.restore`, including current
monthly/annual subscriptions and the existing legacy product list. The backend
remains the only entitlement authority. No product, price, quota, bundle,
backend contract, or App Store Connect configuration changes are included.

## Regressions first

Each defect was reproduced before its fix with executable production-service
tests. The harness compiles actual TypeScript modules and executes the actual
Plans/Settings handler functions located by the TypeScript AST. StoreKit,
HTTP/auth/storage boundaries, UI effects and the clock are supplied by the
harness; no purchase/restore service or handler implementation is replaced.

| Defect | Failure before fix | Result after fix |
| --- | --- | --- |
| P1 Settings subscription restore | Monthly and annual restore never verified/granted | Both use shared restore and refresh account status |
| P2 unbounded native waits | Five setup/query timeout cases remained unsettled | Typed timeout, cleanup and retry; response/identity/refresh waits also bounded |
| P3 initialization/listeners | Concurrent init installed two pairs; cleanup during init installed stale listeners | One shared init and one pair, with generation and partial-registration cleanup |
| P4 callback association | Wrong product, old attempt and duplicate could resolve a new request; late paid event was ignored | Product/account/date/transaction checks, callback dedupe and independent reconciliation |
| P5 cancellation code | Five code-only/native-shaped rejection cases showed purchase failure | Installed public error normalizer handles canonical, camel and legacy codes |
| P6 query failure versus no purchase | Empty restore had no explicit no-purchase code | Distinct `no_purchase`, StoreKit error and timeout outcomes; Settings preserves the distinction |

## Wait bounds

| Operation | Application wait |
| --- | --- |
| StoreKit init, product query, purchase-history query, intro eligibility | 15 seconds each |
| Restore sync | 30 seconds |
| Verification/restore/entitlement HTTP request plus response body | 25 seconds total |
| Purchase identity and UI account-status refresh | 25 seconds each |
| Finish transaction after backend decision | 10 seconds; failure/timeout preserves the backend result |
| Apple purchase sheet/event | Existing 120-second window |

Native timeouts stop application waiting; they do not claim to cancel native
StoreKit work. Late init/query results cannot install stale listeners or mutate
the product cache after cleanup. A finish timeout leaves the paid transaction
available for StoreKit replay/explicit restore.

## Callback handling

An active attempt accepts a new transaction only for its requested product and
account, with a transaction ID and date at or after that request. Known duplicate
IDs and older/wrong-product transactions cannot complete the active attempt.

A valid late transaction with a matching known purchase identity is verified
once independently, then the account entitlement is reread. It never resolves
an unrelated UI attempt. Missing/mismatched identity leaves it unfinished in
StoreKit for explicit restore; a bounded in-memory queue also retries when a
matching identity becomes available. Failed independent verification likewise
leaves it unfinished for restore. Explicit restore still re-verifies with the
backend; replay protection and entitlement rules are unchanged.

## Executable release matrix

Run `npm run test:payment`. The new behavioral suite covers all 23 requested
cases, including actual UI cleanup and account-status handlers:

| Requested cases | Executable coverage |
| --- | --- |
| 1, 5–7 | Purchase success, rejection, network/response timeout, finish timeout/failure |
| 2–4, 23 | Six cancellation shapes; no verify/refresh/grant; repeat attempt succeeds |
| 8–9 | Init/product timeout, UI cleanup and retry |
| 10–11 | Settings monthly and annual success, transaction finish and refresh |
| 12–13 | No purchase versus StoreKit query failure and safe messages |
| 14–15 | Settings backend timeout/rejection and finish timeout/failure |
| 16 | Terminal outcomes through actual Plans and Settings handlers; identity/status hangs |
| 17 | Concurrent init, cleanup during init, late completion and partial-listener failure |
| 18–20 | Matching, wrong-product/account, older and late callbacks |
| 21 | Duplicate callback verifies once; explicit restore recovers failed verification |
| 22 | Actual backend status refresh after verified purchase; confirmed UI access |

The older source-contract tests remain supplemental; they do not substitute
for these behavioral regressions or physical Apple testing.

Phase 1 validation: 132 frontend payment tests passed, including 54 new
executable regressions. Seven backend IAP/subscription test files passed all
132 tests; no backend source was changed. TypeScript passed with no errors.
Targeted ESLint passed with zero errors and five pre-existing warnings. The
diff whitespace check and review of protected files passed.

## Release diagnostics

`[iap-diag]` survives release builds. Existing request/update/busy markers plus
new cancellation, wrong-attempt, late-event, verify, finish, restore and
entitlement-refresh markers distinguish the requested stages. Values contain
only product/plan identifiers, flags and fixed failure categories. Receipt/JWS,
auth tokens, transaction IDs and account identifiers are never logged.

`purchase_request_start` means the native request was issued. It does not prove
the Apple sheet was visible; the owner must observe that during physical QA.

## Physical acceptance remains pending

No physical purchase, cancellation, restore, reset/reinstall, submission or
App Store Connect mutation was performed in Phase 1. Build and verify the
release candidate's real-IAP/subscription-live configuration, then use
TestFlight/Apple sandbox in this order:

1. Cancel: sheet visible, cancellation recognized, spinner ends, no new
   entitlement, another attempt works.
2. Success: real sandbox transaction, backend verification, spinner ends,
   correct account entitlement and UI.
3. Settings Restore: current subscription restored/refreshed, clear result,
   spinner ends, correct entitlement.

If meaningful restore coverage requires reinstalling or changing account
state, describe the exact procedure and obtain owner authorization before any
destructive reset. Automated results do not mark any physical case PASS.
