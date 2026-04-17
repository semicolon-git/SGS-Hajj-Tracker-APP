/**
 * Lightweight string catalog for SGS BagScan.
 *
 * Two locales: English (en) and Arabic (ar). Arabic also drives RTL layout
 * via `I18nManager.forceRTL` in `LocaleContext`.
 */

export type Locale = "en" | "ar";

type Dict = Record<string, string>;

const en = {
  // Brand
  appName: "SGS BagScan",
  org: "Saudi Ground Services",
  appTagline: "Hajj Luggage Operations · v1.0",

  // Common
  cancel: "Cancel",
  retry: "Retry",
  ok: "OK",
  back: "Back",
  loading: "Loading…",
  done: "Done",
  language: "العربية",

  // Auth
  agentId: "Agent ID",
  password: "Password",
  signIn: "Sign in",
  signOut: "Sign out",
  enterCredentials: "Enter your agent ID and password.",
  loginFailed: "Login failed.",
  offlineLogin: "Connect to SGS network first to sign in.",
  unlockBiometric: "Quick unlock",
  unlockPrompt: "Unlock SGS BagScan",
  useBiometric: "Use Face / Touch ID",
  signInDifferent: "Sign in with password",
  lastSync: "Last sync",

  // Session setup
  selectFlight: "Select Flight",
  noFlights: "No flights assigned today.",
  noGroups: "No groups for this flight.",
  bags: "bags",
  pilgrims: "pilgrims",
  scanned: "scanned",
  startScanning: "START SCANNING",
  groupLabel: "Group",
  offlineCached: "Offline · cached",

  // Scan screen
  exception: "Exception",
  noTag: "No Tag",
  syncNow: "Sync Now",
  end: "End",
  bulkReceive: "Bulk Receive",
  zebraIdle: "Ready to Scan",
  zebraIdleSub: "Press the trigger to scan a luggage tag",
  lastScannedTag: "Last scanned tag",
  alignTag: "Align bag tag inside the frame",
  cameraNeeded: "Camera access needed",
  cameraGrant: "Grant camera permission to scan bag tags on this device.",
  allowCamera: "Allow camera",
  cameraSettings: "Enable camera access in system settings.",
  scansFailed: "scan(s) failed to upload.",
  discard: "Discard",

  // Shift summary
  shiftSummary: "Shift Summary",
  totals: "Totals",
  expectedBags: "Expected bags",
  scannedBags: "Scanned bags",
  remainingBags: "Remaining",
  exceptions: "Exceptions",
  syncStatus: "Sync status",
  pendingScans: "Pending scans",
  failedScans: "Failed scans",
  online: "Online",
  offline: "Offline",
  endShift: "End shift",
  resumeSession: "Resume session",
  shiftEnded: "Shift ended",
  duration: "Duration",
  sendToSupervisor: "Send to supervisor",
  sending: "Sending…",
  reportSent: "Report sent to supervisor.",
  reportShared: "Report shared. Server audit not available — keep a copy.",
  reportFailed: "Could not share the report. Please try again.",

  // Bulk receive
  bulkReceiveTitle: "Bulk Receive",
  bulkReceiveSub: "Scan or paste tags handed over by a partner agent.",
  bulkPasteHint: "One tag per line. Paste a list, then tap Add.",
  bulkAdd: "Add tags",
  bulkAccept: "Accept all",
  bulkClear: "Clear",
  bulkAccepted: "tags accepted",
  bulkSkipped: "skipped",
  bulkInvalidTag: "Invalid tag",
  bulkDuplicateTag: "Already scanned",
  bulkOutOfGroup: "Other group",

  // Misc
  cameraMode: "Camera mode",
  zebraMode: "Zebra DataWedge",
  loadingManifest: "Loading manifest…",
  loadingManifestN: "Loading manifest: {n} bags",
  couldNotLoadManifest: "Could not load manifest.",
  scannedSuffix: "scanned",
  momentsAgo: "moments ago",
  minutesAgo: "{n}m ago",
  hoursAgo: "{n}h ago",
};

const ar: Dict = {
  appName: "SGS BagScan",
  org: "الخدمات الأرضية السعودية",
  appTagline: "عمليات أمتعة الحج · إصدار 1.0",

  cancel: "إلغاء",
  retry: "إعادة المحاولة",
  ok: "حسناً",
  back: "رجوع",
  loading: "جارِ التحميل…",
  done: "تم",
  language: "English",

  agentId: "رقم الموظف",
  password: "كلمة المرور",
  signIn: "تسجيل الدخول",
  signOut: "تسجيل الخروج",
  enterCredentials: "أدخل رقم الموظف وكلمة المرور.",
  loginFailed: "فشل تسجيل الدخول.",
  offlineLogin: "اتصل بشبكة SGS للدخول.",
  unlockBiometric: "فتح سريع",
  unlockPrompt: "افتح SGS BagScan",
  useBiometric: "استخدم البصمة / Face ID",
  signInDifferent: "تسجيل الدخول بكلمة المرور",
  lastSync: "آخر مزامنة",

  selectFlight: "اختر الرحلة",
  noFlights: "لا توجد رحلات اليوم.",
  noGroups: "لا توجد مجموعات لهذه الرحلة.",
  bags: "حقيبة",
  pilgrims: "حاج",
  scanned: "تم المسح",
  startScanning: "بدء المسح",
  groupLabel: "مجموعة",
  offlineCached: "غير متصل · محفوظ",

  exception: "استثناء",
  noTag: "بدون بطاقة",
  syncNow: "مزامنة",
  end: "إنهاء",
  bulkReceive: "استلام دفعة",
  zebraIdle: "جاهز للمسح",
  zebraIdleSub: "اضغط الزر لمسح بطاقة الحقيبة",
  lastScannedTag: "آخر بطاقة ممسوحة",
  alignTag: "ضع بطاقة الحقيبة داخل الإطار",
  cameraNeeded: "مطلوب صلاحية الكاميرا",
  cameraGrant: "امنح الكاميرا الإذن لمسح البطاقات.",
  allowCamera: "السماح للكاميرا",
  cameraSettings: "فعّل الكاميرا من إعدادات النظام.",
  scansFailed: "عملية مسح فشلت في الرفع.",
  discard: "تجاهل",

  shiftSummary: "ملخص الوردية",
  totals: "الإجماليات",
  expectedBags: "الحقائب المتوقعة",
  scannedBags: "الحقائب الممسوحة",
  remainingBags: "المتبقية",
  exceptions: "الاستثناءات",
  syncStatus: "حالة المزامنة",
  pendingScans: "عمليات معلقة",
  failedScans: "عمليات فاشلة",
  online: "متصل",
  offline: "غير متصل",
  endShift: "إنهاء الوردية",
  resumeSession: "متابعة الوردية",
  shiftEnded: "تم إنهاء الوردية",
  duration: "المدة",
  sendToSupervisor: "إرسال إلى المشرف",
  sending: "جارٍ الإرسال…",
  reportSent: "تم إرسال التقرير إلى المشرف.",
  reportShared: "تمت مشاركة التقرير. لم يُسجَّل في الخادم — احتفظ بنسخة.",
  reportFailed: "تعذّر مشاركة التقرير. حاول مرة أخرى.",

  bulkReceiveTitle: "استلام دفعة",
  bulkReceiveSub: "امسح أو الصق بطاقات تسلّمتها من زميل.",
  bulkPasteHint: "بطاقة واحدة في كل سطر. الصق القائمة ثم اضغط إضافة.",
  bulkAdd: "إضافة البطاقات",
  bulkAccept: "قبول الكل",
  bulkClear: "مسح",
  bulkAccepted: "بطاقة مقبولة",
  bulkSkipped: "تم تخطيها",
  bulkInvalidTag: "بطاقة غير صالحة",
  bulkDuplicateTag: "تم مسحها سابقاً",
  bulkOutOfGroup: "مجموعة أخرى",

  cameraMode: "وضع الكاميرا",
  zebraMode: "Zebra DataWedge",
  loadingManifest: "جارِ تحميل القائمة…",
  loadingManifestN: "جارِ تحميل القائمة: {n} حقيبة",
  couldNotLoadManifest: "تعذّر تحميل قائمة الحقائب.",
  scannedSuffix: "تم المسح",
  momentsAgo: "الآن",
  minutesAgo: "منذ {n} د",
  hoursAgo: "منذ {n} س",
};

const dictionaries: Record<Locale, Dict> = { en, ar };

export type StringKey = keyof typeof en;

export function translate(locale: Locale, key: StringKey): string {
  const dict = dictionaries[locale] ?? en;
  return dict[key] ?? (en as Dict)[key] ?? String(key);
}

export const LOCALES: Locale[] = ["en", "ar"];
