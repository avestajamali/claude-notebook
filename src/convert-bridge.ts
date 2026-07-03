import { spawn } from "child_process";

/**
 * Bridge to Engine/convert.py — the Tier-0..4 local conversion engine.
 *
 * We invoke `python convert.py "<file>" --quality`, which prints a structured JSON
 * result (with the big md_text stripped), instead of parsing the human-readable
 * status line. The cached markdown lives at `mdPath`; conversion is local and
 * token-free. Only image-only PDF pages come back as `quality: "poor"` with a
 * `renderHint` page list for a downstream visual read.
 *
 * convert.py CLI (verified against Engine/convert.py:338-359):
 *   python convert.py <file>            -> "TIERn  OK  -> <md>" | "TIERn  POOR ... cached=<md>"
 *                                          | "TIERn  POINTER  <notes>" | "FAILED  <notes>"
 *   python convert.py <file> --quality  -> JSON {tier, md_path, quality, notes, render_hint?}
 */

export interface ConvertResult {
  /** convert.py tier (0 office, 1 legacy-COM, 2 pdf-text, 3 pdf-render, 4 pointer); -1 on bridge error. */
  tier: number;
  /** Absolute path to the cached .md, or null if conversion produced no markdown. */
  mdPath: string | null;
  /** "ok" | "poor" | "pointer" | "failed". */
  quality: string;
  notes?: string;
  /** 1-based PDF pages that need a visual read (only when quality === "poor"). */
  renderHint?: number[];
}

export interface ConvertOpts {
  /** Path to the python interpreter. Default "python". */
  pythonPath?: string;
  /** Absolute path to Engine/convert.py. */
  convertPyPath: string;
  /** Hard timeout for a single conversion. Default 120000ms. */
  timeoutMs?: number;
}

function fail(notes: string): ConvertResult {
  return { tier: -1, mdPath: null, quality: "failed", notes };
}

/** Convert a single file to markdown via convert.py. Never rejects — errors come back as quality:"failed". */
export function convertToMarkdown(file: string, opts: ConvertOpts): Promise<ConvertResult> {
  const python = opts.pythonPath || "python";
  const timeoutMs = opts.timeoutMs ?? 120000;

  return new Promise<ConvertResult>((resolve) => {
    let settled = false;
    const done = (r: ConvertResult): void => {
      if (settled) return;
      settled = true;
      resolve(r);
    };

    if (!opts.convertPyPath) {
      done(fail("convert.py path is not set — configure it in the plugin settings"));
      return;
    }

    const env = { ...process.env, PYTHONIOENCODING: "utf-8" };
    let child;
    try {
      child = spawn(python, [opts.convertPyPath, file, "--quality"], { env });
    } catch (e) {
      done(fail(`spawn failed: ${String(e)}`));
      return;
    }

    let out = "";
    let err = "";

    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* best effort */
      }
      done(fail(`convert.py timed out after ${timeoutMs}ms on ${file}`));
    }, timeoutMs);

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (c: string) => {
      out += c;
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (c: string) => {
      err += c;
    });

    child.on("error", (e: Error) => {
      clearTimeout(timer);
      done(fail(`python error: ${e.message} (is "${python}" on PATH?)`));
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      // --quality emits one JSON object; slice the outermost {...} defensively.
      const start = out.indexOf("{");
      const end = out.lastIndexOf("}");
      if (start >= 0 && end > start) {
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const j: any = JSON.parse(out.slice(start, end + 1));
          done({
            tier: typeof j.tier === "number" ? j.tier : -1,
            mdPath: typeof j.md_path === "string" ? j.md_path : null,
            quality: typeof j.quality === "string" ? j.quality : "failed",
            notes: typeof j.notes === "string" ? j.notes : undefined,
            renderHint: Array.isArray(j.render_hint) ? j.render_hint : undefined,
          });
          return;
        } catch {
          /* fall through to error */
        }
      }
      done(fail(err.trim() || `convert.py exited ${code} with no parseable JSON`));
    });
  });
}

/** Extensions convert.py handles natively (Tier 0-2). Images/code/archives are routed elsewhere. */
export const CONVERTIBLE_EXTS = new Set([
  ".pptx", ".ppt", ".docx", ".doc", ".xlsx", ".xls", ".xlsm",
  ".csv", ".tsv", ".html", ".htm", ".pdf",
]);

/** True if convert.py is the right tool for this file (by extension). */
export function isConvertible(file: string): boolean {
  const dot = file.lastIndexOf(".");
  if (dot < 0) return false;
  return CONVERTIBLE_EXTS.has(file.slice(dot).toLowerCase());
}
