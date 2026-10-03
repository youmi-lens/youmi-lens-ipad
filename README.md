# Youmi Lens for iPad

An iPad-first **AI lecture companion for international students**.

> **This is the canonical Youmi Lens iPad / iOS client repository.**  
> The Desktop / Web / Backend side of Youmi Lens lives in
> **[youmi-lens/youmi-lens](https://github.com/youmi-lens/youmi-lens)**. It
> contains the macOS/Windows app, the website, the API server and the Supabase
> schema that this app talks to.

Youmi Lens helps students record lectures, follow live captions, keep their
notes and course materials together, and review AI-generated transcripts and
bilingual (EN + ZH) summaries after class.

## Platforms

| Platform | Repository | Stack |
| --- | --- | --- |
| iPad / iOS | **[youmi-lens/youmi-lens-ipad](https://github.com/youmi-lens/youmi-lens-ipad)** (this repo) | Expo (SDK 54) / React Native / TypeScript, Expo Router |
| Desktop (macOS, Windows) / Web / Backend | [youmi-lens/youmi-lens](https://github.com/youmi-lens/youmi-lens) | React + Vite, Tauri 2, Node API server |

The two repositories use **different tooling**; follow the instructions in each
repo. They share one account system and one backend, so a change to an API,
entitlement rule or database contract in either repository may affect the other.
Check the sibling repo before changing a shared contract (see
`docs/cloud-library-contract.md`).

## What the app does

- Courses and lectures, kept locally and synced to the cloud library
- Lecture recording, including a native durable recorder module, with live captions
- Post-class processing: transcripts and bilingual summaries (via the shared backend)
- Course materials with PDF and Apple Pencil annotation, plus lecture notebooks
- Recently Deleted (soft delete, synced across devices)
- Accounts via Supabase Auth: email + password, Sign in with Apple, Google
- Subscriptions via Apple StoreKit / IAP, with entitlements decided by the backend

## Repository structure

| Path | What lives here |
| --- | --- |
| `app/` | Expo Router routes: tabs (Record, Courses, Settings), recording, lecture, course, material, plans, auth |
| `components/` | Reusable UI |
| `lib/` | App logic: auth, sync, recording, billing/purchases, i18n, API client (`config.ts`) |
| `modules/` | Local native Expo modules (durable recorder, PDF annotation, Pencil interaction, word lookup, …) |
| `plugins/` | Expo config plugins |
| `constants/`, `data/` | Theme and responsive constants, mock data |
| `storekit/` | Local StoreKit configuration for testing |
| `supabase/` | SQL migrations and rollbacks owned by this app |
| `scripts/` | Test suites (`*.test.mjs`) and verification tooling |
| `docs/` | Contracts, billing notes and `docs/verification/` (native recording verification) |

## Development setup

### Prerequisites

- **Node.js 22+** and npm (the test scripts use `node --experimental-strip-types`)
- **macOS with Xcode** for simulator or device builds
- An **Apple Developer** setup for running on a physical iPad (ask the project lead)

### Install

```bash
npm install
cp .env.example .env   # then fill in your own values
```

Environment variables (names only; `.env` is git-ignored):

| Variable | Purpose |
| --- | --- |
| `EXPO_PUBLIC_SUPABASE_URL`, `EXPO_PUBLIC_SUPABASE_ANON_KEY` | Supabase project. **Anon key only.** |
| `EXPO_PUBLIC_API_BASE_URL` | Backend API origin (from the desktop/backend repo's `server/`) |
| `EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID`, `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID` | Google sign-in client IDs |
| `EXPO_PUBLIC_NATIVE_RECORDER_DOGFOOD`, `EXPO_PUBLIC_RECORDING_ROLLOUT_REMOTE` | Recording rollout flags; leave at the defaults in `.env.example` unless told otherwise |

Everything prefixed `EXPO_PUBLIC_` is bundled into the app and therefore
public. **Never** put a Supabase service-role key, Apple/App Store Connect
credentials, signing material or any other server-only secret in this project.
Development builds are guarded against silently pointing at the production
Supabase project (`npm run test:envguard`); use a development or staging
project.

### Run

This app uses custom native modules, so **Expo Go cannot run it**. Use a native
development build:

```bash
npm run ios                                        # expo run:ios (simulator or device)
APP_VARIANT=development npx expo run:ios --device "<device name>"
                                                   # side-by-side "Youmi Lens Dev" build that
                                                   # does not replace the real app on a device
npx expo start                                     # Metro bundler for an installed dev build
```

EAS build profiles (`development`, `development-simulator`, `preview`,
`production`, …) are defined in `eas.json`. Production and TestFlight builds are
release work: do not trigger them without the project lead's go-ahead.

### Checks

```bash
npx tsc --noEmit        # type-check
npm run lint            # expo lint
npm run test:recording  # any change touching recording (~7s, no device needed)
npm run test:payment    # any change touching purchases / subscriptions
npm run test:auth       # sign-up, account deletion, account client
```

Other suites are available as `npm run test:<name>` (see `package.json`, for
example `test:deletion-sync`, `test:i18n`, `test:envguard`). Run the suites that
cover the area you changed before opening a PR. Recording-specific verification
steps and the release gate are documented in `docs/verification/`.

## Development workflow

```
Issue / task → dedicated branch → implementation → tests → Pull Request → review → Squash merge
```

- `main` is protected by repository rules: changes go through a Pull Request and
  are squash-merged. **Do not develop directly on `main`** and **never force-push
  it**.
- **One task, one clear owner.** Keep each PR scoped to its assigned task.
- Create a branch per task (for example `feat/…`, `fix/…`, `docs/…`).
- Run the relevant checks locally before opening the PR, and describe what you
  tested in the PR.
- Product and engineering direction is coordinated by the project lead.
  High-risk changes (below) get additional review before merging.

## High-risk areas

Take extra care, add or run the matching tests, and request extra review when
touching:

- **Recording and audio durability** (`modules/expo-durable-recorder`,
  recording code in `lib/`, see `docs/verification/`)
- **Payments**: StoreKit / IAP, subscriptions, restore purchases
- **Entitlement and quota logic** (the backend is the entitlement authority)
- **Authentication and account deletion**
- **Database schema and migrations** (`supabase/`), shared with the backend repo
- **Production configuration**: `app.json`, `eas.json`, bundle identifiers, entitlements
- **Apple signing, provisioning and release configuration**

Do not change bundle identifiers, product IDs, prices or quotas as part of
unrelated work. Never commit credentials, signing keys or production data.

## Contributing

There is no separate `CONTRIBUTING.md` yet; the workflow above is the
contributor guide. Open an issue or ask the project lead before starting
anything large or touching a high-risk area.
