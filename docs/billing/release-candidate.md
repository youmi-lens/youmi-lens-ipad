# Billing RC 0.2.2 (64)

Base: public 0.2.1 Build 63 commit 41d1d655e667903ad0822e36b7c8cf8ea266293f. Delta includes backend availability AND StoreKit gating, generic purchase admission, per-item Restore finishing, immutable purchase identity, Settings/Plans request generations and minimal subscription copy. No new Course Material changes. Recording engine, product IDs, prices and quota are unchanged.

Build profile: billing-hardening-rc, store distribution, Production backend, real IAP, subscription master on. Backend monthly/annual sales remain false, so purchase stays unavailable despite master on. This is a TestFlight-ready archive; build creation does not mean physical QA, TestFlight upload or public release succeeded.

Run `node scripts/run-billing-qualification.mjs` for thirteen payment suites / 169 entries. All payment behavior checks in Phase 3 run. Only pre-existing hardcoded release 0.2.1 / Build 57 assertions are isolated in a temporary runner; those original assertions remain unchanged. Backend ownership coverage uses the sibling authoritative backend branch and its real SQL atomic operation, replacing obsolete guest-claim source assertions. Typecheck, targeted lint and diff check are also required.

Device qualification must establish: closed sales renders unavailable and never starts StoreKit; account switches cannot display prior account access or unlock new actions; valid explicitly approved Sandbox Restore finishes only authorized items; ownership, sales, revocation and transient failures remain unfinished; Chinese active copy is 已开通. Do not replay recovered Production Incident A. Do not open Production sales to test this RC. New Sandbox chains need deliberate policy provisioning or a staging environment.

Current public Build 63 lacks the availability and finishing contract. Reopening remains NO-GO until this RC passes physical qualification and the hardened client is publicly available; PR/mainline integration must also be completed.
