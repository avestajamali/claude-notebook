import { App, normalizePath } from "obsidian";

/**
 * Availability-aware spaced-review scheduler.
 *
 * Reviews follow a fixed [1,3,7,16]-day curve, each date walked forward to the next study day
 * (primeDays plus primeEvenings) and stamped at defaultTimes. Mastery state is persisted as a
 * frontmatter + JSON data file (no fenced code block, to stay robust to markdown fence handling),
 * read back via frontmatter-strip + JSON.parse.
 *
 * NOTE: busyDays and workWindows are reserved for a future time-of-day-aware pass; the current
 * slot logic reads only primeDays/primeEvenings/defaultTimes.
 */

export interface Availability {
  /** Reserved (not yet consulted by nextReviewSlot). */
  busyDays: string[];
  /** Reserved (not yet consulted by nextReviewSlot). */
  workWindows: { day: string; start: string; end: string }[];
  primeDays: string[];
  primeEvenings: string[];
  defaultTimes: { weekday: string; weekend: string };
  reviewCurveDays: number[];
}

export const DEFAULT_AVAILABILITY: Availability = {
  busyDays: [],
  workWindows: [],
  primeDays: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
  primeEvenings: [],
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
  const norm = normalizePath(vaultPath);
  let all: MasteryEntry[] = [];
  if (await app.vault.adapter.exists(norm)) {
    const raw = await app.vault.adapter.read(norm);
    const body = (raw || "").replace(/^---[\s\S]*?---\s*/, "").trim();
    try {
      const parsed = JSON.parse(body || "[]");
      all = Array.isArray(parsed) ? parsed : [];
    } catch {
      // Corrupt (OneDrive sync-conflict artifact, a manual reformat) — DON'T silently overwrite the
      // whole spaced-repetition history with one seed entry. Back it up to a uniquified side file;
      // if the backup can't be written (OneDrive lock — the exact case this targets), BAIL rather
      // than clobber the only copy that exists.
      const p = (n: number) => String(n).padStart(2, "0");
      const d = new Date();
      const day = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
      let bak = `${norm.replace(/\.md$/, "")} (corrupt ${day}).md`;
      for (let n = 2; await app.vault.adapter.exists(bak); n++) {
        bak = `${norm.replace(/\.md$/, "")} (corrupt ${day} ${n}).md`;
      }
      try {
        await app.vault.adapter.write(bak, raw);
      } catch {
        return; // couldn't preserve the corrupt data — do not overwrite it with a fresh seed
      }
      all = [];
    }
  }
  // Match on topic AND source (same lecture title from two notes shouldn't overwrite), and carry
  // forward the retention history rather than resetting lapses/confidence on every re-teach.
  const i = all.findIndex((e) => e.topic === entry.topic && e.source === entry.source);
  if (i >= 0) {
    all[i] = {
      ...entry,
      lapses: all[i].lapses ?? entry.lapses,
      confidence: Math.max(all[i].confidence ?? 0, entry.confidence),
    };
  } else {
    all.push(entry);
  }
  await writeMastery(app, vaultPath, all);
}
