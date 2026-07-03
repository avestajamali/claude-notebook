"""
Conversion Engine
=================
Turns any source file into Markdown text at the LOWEST possible token cost,
escalating to visual reading only when — and only for the page(s) where —
local text extraction is genuinely insufficient.

Design principle
----------------
A converted file is read by a SUBAGENT, never the main loop, and the result is
cached in Engine/.cache/ so it is never re-converted.

Tier ladder (auto-selected per file)
------------------------------------
  Tier 0  native text     .pptx .docx .xlsx .xlsm .csv .html .md .txt
                          -> markitdown -> .md            (~0 model tokens, local)
  Tier 1  legacy Office   .ppt .doc .xls
                          -> PowerPoint/Word/Excel COM -> modern -> markitdown
                                                          (~0 model tokens, local)
  Tier 2  PDF (text)      .pdf with a clean text layer
                          -> markitdown / pdfplumber -> .md (~0 model tokens, local)
  Tier 3  PDF/slide image  pages where text extraction fails
                          -> PyMuPDF renders ONLY the failing page(s) -> PNG
                             (the caller then visual-reads those PNGs)
                                                          (low tokens, per-page)
  Tier 4  cannot convert  .h5p .mov .mp4 .RData audio
                          -> returns a STUB marker; caller writes a pointer note
                                                          (0 tokens)

CLI usage
---------
    python convert.py "<path to source file>"
        -> prints the path to the produced .md (or a TIER3 / TIER4 marker)

    python convert.py "<path>" --quality
        -> prints a JSON quality report instead of converting

Library usage
-------------
    from convert import convert_to_markdown, classify
    result = convert_to_markdown(Path("Week 4.ppt"))
    # result = {"tier": 1, "md_path": "...", "quality": "ok", "notes": "..."}

Dependencies (all already installed):
    markitdown[all], pymupdf (fitz), pdfplumber, requests
    Microsoft Office (for Tier-1 COM conversion of legacy formats)
"""

import json
import re
import subprocess
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).parent
CACHE_DIR = SCRIPT_DIR / ".cache"
CACHE_DIR.mkdir(exist_ok=True)

# ── Tier classification ─────────────────────────────────────────────────────

TIER0_EXT = {".pptx", ".docx", ".xlsx", ".xlsm", ".csv", ".html", ".htm", ".md", ".txt"}
TIER1_EXT = {".ppt", ".doc", ".xls"}
TIER2_EXT = {".pdf"}
TIER4_EXT = {".h5p", ".mov", ".mp4", ".m4a", ".mp3", ".wav", ".rdata", ".rds"}

# Filename patterns that force a low-value classification (don't deep-extract).
# Textbook chapter solutions are huge and are referenced, not summarised.
TIER3_FORCE_POINTER_PATTERNS = [
    r"chapter\s*\d+\s*textbook",
    r"textbook\s*solution",
]


def classify(path: Path) -> int:
    """Return the tier (0-4) for a given file based on extension + filename."""
    ext = path.suffix.lower()
    if ext in TIER4_EXT:
        return 4
    if ext in TIER1_EXT:
        return 1
    if ext in TIER2_EXT:
        return 2
    if ext in TIER0_EXT:
        return 0
    # Unknown extension -> treat as pointer-only (Tier 4 behaviour)
    return 4


def is_textbook_pointer(path: Path) -> bool:
    """Detect textbook-chapter style files that should stay as pointer stubs."""
    name = path.name.lower()
    return any(re.search(p, name) for p in TIER3_FORCE_POINTER_PATTERNS)


# ── Quality heuristic ───────────────────────────────────────────────────────

def extraction_quality(md_text: str, n_pages: int = 1) -> dict:
    """
    Judge whether a local text extraction is good enough, or whether the caller
    should escalate to a page-level visual read (Tier 3).

    Signals:
      - chars per page (too few -> probably image-based slides)
      - ratio of image-placeholder markers to real text
      - garbled-math density ('??' soup from mangled equations is OK — the
        note-gen subagent reconstructs standard formulas from context — but a
        page that is ONLY garble with no words is not OK)
    """
    text = md_text.strip()
    total_chars = len(text)
    words = re.findall(r"[A-Za-z]{3,}", text)
    word_count = len(words)
    img_markers = len(re.findall(r"!\[|<img|\bPicture\d+\b|ContentPlaceholder", text))
    chars_per_page = total_chars / max(n_pages, 1)
    words_per_page = word_count / max(n_pages, 1)

    # Heuristic thresholds (tunable):
    #   - a healthy text page has >300 chars and >40 real words
    ok = (chars_per_page >= 300) and (words_per_page >= 40)
    return {
        "ok": ok,
        "total_chars": total_chars,
        "word_count": word_count,
        "chars_per_page": round(chars_per_page, 1),
        "words_per_page": round(words_per_page, 1),
        "image_markers": img_markers,
    }


# ── Tier 0 / 2 : markitdown ──────────────────────────────────────────────────

def _markitdown(path: Path) -> str:
    """Extract a file to markdown text via markitdown (local, no model tokens)."""
    from markitdown import MarkItDown
    md = MarkItDown()
    result = md.convert(str(path))
    return result.text_content or ""


# ── Tier 1 : legacy Office via PowerShell COM ────────────────────────────────

# SaveAs format codes:  pptx=24 (ppSaveAsOpenXMLPresentation)
#                       docx=16 (wdFormatXMLDocument)
#                       xlsx=51 (xlOpenXMLWorkbook)
_COM_CONVERT_PS = r"""
param([string]$src, [string]$dst, [string]$app, [int]$fmt)
try {
  switch ($app) {
    'powerpoint' {
      $a = New-Object -ComObject PowerPoint.Application
      $f = $a.Presentations.Open($src, $true, $false, $false)   # ReadOnly, Untitled=false, WithWindow=false
      $f.SaveAs($dst, $fmt)
      $f.Close(); $a.Quit()
    }
    'word' {
      $a = New-Object -ComObject Word.Application
      $a.Visible = $false
      $f = $a.Documents.Open($src, $false, $true)               # ConfirmConversions=false, ReadOnly=true
      $f.SaveAs([ref]$dst, [ref]$fmt)
      $f.Close($false); $a.Quit()
    }
    'excel' {
      $a = New-Object -ComObject Excel.Application
      $a.Visible = $false; $a.DisplayAlerts = $false
      $f = $a.Workbooks.Open($src, $false, $true)               # UpdateLinks=false, ReadOnly=true
      $f.SaveAs($dst, $fmt)
      $f.Close($false); $a.Quit()
    }
  }
  Write-Output 'OK'
} catch {
  Write-Output ('ERR: ' + $_.Exception.Message)
}
"""


def _com_convert(path: Path) -> Path | None:
    """Convert a legacy Office file to its modern equivalent via PowerShell COM.

    Returns the path to the converted file, or None on failure.
    """
    ext = path.suffix.lower()
    mapping = {
        ".ppt": ("powerpoint", 24, ".pptx"),
        ".doc": ("word", 16, ".docx"),
        ".xls": ("excel", 51, ".xlsx"),
    }
    if ext not in mapping:
        return None
    app, fmt, new_ext = mapping[ext]
    dst = CACHE_DIR / (path.stem + new_ext)
    if dst.exists():
        return dst

    # Write the PS script to a temp file to avoid quoting nightmares
    ps_file = CACHE_DIR / "_com_convert.ps1"
    ps_file.write_text(_COM_CONVERT_PS, encoding="utf-8")

    try:
        out = subprocess.run(
            ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass",
             "-File", str(ps_file),
             "-src", str(path.resolve()),
             "-dst", str(dst.resolve()),
             "-app", app, "-fmt", str(fmt)],
            capture_output=True, text=True, timeout=180,
        )
        result = (out.stdout or "").strip()
        if result.startswith("OK") and dst.exists():
            return dst
        # COM failure
        return None
    except Exception:
        return None


# ── Tier 3 : PyMuPDF page render ─────────────────────────────────────────────

def render_pdf_pages(path: Path, pages: list[int] | None = None, dpi: int = 150) -> list[Path]:
    """Render specified PDF page numbers (1-indexed) to PNGs for visual reading.

    If pages is None, renders ALL pages. Returns list of PNG paths.
    """
    import fitz  # PyMuPDF
    doc = fitz.open(str(path))
    out_paths = []
    page_indices = [p - 1 for p in pages] if pages else range(len(doc))
    for i in page_indices:
        if i < 0 or i >= len(doc):
            continue
        page = doc[i]
        pix = page.get_pixmap(dpi=dpi)
        png_path = CACHE_DIR / f"{path.stem}_p{i+1}.png"
        pix.save(str(png_path))
        out_paths.append(png_path)
    doc.close()
    return out_paths


def pdf_page_count(path: Path) -> int:
    try:
        import fitz
        doc = fitz.open(str(path))
        n = len(doc)
        doc.close()
        return n
    except Exception:
        return 1


# ── Main conversion entry point ──────────────────────────────────────────────

def convert_to_markdown(path: Path) -> dict:
    """
    Convert any source file to markdown text at lowest token cost.

    Returns a dict:
      {
        "tier": 0|1|2|3|4,
        "md_path": "<path to cached .md>" or None,
        "md_text": "<extracted text>" or None,
        "quality": "ok"|"poor"|"pointer"|"failed",
        "render_hint": [page numbers] (only when quality == 'poor'),
        "notes": "<human-readable explanation>",
      }
    """
    path = Path(path)
    if not path.exists():
        return {"tier": -1, "md_path": None, "md_text": None,
                "quality": "failed", "notes": f"File not found: {path}"}

    # Textbook chapters -> pointer stub (Tier 3 behaviour, no extraction)
    if is_textbook_pointer(path):
        return {"tier": 3, "md_path": None, "md_text": None, "quality": "pointer",
                "notes": "Textbook chapter — pointer stub only (too large to inline)."}

    tier = classify(path)
    cache_md = CACHE_DIR / (path.stem + ".md")

    # Tier 4: cannot convert
    if tier == 4:
        return {"tier": 4, "md_path": None, "md_text": None, "quality": "pointer",
                "notes": f"{path.suffix} cannot be converted to text — pointer stub only."}

    # Cache hit
    if cache_md.exists():
        text = cache_md.read_text(encoding="utf-8")
        return {"tier": tier, "md_path": str(cache_md), "md_text": text,
                "quality": "ok", "notes": "Loaded from cache."}

    # Tier 1: legacy Office -> modern -> markitdown
    if tier == 1:
        modern = _com_convert(path)
        if modern is None:
            return {"tier": 1, "md_path": None, "md_text": None, "quality": "failed",
                    "notes": f"COM conversion failed for {path.name}. "
                             f"Open in Office and Save As the modern format, or render to PDF."}
        try:
            text = _markitdown(modern)
        except Exception as e:
            return {"tier": 1, "md_path": None, "md_text": None, "quality": "failed",
                    "notes": f"markitdown failed on converted file: {e}"}
        cache_md.write_text(text, encoding="utf-8")
        q = extraction_quality(text)
        return {"tier": 1, "md_path": str(cache_md), "md_text": text,
                "quality": "ok" if q["ok"] else "poor",
                "notes": f"Converted via COM then markitdown. {q}"}

    # Tier 0 and Tier 2: markitdown directly
    try:
        text = _markitdown(path)
    except Exception as e:
        # PDF that markitdown can't parse -> escalate to render
        if tier == 2:
            n = pdf_page_count(path)
            return {"tier": 3, "md_path": None, "md_text": None, "quality": "poor",
                    "render_hint": list(range(1, n + 1)),
                    "notes": f"markitdown failed on PDF ({e}); render all {n} pages for visual read."}
        return {"tier": tier, "md_path": None, "md_text": None, "quality": "failed",
                "notes": f"markitdown failed: {e}"}

    cache_md.write_text(text, encoding="utf-8")

    n_pages = pdf_page_count(path) if tier == 2 else max(1, text.count("<!-- Slide number"))
    q = extraction_quality(text, n_pages)
    quality = "ok" if q["ok"] else "poor"
    result = {"tier": tier, "md_path": str(cache_md), "md_text": text,
              "quality": quality, "notes": f"{q}"}
    if quality == "poor" and tier == 2:
        # Suggest rendering the whole doc for a visual read; the caller may
        # narrow this to specific pages.
        result["render_hint"] = list(range(1, n_pages + 1))
    return result


# ── CLI ──────────────────────────────────────────────────────────────────────

def _cli():
    if len(sys.argv) < 2:
        print("usage: python convert.py <file> [--quality]")
        sys.exit(1)
    path = Path(sys.argv[1])
    if "--quality" in sys.argv:
        res = convert_to_markdown(path)
        # strip the big md_text for readability
        res.pop("md_text", None)
        print(json.dumps(res, indent=2))
        return
    res = convert_to_markdown(path)
    if res["quality"] in ("ok",):
        print(f"TIER{res['tier']}  OK  -> {res['md_path']}")
    elif res["quality"] == "poor":
        hint = res.get("render_hint", [])
        print(f"TIER{res['tier']}  POOR (escalate to visual read) "
              f"pages={hint}  cached={res.get('md_path')}")
    elif res["quality"] == "pointer":
        print(f"TIER{res['tier']}  POINTER  {res['notes']}")
    else:
        print(f"FAILED  {res['notes']}")


if __name__ == "__main__":
    _cli()
