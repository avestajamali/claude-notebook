import { App, FileSystemAdapter, htmlToMarkdown, normalizePath, requestUrl } from "obsidian";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { convertToMarkdown, isConvertible } from "./convert-bridge";
import {
  buildFrontmatter,
  classify,
  detectSensitive,
  displaySize,
  noteTypeOf,
  parseIcs,
  seedSummary,
  seedTags,
} from "./facility";

/** A dropped .ics becomes Full Calendar event notes (facility plan: calendar bridge, 0 tokens). */
async function ingestIcs(app: App, absPath: string, eventsFolder: string): Promise<IngestResult> {
  const events = parseIcs(fs.readFileSync(absPath, "utf8"));
  if (!events.length) return { ok: false, error: "no parseable VEVENTs in this .ics" };
  await ensureFolder(app, eventsFolder);
  let created = 0;
  let skipped = 0;
  let last = "";
  for (const ev of events) {
    const safe = ev.title.replace(/[\\/:*?"<>|#^[\]]+/g, "").trim().slice(0, 80) || "Event";
    const p = normalizePath(`${eventsFolder}/${ev.date} ${safe}.md`);
    if (await app.vault.adapter.exists(p)) {
      skipped++;
      continue;
    }
    const fm: Record<string, string | number | boolean | string[] | null> = {
      title: ev.title,
      allDay: ev.allDay,
      date: ev.date,
      startTime: ev.startTime ?? null,
      endTime: ev.endTime ?? null,
    };
    const body = [
      ev.location ? `**Where:** ${ev.location}` : "",
      ev.rrule ? `> [!info] Recurring in the source calendar (\`${ev.rrule}\`) — only this first occurrence was imported.` : "",
      `*Imported from \`${path.basename(absPath)}\`.*`,
    ].filter(Boolean).join("\n\n");
    await app.vault.create(p, `${buildFrontmatter(fm)}\n${body}\n`);
    created++;
    last = p;
  }
  return {
    ok: true,
    notePath: last || undefined,
    blurb: `📅 ${created} event(s) → ${eventsFolder}${skipped ? ` (${skipped} already there)` : ""}`,
  };
}

/**
 * Component A — drop-anything ingestion.
 *
 * Every file/link that enters the agent is PERSISTED, always:
 *   - a readable .md note in <droppedNotesPath>/        (git-ignored, Obsidian-indexed)
 *   - the original binary in <droppedNotesPath>/_files/  (git-ignored, hash-named)
 * Content-hash keyed: an identical re-drop reuses the existing note (no re-conversion);
 * a changed file with the same name converts again; name collisions get a hash suffix.
 *
 * convert.py does the heavy lifting at ~0 tokens for office/pdf; images are archived and
 * read visually on demand; links are fetched and reduced to markdown.
 */

export interface IngestConfig {
  droppedNotesPath: string; // vault-relative, e.g. "Dropped Notes"
  convertPyPath: string;
  pythonPath: string;
}

export interface IngestResult {
  ok: boolean;
  /** Vault-relative path to the persisted note. */
  notePath?: string;
  /** Short context blurb to hand the agent (path + how to read it). */
  blurb?: string;
  tier?: number;
  deduped?: boolean;
  error?: string;
}

const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg"]);
const TEXT_EXTS = new Set([".md", ".markdown", ".txt", ".text"]);

function vaultBase(app: App): string | null {
  const a = app.vault.adapter;
  return a instanceof FileSystemAdapter ? a.getBasePath() : null;
}

function sha1File(absPath: string): string {
  const buf = fs.readFileSync(absPath);
  return crypto.createHash("sha1").update(buf).digest("hex");
}

function sha1Str(s: string): string {
  return crypto.createHash("sha1").update(s, "utf8").digest("hex");
}

/** Filesystem-safe note basename: original stem + a short hash, so collisions never overwrite. */
function noteName(stem: string, hash8: string): string {
  const safe = stem.replace(/[\\/:*?"<>|]+/g, "_").trim() || "file";
  return `${safe} (${hash8}).md`;
}

function ext(p: string): string {
  const dot = p.lastIndexOf(".");
  return dot < 0 ? "" : p.slice(dot).toLowerCase();
}

function today(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

async function ensureFolder(app: App, vaultRel: string): Promise<void> {
  const norm = normalizePath(vaultRel);
  if (!(await app.vault.adapter.exists(norm))) {
    try {
      await app.vault.createFolder(norm);
    } catch {
      /* concurrent create — fine */
    }
  }
}

function frontmatter(fields: Record<string, string | number>): string {
  const lines = Object.entries(fields).map(([k, v]) => `${k}: ${typeof v === "string" ? JSON.stringify(v) : v}`);
  return `---\n${lines.join("\n")}\n---\n`;
}

/** Dedup lookup across category folders: the note whose name carries this hash prefix. */
function findNoteByHash(app: App, notesRel: string, hash8: string): string | null {
  const prefix = normalizePath(notesRel) + "/";
  const marker = `(${hash8})`;
  for (const f of app.vault.getMarkdownFiles()) {
    if (f.path.startsWith(prefix) && f.basename.endsWith(marker)) return f.path;
  }
  return null;
}

/**
 * Ingest a single local file. Routes by type, archives the original, writes the note.
 * Never throws — failures come back as { ok: false, error }.
 */
export async function ingestFile(app: App, cfg: IngestConfig, absPath: string): Promise<IngestResult> {
  try {
    if (!fs.existsSync(absPath)) return { ok: false, error: `file not found: ${absPath}` };
    const base = vaultBase(app);
    if (!base) return { ok: false, error: "ingestion requires a desktop (filesystem) vault" };

    const e = ext(absPath);
    // Calendar bridge: .ics files become Full Calendar events, not store notes.
    if (e === ".ics") return await ingestIcs(app, absPath, "Calendar/Events");
    const stem = path.basename(absPath, e);
    const hash = sha1File(absPath);
    const hash8 = hash.slice(0, 8);

    const notesRel = cfg.droppedNotesPath;
    const filesRel = `${notesRel}/_files`;
    await ensureFolder(app, notesRel);

    // Dedup: if this exact content is already archived, reuse its note wherever it lives.
    const originalRel = `_files/${hash}${e}`;
    const originalAbs = path.join(base, normalizePath(filesRel), `${hash}${e}`);
    if (fs.existsSync(originalAbs)) {
      const existing = findNoteByHash(app, notesRel, hash8);
      if (existing) return { ok: true, notePath: existing, deduped: true, blurb: `Already ingested: [[${existing}]]` };
    }

    // Archive the original (binary-safe copy via node fs).
    try {
      fs.mkdirSync(path.dirname(originalAbs), { recursive: true });
      fs.copyFileSync(absPath, originalAbs);
    } catch (err) {
      return { ok: false, error: `could not archive original: ${String(err)}` };
    }

    let body: string;
    let tier = -1;
    let quality = "n/a";
    let pages: number | null = null;
    let how: string;

    if (IMAGE_EXTS.has(e)) {
      how = "image — rendered inline";
      body = `![[${notesRel}/${originalRel}]]`;
    } else if (TEXT_EXTS.has(e)) {
      how = "text inlined";
      body = fs.readFileSync(absPath, "utf8");
      quality = "ok";
    } else if (isConvertible(absPath)) {
      const r = await convertToMarkdown(absPath, { convertPyPath: cfg.convertPyPath, pythonPath: cfg.pythonPath });
      tier = r.tier;
      quality = r.quality;
      if (r.quality === "failed" || !r.mdPath) {
        how = `convert.py failed (${r.notes ?? "no detail"}) — original archived`;
        body = `> [!warning] Conversion failed. Original archived at \`${originalRel}\`.\n>\n> ${r.notes ?? ""}`;
      } else {
        how = `converted via convert.py tier ${r.tier}${r.quality === "poor" ? " (image pages — visual read may be needed)" : ""}`;
        try {
          body = fs.readFileSync(r.mdPath, "utf8");
        } catch {
          body = `> [!warning] Converted markdown not readable at ${r.mdPath}.`;
        }
        const pm = /<!--\s*pages:\s*(\d+)\s*-->/.exec(body);
        if (pm) pages = Number(pm[1]);
      }
    } else {
      how = "unsupported type — original archived";
      body = `> [!info] Original archived at \`${originalRel}\` (no text extraction for \`${e}\`).`;
    }

    // Zero-token drop path: classify + enrich locally; Haiku polish is the sweep's job.
    const size = fs.statSync(absPath).size;
    const noteType = quality === "failed" ? "stub" : noteTypeOf(e, tier >= 0);
    const cls = classify(path.basename(absPath), absPath, body);
    const sensitive = detectSensitive(`${path.basename(absPath)}\n${body}`);
    const confident = cls.confidence >= 0.5;
    const catRel = `${notesRel}/${cls.category.folder}`;
    await ensureFolder(app, catRel);
    const notePath = normalizePath(`${catRel}/${noteName(stem, hash8)}`);

    const fm = buildFrontmatter({
      title: stem,
      type: noteType,
      category: cls.category.slug,
      confidence: cls.confidence,
      tags: seedTags(cls.category.slug, path.basename(absPath), noteType),
      status: confident && noteType !== "stub" ? "active" : "inbox",
      summary: seedSummary(body),
      sensitive,
      size_bytes: size,
      size: displaySize(size),
      pages,
      source: absPath,
      origin: path.basename(path.dirname(absPath)),
      original: originalRel,
      hash,
      tier,
      convert_quality: quality,
      ingested: today(),
      schema_version: 1,
    });
    const content = [
      fm,
      `# ${stem}`,
      "",
      `> [!quote] Source`,
      `> \`${absPath}\` — ingested ${today()} (${how}). Original: [\`${originalRel}\`](${encodeURI(`${notesRel}/${originalRel}`)})`,
      "",
      `> [!tldr] ${seedSummary(body) || "(pending nightly enrich)"}`,
      "",
      // PDFs: embed the original so the note (and its canvas card) shows the real
      // rendered document above the extracted text. Zero tokens — Obsidian's viewer.
      ...(e === ".pdf" ? [`![[${notesRel}/${originalRel}]]`, ""] : []),
      body,
      "",
    ].join("\n");

    if (await app.vault.adapter.exists(notePath)) {
      await app.vault.adapter.write(notePath, content);
    } else {
      await app.vault.create(notePath, content);
    }

    return { ok: true, notePath, tier, blurb: `Ingested → [[${notePath}]] (${cls.category.slug} via ${cls.via}; ${how})` };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

/** Ingest a URL: fetch, reduce to markdown, persist a note. Never throws. */
export async function ingestLink(app: App, cfg: IngestConfig, url: string): Promise<IngestResult> {
  try {
    const base = vaultBase(app);
    if (!base) return { ok: false, error: "ingestion requires a desktop (filesystem) vault" };
    await ensureFolder(app, cfg.droppedNotesPath);

    let md: string;
    let title = url;
    try {
      const resp = await requestUrl({ url });
      const html = resp.text;
      const m = /<title[^>]*>([^<]*)<\/title>/i.exec(html);
      if (m) title = m[1].trim() || url;
      md = htmlToMarkdown(html);
    } catch (err) {
      return { ok: false, error: `fetch failed: ${String(err)}` };
    }

    const hash8 = sha1Str(url).slice(0, 8);
    const stem = title.slice(0, 80);
    const notePath = normalizePath(`${cfg.droppedNotesPath}/${noteName(stem, hash8)}`);
    if (await app.vault.adapter.exists(notePath)) {
      return { ok: true, notePath, deduped: true, blurb: `Already saved: [[${notePath}]]` };
    }

    const fm = frontmatter({ source: url, type: "link", hash: sha1Str(url), ingested: today(), category: "uncategorized" });
    const content = `${fm}\n# ${title}\n\n*Saved ${today()} from ${url}*\n\n${md}\n`;
    await app.vault.create(notePath, content);
    return { ok: true, notePath, blurb: `Saved → [[${notePath}]]` };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}
