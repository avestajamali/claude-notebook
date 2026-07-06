import { App, FileSystemAdapter, MarkdownView, WorkspaceLeaf } from "obsidian";
import * as fs from "fs";
import * as path from "path";
import { convertToMarkdown } from "./convert-bridge";

/**
 * Send-tab context — "Send this tab to Claude".
 *
 * Reads the content of an arbitrary leaf so the agent can work with it:
 *   - MarkdownView  -> the note's text
 *   - PDF view      -> convert.py the underlying file
 *   - anything else -> the leaf's visible text
 * Extracts are clipped to keep turns token-efficient.
 */

export interface LeafExtract {
  title: string;
  source: string;
  content: string;
}

export interface LeafCfg {
  convertPyPath: string;
  pythonPath: string;
  maxChars: number;
}

function vaultBase(app: App): string | null {
  const a = app.vault.adapter;
  return a instanceof FileSystemAdapter ? a.getBasePath() : null;
}

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}\n\n…[truncated ${s.length - max} chars]` : s;
}

export async function extractLeafContent(
  app: App,
  cfg: LeafCfg,
  leaf: WorkspaceLeaf,
): Promise<LeafExtract | null> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const view = leaf.view as any;
  const vtype: string = view?.getViewType?.() ?? "";

  // 1) Markdown note
  if (view instanceof MarkdownView) {
    const file = view.file;
    return {
      title: file?.basename ?? "note",
      source: file?.path ?? "(unsaved note)",
      content: clip(view.getViewData(), cfg.maxChars),
    };
  }

  // 2) PDF — convert the underlying file via convert.py
  if (vtype === "pdf" && view?.file?.path) {
    const base = vaultBase(app);
    if (base) {
      const abs = path.join(base, view.file.path);
      const r = await convertToMarkdown(abs, { convertPyPath: cfg.convertPyPath, pythonPath: cfg.pythonPath });
      if (r.mdPath) {
        try {
          return {
            title: view.file.basename ?? "pdf",
            source: view.file.path,
            content: clip(fs.readFileSync(r.mdPath, "utf8"), cfg.maxChars),
          };
        } catch {
          /* fall through */
        }
      }
      return {
        title: view.file.basename ?? "pdf",
        source: view.file.path,
        content: `(PDF — conversion ${r.quality}${r.notes ? `: ${r.notes}` : ""})`,
      };
    }
  }

  // 3) Fallback — the leaf's visible text
  const el = view?.contentEl as HTMLElement | undefined;
  const text = el ? el.innerText || el.textContent || "" : "";
  if (text.trim()) {
    return {
      title: view?.getDisplayText?.() ?? (vtype || "tab"),
      source: `(${vtype || "view"})`,
      content: clip(text, cfg.maxChars),
    };
  }
  return null;
}
