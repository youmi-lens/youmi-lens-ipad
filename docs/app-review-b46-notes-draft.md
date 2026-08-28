# App Review Notes — draft for the next submission (post Build 46 rejection)

Status: **draft, not yet submitted.** Paste into App Store Connect → App Review
Information → Notes once Build 46's remaining two items (below) are resolved.

---

Thank you for the detailed feedback. Here is what changed for each item:

**Guideline 2.5.4 — Background audio.** Youmi Lens genuinely requires
persistent background audio: a student places the iPad on a desk to record a
full lecture, and needs to lock the screen or switch apps (check a message,
silence a notification) without the recording stopping. This is exercised on
every recording session, not an incidental capability. A physical-device
screen recording demonstrating this is attached [owner to attach — see the
retest steps below]: start a recording, lock the device, wait 30+ seconds,
unlock, and show the recording is still running with continuous elapsed time.

**Guideline 4 — Sign in with Apple.** Fixed. The app no longer asks the user
to re-enter a name after Sign in with Apple. On first authorization, the name
Apple returns is used immediately and automatically — no form is shown. On a
repeat authorization (where Apple does not return a name), the user is never
blocked either: the app derives a placeholder identity in the background and
lets them straight into the app. A display name can still be changed any time
in Settings, but it is never required to authenticate.

**Guideline 3.1.2(c) — Subscription pricing hierarchy.** Fixed. The billed
amount ($4.99/month or $49.99/year) is now always the primary, largest,
boldest element on each plan card. "1 month free" is a smaller, visually
secondary badge beneath it. Below that, in the smallest text, the card states
the exact renewal terms: "Then $X/month, auto-renews until canceled." No
product ID, price, or trial duration changed — this is a visual-hierarchy fix
only.

**Guideline 5.1.1(v) — Registration before purchase.** [owner: fill in once
resolved — see the architecture note below.] Target behavior: a user can
continue without an account, reach Student Basic, and purchase or restore an
Apple subscription without registering. Creating an account remains available
and is used only to sync the purchase and study content across devices later.

---

## Owner: what's still open

1. **2.5.4** — needs a physical-device screen recording (see retest steps in
   the engineering report) attached to this submission or the resolution notes.
2. **5.1.1(v)** — needs one decision + one config action before the guest
   purchase path can ship. See "Guideline 5.1.1(v) architecture classification"
   in the engineering report for the two-line summary and the exact toggle
   (Supabase Dashboard → Authentication → Providers → Anonymous Sign-Ins, on
   both the staging and production projects).
