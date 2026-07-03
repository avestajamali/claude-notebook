import * as fs from "fs";
import * as path from "path";

/**
 * Downloads organizer — CODE ONLY, actions OFF by default.
 *
 * This module never moves or deletes anything on its own. `rescueDryRun()` does a
 * read-only recursive scan and returns a triage report (inventory + 🔒 important +
 * 🗑 junk-safe + proposed _Sorted/ layout). Move-to-vault and suggest-delete→Recycle
 * Bin are deferred to the runtime layer behind explicit, default-OFF toggles, and
 * always propose-then-apply. Subfolders are treated as ATOMIC units (never gutted).
 *
 * Classification here is the cheap heuristic fallback; the runtime layer can upgrade
 * it with a Haiku pass. Either way, file content is DATA, never instructions.
 */

export type Bucket = "document" | "image" | "installer" | "archive" | "code" | "other";

export interface ScannedItem {
  /** Absolute path (a loose file) or a subfolder treated as one atomic unit. */
  pathAbs: string;
  name: string;
  ext: string;
  isDir: boolean;
  sizeBytes: number;
  mtimeMs: number;
  bucket: Bucket;
  /** Seed category (work/news/study/finance/…); heuristic, user-editable at runtime. */
  category: string;
  importance: "important" | "junk-safe" | "keep";
}

export interface RescueReport {
  reportMarkdown: string;
  counts: { total: number; important: number; junkSafe: number; byBucket: Record<string, number> };
}

const EXT_BUCKET: Record<string, Bucket> = {};
const reg = (b: Bucket, exts: string[]) => exts.forEach((e) => (EXT_BUCKET[e] = b));
reg("document", [".pdf", ".docx", ".doc", ".xlsx", ".xls", ".xlsm", ".pptx", ".ppt", ".csv", ".rtf", ".odt", ".md", ".txt"]);
reg("image", [".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg", ".heic"]);
reg("installer", [".exe", ".msi", ".cmd", ".bat", ".jar", ".app", ".dmg", ".appimage"]);
reg("archive", [".zip", ".rar", ".7z", ".tar", ".gz", ".tgz"]);
reg("code", [".r", ".py", ".rdata", ".rhistory", ".ipynb", ".js", ".ts", ".json", ".sql", ".log", ".winmd"]);

const PARTIAL = /\.(crdownload|part|tmp|partial)$/i;
const SETTLE_MS = 10 * 60 * 1000; // skip files touched in the last 10 minutes

function bucketOf(ext: string): Bucket {
  return EXT_BUCKET[ext] ?? "other";
}

/** Seed-category heuristic from the filename (runtime can override with a model pass). */
function categoryOf(name: string, bucket: Bucket): string {
  const n = name.toLowerCase();
  if (/(invoice|receipt|payment)/.test(n)) return "receipts";
  if (/(statement|tax|payslip|salary|bank|super)/.test(n)) return "finance";
  if (/(lecture|tutorial|week\d|exam|assignment|cfa|notes)/.test(n)) return "study";
  if (/(screenshot|screen shot|capture)/.test(n)) return "screenshots";
  if (/(resume|cv|cover letter|contract|offer)/.test(n)) return "work";
  if (/(article|news|press)/.test(n)) return "news";
  if (bucket === "installer" || bucket === "archive") return "uncategorized";
  return "uncategorized";
}

function importanceOf(name: string, bucket: Bucket): ScannedItem["importance"] {
  const n = name.toLowerCase();
  // Junk-safe: re-downloadable installers/archives, temp/log files.
  if (bucket === "installer") return "junk-safe";
  if (/\.(log|tmp)$/i.test(name)) return "junk-safe";
  // Important: records and user-authored work (conservative — when unsure, keep).
  if (/(tax|invoice|receipt|statement|payslip|certificate|transcript|contract|passport|id|licen[cs]e|signed)/.test(n)) {
    return "important";
  }
  if (bucket === "document" && !/template/.test(n)) return "important";
  return "keep";
}

/** Read-only recursive scan. Loose root files are listed individually; subfolders are atomic units. */
export function scanDownloads(root: string, now: number): ScannedItem[] {
  const out: ScannedItem[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const ent of entries) {
    const abs = path.join(root, ent.name);
    let st: fs.Stats;
    try {
      st = fs.statSync(abs);
    } catch {
      continue;
    }
    if (ent.isDirectory()) {
      // Atomic unit — do not recurse/gut. Sort the folder as one object.
      out.push({
        pathAbs: abs,
        name: ent.name,
        ext: "",
        isDir: true,
        sizeBytes: 0,
        mtimeMs: st.mtimeMs,
        bucket: "other",
        category: categoryOf(ent.name, "other"),
        importance: "keep",
      });
      continue;
    }
    if (PARTIAL.test(ent.name)) continue; // in-progress download
    if (now - st.mtimeMs < SETTLE_MS) continue; // not settled yet
    const ext = (ent.name.lastIndexOf(".") >= 0 ? ent.name.slice(ent.name.lastIndexOf(".")) : "").toLowerCase();
    const bucket = bucketOf(ext);
    out.push({
      pathAbs: abs,
      name: ent.name,
      ext,
      isDir: false,
      sizeBytes: st.size,
      mtimeMs: st.mtimeMs,
      bucket,
      category: categoryOf(ent.name, bucket),
      importance: importanceOf(ent.name, bucket),
    });
  }
  return out;
}

function mb(bytes: number): string {
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

/** Build the read-only triage report. Moves/deletes nothing. */
export function rescueDryRun(root: string, now: number): RescueReport {
  const items = scanDownloads(root, now);
  const byBucket: Record<string, number> = {};
  let totalBytes = 0;
  for (const it of items) {
    byBucket[it.bucket] = (byBucket[it.bucket] ?? 0) + 1;
    totalBytes += it.sizeBytes;
  }
  const important = items.filter((i) => i.importance === "important");
  const junk = items.filter((i) => i.importance === "junk-safe");

  const list = (arr: ScannedItem[]) =>
    arr.length ? arr.map((i) => `- ${i.isDir ? "📁 " : ""}\`${i.name}\` — ${i.category}${i.isDir ? "" : ` · ${mb(i.sizeBytes)}`}`).join("\n") : "_(none)_";

  const bucketLines = Object.entries(byBucket)
    .sort((a, b) => b[1] - a[1])
    .map(([b, n]) => `- **${b}**: ${n}`)
    .join("\n");

  const reportMarkdown = [
    "---",
    "type: downloads-triage",
    "status: dry-run (nothing moved or deleted)",
    "---",
    "",
    "# Downloads triage (dry-run)",
    "",
    `Scanned \`${root}\` — **${items.length}** items, **${mb(totalBytes)}** total. Nothing was moved or deleted.`,
    "",
    "## Inventory by bucket",
    bucketLines || "_(empty)_",
    "",
    "## 🔒 Important — protect",
    list(important),
    "",
    "## 🗑 Likely junk — safe to remove (your confirm → Recycle Bin)",
    list(junk),
    "",
    "## Proposed `_Sorted/` layout",
    "_Keepers would move into `Downloads/_Sorted/<category>/`; installers/archives are quarantined; subfolders move atomically. Enable the move + delete toggles in settings to apply — both are OFF by default._",
    "",
  ].join("\n");

  return {
    reportMarkdown,
    counts: { total: items.length, important: important.length, junkSafe: junk.length, byBucket },
  };
}
