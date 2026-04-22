/**
 * Bundled release notes shown by `<WhatsNewSheet/>` after an update.
 *
 * The sheet picks the entry whose `version` matches the current
 * `Application.nativeApplicationVersion` (from app.json). Each entry
 * has bilingual bullet lists so the same dataset works for both
 * locales — the sheet picks the right list based on `useLocale()`.
 *
 * Update flow when a new version ships:
 *   1. Bump `app.json` `version` (and the EAS build / OTA channel).
 *   2. Prepend a new entry here with concise, agent-friendly notes.
 *   3. Existing devices will see the sheet on their next launch
 *      after the OTA applies (or after install for native bumps).
 *
 * Keep bullets short — agents are scrolling between scans, not
 * reading patch notes. 3-5 bullets per release is the sweet spot.
 */

export interface ReleaseNote {
  /** Matches `Application.nativeApplicationVersion`. */
  version: string;
  /** ISO date for display under the title. */
  date: string;
  /** Bullet points, English. */
  en: string[];
  /** Bullet points, Arabic. */
  ar: string[];
}

export const RELEASE_NOTES: ReleaseNote[] = [
  {
    version: "1.0.1",
    date: "2026-04-22",
    en: [
      "Trigger health: scan screen now warns if your Zebra trigger isn't reaching the app, with a Setup Guide shortcut.",
      "Manifest banners: clear warnings when the bag manifest can't load or is being served from the offline cache.",
      "Clearer hint when scanning a tag that isn't on the current flight's manifest.",
      "What's new: this sheet, so you know exactly what changed after each update.",
    ],
    ar: [
      "حالة الزر: تظهر شاشة المسح تنبيهاً إذا لم يصل زر جهاز Zebra إلى التطبيق، مع اختصار لدليل الإعداد.",
      "تنبيهات قائمة الحقائب: تظهر رسائل واضحة عند تعذّر تحميل القائمة أو عند العرض من النسخة المحفوظة.",
      "تلميح أوضح عند مسح حقيبة غير مدرجة في قائمة هذه الرحلة.",
      "نافذة \"الجديد\": نضيف هذه النافذة لتعرف بدقة ما تغيّر بعد كل تحديث.",
    ],
  },
];

/**
 * Look up the release notes entry for a specific version. Returns
 * `null` when no notes are bundled — the sheet stays hidden in that
 * case rather than showing an empty modal.
 */
export function getReleaseNotesFor(version: string): ReleaseNote | null {
  return RELEASE_NOTES.find((n) => n.version === version) ?? null;
}

/**
 * The latest entry. Used by the Settings "What's new" link so an
 * agent can re-open the most recent notes on demand even after they
 * dismissed the auto-shown sheet.
 */
export function getLatestReleaseNotes(): ReleaseNote | null {
  return RELEASE_NOTES[0] ?? null;
}
