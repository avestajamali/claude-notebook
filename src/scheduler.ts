import { App, normalizePath } from "obsidian";

/**
 * Availability-aware spaced-review scheduler.
 *
 * Reviews follow an SM-2-style curve but SNAP to free study windows — never
 * Wednesday daytime or Sat/Sun 07:00–15:00 (work). Mastery state is persisted as a
 * frontmatter + JSON data file (NO fenced code block — fence-bug rule,),
 * read back via frontmatter-strip + JSON.parse.
 */

export interface Availability {
  busyDays: string[];
  workWindows: { day: string; start: string; end: string }[];
  primeDays: string[];
  primeEvenings: string[];
  defaultTimes: { weekday: string; weekend: string };
  reviewCurveDays: number[];
}

/** Matches Codex/Everything App/Availability.md. The runtime can override from that note. */
export const DEFAULT_AVAILABILITY: Availability = {
  busyDays: ["Wed"],
  workWindows: [
    { day: "Sat", start: "07:00", end: "15:00" },
    { day: "Sun", start: "07:00", end: "15:00" },
  ],
  primeDays: ["Mon", "Tue", "Thu", "Fri"],
  primeEvenings: ["Wed", "Sat", "Sun"],
  defaultTimes: { weekday: "18:00", weekend: "16:00" },
  reviewCurveDays: [1, 3, 7, 16],
};

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function dayName(d: Date): string {
  return DOW[d.getDay()];
}
function isWeekend(d: Date): boolean {
  return d.getDay() === 0 || d.getDay() === 6;
}

/** A usable study day? prime weekdays any time; Wed/weekend only in the evening (handled by time). */
function isFreeDay(d: Date, a: Availability): boolean {
  const name = dayName(d);
  return a.primeDays.includes(name) || a.primeEvenings.includes(name);
}

/** base + interval, walked forward to the next free study slot, at the default time. */
export function nextReviewSlot(base: Date, intervalDays: number, a: Availability): string {
  const d = new Date(base.getTime());
  d.setDate(d.getDate() + intervalDays);
  for (let i = 0; i < 7 && !isFreeDay(d, a); i++) d.setDate(d.getDate() + 1);
  const time = isWeekend(d) ? a.defaultTimes.weekend : a.defaultTimes.weekday;
  const [hh, mm] = time.split(":");
  d.setHours(parseInt(hh, 10) || 18, parseInt(mm, 10) || 0, 0, 0);
  return d.toISOString();
}

export function scheduleReviews(now: Date, a: Availability): { interval: number; whenISO: string }[] {
  return a.reviewCurveDays.map((n) => ({ interval: n, whenISO: nextReviewSlot(now, n, a) }));
}

// ── Mastery state (frontmatter + JSON, no code fence) ────────────────────────

export interface MasteryEntry {
  topic: string;
  source: string;
  confidence: number; // 0–100
  lastTaught: string;
  nextReview: string;
  lapses: number;
}

export async function readMastery(app: App, vaultPath: string): Promise<MasteryEntry[]> {
  const norm = normalizePath(vaultPath);
  if (!(await app.vault.adapter.exists(norm))) return [];
  const raw = await app.vault.adapter.read(norm);
  const body = (raw || "").replace(/^---[\s\S]*?---\s*/, "").trim();
  try {
    const parsed = JSON.parse(body || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function writeMastery(app: App, vaultPath: string, entries: MasteryEntry[]): Promise<void> {
  const norm = normalizePath(vaultPath);
  const fm = `---\ntype: mastery-state\ncount: ${entries.length}\n---\n`;
  await app.vault.adapter.write(norm, fm + JSON.stringify(entries, null, 0) + "\n");
}

export async function upsertMastery(app: App, vaultPath: string, entry: MasteryEntry): Promise<void> {
  const all = await readMastery(app, vaultPath);
  const i = all.findIndex((e) => e.topic === entry.topic);
  if (i >= 0) all[i] = entry;
  else all.push(entry);
  await writeMastery(app, vaultPath, all);
}
