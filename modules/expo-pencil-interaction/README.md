# expo-pencil-interaction

Optional local Expo module that exposes **Apple Pencil double-tap** to JS via
`UIPencilInteraction`. iOS only.

It is intentionally optional:

- **Expo Go** — not compiled in. `requireOptionalNativeModule` returns `null`,
  `lib/pencilInteraction.ts` reports the feature as unavailable, and the app
  runs normally with the toolbar as the way to switch tools.
- **Development / standalone build** — autolinked during prebuild. JS receives
  an `onPencilDoubleTap` event whenever the user double-taps the Apple Pencil.

Do not import this module directly from app code. Use `lib/pencilInteraction.ts`,
which resolves it safely.

## Building it into a dev client

The module is native code, so it requires a development build (it cannot run in
Expo Go). After pulling these files run:

```sh
npx expo prebuild            # generates ios/, autolinks this module
npx expo run:ios --device    # build & install on a physical iPad
```

or, with EAS:

```sh
eas build --profile development --platform ios
```

Re-run `prebuild` / rebuild the dev client whenever the native code changes.
A physical iPad with a paired Apple Pencil is required to exercise double-tap.
