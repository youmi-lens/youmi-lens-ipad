/**
 * System-generated default course / lecture / material names.
 *
 * These exact English strings are the ones our OWN code writes when it has to
 * invent a name for the user:
 *   - "General Lectures"  — the quick-record course (app/(tabs)/index.tsx)
 *   - "Untitled Lecture"  — a recording finished without a typed title
 *                           (app/recording.tsx, lib/store.tsx sync fallback)
 *   - "Untitled material" — a PDF imported without a usable filename
 *                           (lib/importMaterial.ts)
 *
 * Each is persisted VERBATIM and doubles as a stable identity / sync key
 * (course names are matched across devices by their string value in
 * lib/store.tsx). We therefore never translate them at write time — doing so
 * would fork sync groups per language and turn a translation into a business
 * identifier. Instead we localize ONLY at display time: if a stored name is
 * byte-for-byte one of these sentinels, render the localized label for the
 * active UI language; anything else — a genuine user-entered or user-renamed
 * title — is returned unchanged.
 *
 * Residual ambiguity (documented, accepted): the current data model has no
 * per-item "system default" flag, so a user who manually types the exact
 * English sentinel (e.g. names a course literally "General Lectures") is
 * indistinguishable from a system default and will also be localized on
 * display. This render-layer match is the safe maximum — it changes zero
 * stored data, routing, sync, rename, or deletion behaviour.
 */

/** Exact stored English sentinel → translation key. */
export const SYSTEM_DEFAULT_TITLE_KEYS = {
  'General Lectures': 'systemDefault.generalLectures',
  'Untitled Lecture': 'systemDefault.untitledLecture',
  'Untitled material': 'systemDefault.untitledMaterial',
};

/**
 * Localize a stored title for display, leaving user content untouched.
 *
 * @param {(key: string) => string} translate the active `t` function
 * @param {unknown} name the stored course/lecture/material name
 * @returns the localized label for a known system default, else `name` as-is
 *          (non-strings, including null/undefined, pass straight through so
 *          existing `?? fallback` render logic keeps working).
 */
export function localizeSystemDefaultTitle(translate, name) {
  if (typeof name !== 'string') return name;
  const key = SYSTEM_DEFAULT_TITLE_KEYS[name.trim()];
  return key ? translate(key) : name;
}
