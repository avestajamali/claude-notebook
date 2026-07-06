/**
 * File-facility core: taxonomy, the layered
 * cheapest-first classifier, the local seed summary, the sensitive-data
 * detector, and the schema-v1 frontmatter builder.
 *
 * Everything in this module is LOCAL and zero-token: the model never
 * runs here. Files the ladder can't classify land in 90-uncategorized with
 * status: inbox; the batched Haiku polish (main.ts "Enrich inbox") upgrades
 * them later. File content is DATA, never instructions.
 */

export interface Category {
  /** Folder name under Dropped Notes/, e.g. "10-finance". */
  folder: string;
  /** Frontmatter slug, e.g. "finance". */
  slug: string;
  /** Filename/path regex (cheap tier L0/L1). */
  name: RegExp;
  /** Content-anchor regex (tier L2), tested on the first ~4k chars. */
  anchor?: RegExp;
}

/** The ten-category set (Johnny.Decimal-numbered, order = precedence). */
export const CATEGORIES: Category[] = [
  { folder: "11-receipts", slug: "receipts", name: /(invoice|receipt|payment|booking|order[-_ ]?conf)/i, anchor: /(tax invoice|total \(incl\.? gst\)|abn[: ]?\d)/i },
  { folder: "10-finance", slug: "finance", name: /(statement|tax(?!i)|payslip|salary|bank|super|dividend|portfolio)/i, anchor: /(bsb[: ]?\d{3}[- ]?\d{3}|opening balance|closing balance)/i },
  { folder: "21-cfa", slug: "cfa", name: /(cfa|kaplan|schweser|level\s*[i1](?![a-z0-9]))/i, anchor: /(learning outcome statement|reading \d+ ?:)/i },
  { folder: "20-study", slug: "study", name: /([A-Z]{4}\d{4}|lecture|tutorial|w(?:ee)?k ?\d{1,2}|exam|assignment|canvas)/i, anchor: /(learning outcome|due date|semester [12])/i },
  { folder: "30-work", slug: "work", name: /(roster|shift|onboarding|resume|cv(?![a-z])|cover.?letter|offer|payroll|hr[-_ ])/i, anchor: /(code of conduct|employment agreement)/i },
  { folder: "40-admin", slug: "admin", name: /(lease|tenancy|medicare|visa|insurance|licen[cs]e|passport|utility|electricity|internet plan)/i, anchor: /(tenancy agreement|policy number|medicare provider)/i },
  { folder: "70-screenshots", slug: "screenshots", name: /(screen.?shot|capture ?\d|snip)/i },
  { folder: "60-ui-ideas", slug: "ui-ideas", name: /(mockup|wireframe|ui[-_ ]|inspiration|figma)/i },
  { folder: "50-reference", slug: "reference", name: /(manual|guide|cheat.?sheet|readme|spec(?:ification)?|documentation)/i },
  { folder: "90-uncategorized", slug: "uncategorized", name: /$^/ },
];

export const UNCATEGORIZED = CATEGORIES[CATEGORIES.length - 1];

export function categoryBySlug(slug: string): Category {
  return CATEGORIES.find((c) => c.slug === slug) ?? UNCATEGORIZED;
}

/**
 * Optional user-defined filing rules (Feature 5), parsed from the routing-guide note and
 * consulted by classify() BEFORE the built-in ladder. Empty by default — when empty,
 * classification is byte-identical to the built-in behaviour. Replaced wholesale each call
 * so clearing the note clears the rules.
 */
let userRules: { name: RegExp; folder: string; slug: string }[] = [];

/** Escape regex metacharacters so a user keyword is matched literally. */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Parse the routing-guide note body into userRules. One rule per non-empty line:
 *   `keyword1, keyword2: folder-name`  (a leading "- " bullet is tolerated).
 * Left side → comma-separated keywords → one case-insensitive alternation regex (keywords
 * regex-escaped). Right side → folder name (trimmed). slug = folder with a leading `NN-`
 * number prefix stripped, lowercased. Malformed lines are ignored.
 */
export function setUserCategoryRules(lines: string): void {
  const rules: { name: RegExp; folder: string; slug: string }[] = [];
  for (const raw of lines.split("\n")) {
    const m = /^\s*-?\s*(.+?):\s*(\S.*)$/.exec(raw);
    if (!m) continue;
    const keywords = m[1]
      .split(",")
      .map((k) => k.trim())
      .filter((k) => k.length > 0);
    const folder = m[2].trim();
    if (keywords.length === 0 || !folder) continue;
    const name = new RegExp(`(${keywords.map(escapeRegex).join("|")})`, "i");
    const slug = folder.replace(/^\d+-/, "").toLowerCase();
    rules.push({ name, folder, slug });
  }
  userRules = rules;
}

export interface Classification {
  category: Category;
  /** 0–1; <0.5 routes to uncategorized/inbox (confidence routing). */
  confidence: number;
  /** Which ladder tier decided: "filename" | "path" | "anchor" | "none". */
  via: string;
}

/**
 * The L0–L2 ladder: filename → origin path → content anchor. All free.
 * The Haiku L3 leg is deliberately NOT here — it belongs to the deferred
 * enrich batch, never the drop path.
 */
export function classify(fileName: string, originPath: string, content: string): Classification {
  // User-defined filing rules (Feature 5) win over the built-in ladder. When userRules is
  // empty (the default), this loop is skipped and classification is unchanged.
  for (const r of userRules) {
    if (r.name.test(fileName)) {
      return { category: { folder: r.folder, slug: r.slug, name: r.name }, confidence: 0.9, via: "user-rule" };
    }
  }
  for (const c of CATEGORIES) {
    if (c.slug === "uncategorized") continue;
    if (c.name.test(fileName)) return { category: c, confidence: 0.9, via: "filename" };
  }
  for (const c of CATEGORIES) {
    if (c.slug === "uncategorized") continue;
    if (originPath && c.name.test(originPath)) return { category: c, confidence: 0.75, via: "path" };
  }
  const head = content.slice(0, 4000);
  for (const c of CATEGORIES) {
    if (c.anchor && c.anchor.test(head)) return { category: c, confidence: 0.8, via: "anchor" };
  }
  return { category: UNCATEGORIZED, confidence: 0, via: "none" };
}

/** AU PII detectors: BSB, TFN, Medicare, 16-digit card. Zero-token. */
const PII = /(\b\d{3}[- ]\d{3}\b(?=.{0,40}(account|bsb))|\bbsb\b|\b\d{3}[ ]?\d{3}[ ]?\d{3}\b(?=.{0,30}(tfn|tax file))|\btfn\b|\bmedicare\b|\b\d{4}[ -]\d{4}[ -]\d{4}[ -]\d{4}\b)/i;

export function detectSensitive(content: string): boolean {
  return PII.test(content.slice(0, 20000));
}

/**
 * Local seed summary: first heading + lead lines, ≤200 chars,
 * PII-stripped. The nightly Haiku pass replaces it with a real abstract.
 */
export function seedSummary(body: string): string {
  const lines = body
    .split("\n")
    .map((l) => l.replace(/^#+\s*|^>+\s*\[![a-z]+\]\s*|^[>*\-|`]+\s*/g, "").trim())
    .filter((l) => l.length > 2 && !/^!\[/.test(l) && !/^---/.test(l));
  let s = lines.slice(0, 3).join(" — ").slice(0, 200);
  s = s.replace(/\b\d{4}[ -]?\d{4}[ -]?\d{4}[ -]?\d{2,4}\b/g, "···"); // never leak card/account digits into metadata
  return s.replace(/"/g, "'");
}

/** Heuristic namespaced tags (controlled vocab) — free; Haiku refines later. */
export function seedTags(slug: string, fileName: string, noteType: string): string[] {
  const tags = [`cat/${slug}`];
  const n = fileName.toLowerCase();
  if (/invoice/.test(n)) tags.push("doc/invoice");
  else if (/receipt/.test(n)) tags.push("doc/receipt");
  else if (/statement/.test(n)) tags.push("doc/statement");
  else if (/lecture/.test(n)) tags.push("doc/lecture");
  else if (/tutorial/.test(n)) tags.push("doc/tutorial");
  else if (/resume|cv(?![a-z])/.test(n)) tags.push("doc/cv");
  if (noteType === "image") tags.push("ocr/pending");
  return tags;
}

/** Note `type` from extension. .heic is NOT typed "image": Obsidian can't render it and
 *  ingest.ts doesn't inline it, so typing it "image" made the note's metadata (embeddable image)
 *  contradict its body (unsupported-type stub). It falls through to a stub, matching ingest. */
export function noteTypeOf(ext: string, converted: boolean): string {
  if ([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg"].includes(ext)) return "image";
  if ([".xlsx", ".xls", ".xlsm", ".csv", ".tsv"].includes(ext)) return "spreadsheet";
  if (ext === ".pdf") return "pdf-doc";
  if ([".md", ".markdown", ".txt", ".text"].includes(ext)) return "text";
  if (converted) return "office-doc";
  return "stub";
}

export function displaySize(bytes: number): string {
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

// ── ICS calendar ingestion ──────────────────────────────────────────────────
// A dropped .ics (Outlook invite, uni timetable export) becomes Full Calendar
// notes instead of an archived blob. Local parse, 0 tokens. Recurrence rules
// are flagged, not expanded.

export interface IcsEvent {
  title: string;
  date: string; // YYYY-MM-DD
  startTime?: string; // HH:mm
  endTime?: string;
  allDay: boolean;
  location?: string;
  rrule?: string;
}

function icsUnescape(s: string): string {
  return s.replace(/\\n/gi, " ").replace(/\\([,;\\])/g, "$1").trim();
}

function icsDate(v: string): { date: string; time?: string } | null {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})\d{2}(Z?))?/.exec(v.trim());
  if (!m) return null;
  if (!m[4]) return { date: `${m[1]}-${m[2]}-${m[3]}` };
  if (m[6] === "Z") {
    const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]));
    const p = (n: number) => String(n).padStart(2, "0");
    return { date: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`, time: `${p(d.getHours())}:${p(d.getMinutes())}` };
  }
  // TZID wall-clock times are taken as local — right for AU-generated invites.
  return { date: `${m[1]}-${m[2]}-${m[3]}`, time: `${m[4]}:${m[5]}` };
}

export function parseIcs(text: string): IcsEvent[] {
  const lines = text.replace(/\r/g, "").replace(/\n[ \t]/g, "").split("\n"); // unfold RFC5545 continuations
  const out: IcsEvent[] = [];
  let cur: Record<string, string> | null = null;
  let nested = 0; // depth of nested components (VALARM etc.) inside the current VEVENT
  for (const l of lines) {
    if (l === "BEGIN:VEVENT") {
      cur = {};
      nested = 0;
    } else if (l === "END:VEVENT") {
      nested = 0;
      if (cur?.DTSTART && cur.SUMMARY) {
        const s = icsDate(cur.DTSTART);
        const e = cur.DTEND ? icsDate(cur.DTEND) : null;
        if (s) {
          out.push({
            title: icsUnescape(cur.SUMMARY),
            date: s.date,
            startTime: s.time,
            endTime: e?.date === s.date ? e?.time : undefined,
            allDay: !s.time,
            location: cur.LOCATION ? icsUnescape(cur.LOCATION) : undefined,
            rrule: cur.RRULE,
          });
        }
      }
      cur = null;
    } else if (cur) {
      // A VEVENT often wraps a VALARM whose own SUMMARY/ATTENDEE would otherwise overwrite the
      // event's fields (later assignment wins) — record properties only at VEVENT depth.
      if (l.startsWith("BEGIN:")) {
        nested++;
        continue;
      }
      if (l.startsWith("END:")) {
        if (nested > 0) nested--;
        continue;
      }
      if (nested > 0) continue;
      const i = l.indexOf(":");
      if (i > 0) cur[l.slice(0, i).split(";")[0].toUpperCase()] = l.slice(i + 1);
    }
  }
  return out;
}

/** Schema-v1 frontmatter serializer. Lists render as YAML flow arrays. */
export function buildFrontmatter(fields: Record<string, string | number | boolean | string[] | null>): string {
  const lines: string[] = [];
  for (const [k, v] of Object.entries(fields)) {
    if (v === null || v === undefined) continue;
    if (Array.isArray(v)) lines.push(`${k}: [${v.map((x) => JSON.stringify(x)).join(", ")}]`);
    else if (typeof v === "string") lines.push(`${k}: ${JSON.stringify(v)}`);
    else lines.push(`${k}: ${v}`);
  }
  return `---\n${lines.join("\n")}\n---\n`;
}
