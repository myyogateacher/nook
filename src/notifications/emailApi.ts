import { api } from "../api";

/** Settings → Notifications → Email (Wave 28, outbound email §B.1, §E.2). */
export const EMAIL_CATEGORIES = ["assignments", "comments", "sharing", "proposals", "sprints", "bin", "reminders"] as const;
export type EmailCategory = typeof EMAIL_CATEGORIES[number];

export type EmailPrefs = {
  enabled: boolean;
  categories: Record<EmailCategory, boolean>;
  digest: "off" | "daily" | "weekly";
  digestLocalTime: string;
  quietStart: string | null;
  quietEnd: string | null;
  tz: string;
  revision: number;
  updatedAt: string | null;
  /** When the next digest goes (Wave 29), or null when it is off. */
  nextDigestAt?: string | null;
};

/** Why Nook holds mail back from this address (Wave 29 webhooks): a bounce, a spam report, or a run of soft bounces. */
export type Suppression = { reason: "bounce" | "complaint" | "manual" | "soft"; since: string; until: string | null } | null;
export type EmailSettings = { configured: boolean; address: string; verified: boolean; suppressed: boolean; suppression?: Suppression; prefs: EmailPrefs };

export type EmailPrefsInput = {
  enabled: boolean;
  categories: Record<EmailCategory, boolean>;
  digest: "off" | "daily" | "weekly";
  digestLocalTime: string;
  quietHours: { start: string; end: string } | null;
  tz: string;
  revision: number;
};

export const getEmailSettings = () => api<EmailSettings>("/mail/settings");
export const putEmailSettings = (input: EmailPrefsInput) => api<EmailSettings>("/mail/settings", { method: "PUT", body: JSON.stringify(input) });
export const sendVerificationEmail = () => api<{ queued: true }>("/mail/verify/send", { method: "POST", body: "{}" });
export const clearSuppression = () => api<EmailSettings>("/mail/suppression/clear", { method: "POST", body: "{}" });
export const sendTestEmail = () => api<{ queued: true }>("/mail/test", { method: "POST", body: "{}" });

/** The browser's zone, or UTC. */
export function deviceTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** A PUT body from stored prefs plus changes. */
export function prefsInput(prefs: EmailPrefs, change: Partial<EmailPrefsInput> = {}): EmailPrefsInput {
  return {
    enabled: prefs.enabled,
    categories: prefs.categories,
    digest: prefs.digest,
    digestLocalTime: prefs.digestLocalTime,
    quietHours: prefs.quietStart && prefs.quietEnd ? { start: prefs.quietStart, end: prefs.quietEnd } : null,
    // The first save records this device's zone (§B.1); later saves keep the stored one.
    tz: prefs.revision === 0 ? deviceTimeZone() : prefs.tz,
    revision: prefs.revision,
    ...change
  };
}

/** Whether a local HH:MM falls inside quiet hours (which may wrap midnight). */
export function insideQuietHours(time: string, start: string | null, end: string | null) {
  if (!start || !end) return false;
  const minutes = (value: string) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3, 5));
  const at = minutes(time);
  return minutes(start) < minutes(end) ? at >= minutes(start) && at < minutes(end) : at >= minutes(start) || at < minutes(end);
}

/** Half-hour steps for the quiet-hours pickers. */
export const HALF_HOURS = Array.from({ length: 48 }, (_, index) => `${String(Math.floor(index / 2)).padStart(2, "0")}:${index % 2 ? "30" : "00"}`);

/** Per-board, per-calendar, and per-collection email mutes (Wave 29, D249). */
export type MuteType = "board" | "calendar" | "collection";
export type EmailMute = { targetType: MuteType; targetId: string; name: string; createdAt: string };
export const listEmailMutes = () => api<{ mutes: EmailMute[] }>("/mail/mutes");
export const muteEmails = (type: MuteType, id: string) => api<{ muted: true }>(`/mail/mutes/${type}/${encodeURIComponent(id)}`, { method: "PUT", body: "{}" });
export const unmuteEmails = (type: MuteType, id: string) => api<{ muted: false }>(`/mail/mutes/${type}/${encodeURIComponent(id)}`, { method: "DELETE", body: "{}" });
