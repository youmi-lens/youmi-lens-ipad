# Youmi Lens for iPad — V1

An iPad-first **AI lecture companion for international students**. Youmi Lens
helps students create courses, record lectures locally, and later generate
transcripts and bilingual summaries after class.

> **Current scope:** local course/lecture persistence, local microphone
> recording, and Supabase hybrid auth are wired. Upload, transcription,
> summaries, live captions, and backend processing are not connected yet.

This is a **separate client project** from the existing Youmi Lens macOS/Tauri app.

## Getting started

Create a local `.env` file from the example before launching Expo:

```bash
cp .env.example .env
```

Fill in the public Supabase project values:

```bash
EXPO_PUBLIC_SUPABASE_URL=your_supabase_project_url
EXPO_PUBLIC_SUPABASE_ANON_KEY=your_supabase_anon_public_key
```

Use only the **anon public key** in the app. Never place a Supabase service role
key, Brevo SMTP credential, or any server-only secret in this client project.

```bash
npm install
npx expo start
```

Then press `i` to open the iOS Simulator (use an **iPad** device for the
intended layout), or scan the QR code with Expo Go.

## Auth model

The iPad app uses a hybrid flow:

### Create Profile

1. The user enters username, email, password, and password confirmation.
2. The app sends a signup verification code with `signInWithOtp({ email, options: { shouldCreateUser: true } })`.
3. The user enters the numeric verification code from email.
4. The app verifies the code with `verifyOtp({ email, token, type: 'email' })`.
5. After verification creates a session, the app sets the chosen password and username with `updateUser({ password, data: { username } })`.

### Sign In

Returning users sign in with email + password through `signInWithPassword`. Normal sign-in does not require a code.

The callback route remains in the codebase for possible future magic-link support, but it is not the main iPad auth path.

## Email template for create-profile verification

The iPad **Create Profile** flow needs a verification code in the email template. In Supabase Email Templates, include:

```text
{{ .Token }}
```

Normal sign-in uses email + password and does not send a code. Supabase documents `{{ .Token }}` as the OTP variable and `{{ .ConfirmationURL }}` as a link variable.

Supabase/Brevo SMTP remains configured in the Supabase dashboard. No SMTP credentials belong in the Expo app.

## Username persistence

During Create Profile, username is first kept as pending local state; the password is kept only in React component state and is never written to AsyncStorage.
After verification succeeds, the username is stored in auth user metadata and the app attempts a best-effort upsert into:

```text
profiles(id, username, updated_at)
```

If the `profiles` table or row-level policy is missing, login still succeeds. Settings falls back from profile username to auth metadata username, then to **No username set**.

## Testing auth in Expo Go

1. Create `.env` with the shared Supabase project URL and anon public key.
2. In Supabase, configure the create-profile verification email template to include `{{ .Token }}`.
3. Start the app with `npx expo start`, then open it in Expo Go on an iPad.
4. Under **Create Profile**, enter username, email, password, and matching confirmation, then tap **Send verification code**.
5. Open the email, copy the verification code, enter it in the app, and tap **Verify and create account**.
6. Open **Settings** to confirm the signed-in email and username display.
7. Tap **Sign Out** and verify the app returns to auth while local courses and lectures remain intact.
8. Under **Sign In**, use the same email and password; no code should be required.

## Stack

- Expo (SDK 54) + React Native + TypeScript
- Expo Router (file-based navigation, bottom tabs)
- Built-in React Native styling — no UI framework
- `@expo/vector-icons` (Ionicons) for icons
- Supabase JS auth client with AsyncStorage-backed session persistence

## Screens

| Route | Screen |
| --- | --- |
| `/` (Record tab) | Record Home — greeting, course selector, Start Recording, recent lectures, plan |
| `/courses` (tab) | Courses list |
| `/settings` (tab) | Account, plan, language, sync |
| `/auth` | Hybrid create-profile / sign-in auth |
| `/recording` | Focus Recording — timer, live captions, mark important, pause/finish |
| `/mini-caption` | Mini Caption Mode — floating panel over a note-taking background |
| `/processing` | Post-class processing steps |
| `/lecture/[id]` | Lecture Detail — Transcript / Summary / Key Points / Notes tabs |

## Project structure

```
app/                 Expo Router routes
  (tabs)/            Bottom tab screens (Record, Courses, Settings)
  recording.tsx      Focus Recording
  mini-caption.tsx   Mini Caption Mode
  processing.tsx     Processing
  lecture/[id].tsx   Lecture Detail
components/          Reusable UI (BrandHeader, GlassCard, PrimaryButton, …)
constants/theme.ts   Colors, spacing, radius, shadows, type scale
data/mockData.ts     Placeholder courses, lectures, captions
lib/format.ts        Small formatting helpers
lib/auth.tsx         Supabase auth state and actions
lib/supabase.ts      Supabase client setup with Expo persistence
```

## Brand

Deep navy (`#061B34`) on soft ice-white, frosted-glass cards, rounded corners,
soft shadows, thin borders. Calm and professional — no purple, no gradients.
