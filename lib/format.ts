/** Small formatting helpers shared across screens. */

/** Format seconds as HH:MM:SS (e.g. 1458 -> "00:24:18"). */
export function formatClock(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const seconds = s % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
}

/** Format a millisecond duration compactly (e.g. 5000 -> "0:05"). */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const seconds = s % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  if (hours > 0) return `${hours}:${pad(minutes)}:${pad(seconds)}`;
  return `${minutes}:${pad(seconds)}`;
}

const APP_LANGUAGE_LOCALES: Record<string, string> = {
  en: 'en-US',
  'zh-Hans': 'zh-CN',
  ja: 'ja-JP',
  fr: 'fr-FR',
  es: 'es-ES',
  ko: 'ko-KR',
};

function localeFor(language?: string): string {
  return APP_LANGUAGE_LOCALES[language ?? 'en'] ?? APP_LANGUAGE_LOCALES.en;
}

/** Format an ISO date as "May 16, 2026". */
export function formatDate(iso: string | null | undefined, language = 'en'): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat(localeFor(language), {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  }).format(d);
}

/** Format an ISO date compactly as "May 16". */
export function formatShortDate(iso: string | null | undefined, language = 'en'): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat(localeFor(language), {
    month: 'short',
    day: 'numeric',
  }).format(d);
}

export function formatDateTime(iso: string | null | undefined, language = 'en'): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat(localeFor(language), {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(d);
}

/** Time-of-day greeting used on the Record home screen. */
export function greetingForNow(date: Date = new Date()): string {
  const hour = date.getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}
