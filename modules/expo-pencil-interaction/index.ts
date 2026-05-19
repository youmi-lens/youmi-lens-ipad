/**
 * Optional Apple Pencil double-tap native module (iOS development/standalone
 * builds only — absent from Expo Go).
 *
 * App code should NOT import this file directly. Use `lib/pencilInteraction.ts`,
 * which resolves the module safely with `requireOptionalNativeModule` so the
 * app keeps working when the native module is not present.
 *
 * This entry point exists only so the directory is a well-formed local Expo
 * module that Expo autolinking can discover during `npx expo prebuild`.
 */
import { requireOptionalNativeModule } from 'expo-modules-core';

export default requireOptionalNativeModule('ExpoPencilInteraction');
