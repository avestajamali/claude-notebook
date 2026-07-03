import { App, Component, MarkdownRenderer } from "obsidian";

/**
 * StreamRenderer — the streaming text pipeline for assistant turns.
 *
 * The wire delivers bursty CLI chunks; painting them raw looks choppy, and a single
 * MarkdownRenderer pass at the end wipes the element (flash + reflow + scroll jump).
 * This class replaces both with a two-stage pipeline:
 *
 *  1. PACING — deltas land in a pending buffer; a requestAnimationFrame loop reveals a
 *     few characters per frame. The rate is adaptive (proportional to the backlog), so
 *     the visible text trails the wire by ~TARGET_LAG_MS at steady state, absorbs bursts,
 *     and never runs dry between them. The loop parks (no rAF scheduled) whenever the
 *     backlog is empty — long tool-use pauses cost nothing.
 *
 *  2. PROGRESSIVE MARKDOWN — revealed text is split into settled blocks + a live tail.
 *     A block settles at a blank line that is outside any ``` fence and outside $$ math,
 *     and not between two list-ish lines (loose lists stay whole). Each settled block
 *     gets exactly one MarkdownRenderer pass and is never re-rendered; until that render
 *     lands, the block shows its text as a plain placeholder, so a stalled render chain
 *     (MathJax's first load, slow post-processors) never leaves a hole where text just
 *     was. Only the tail is live plain text, wearing a soft caret at the insertion point.
 *
 * finish(finalMd) drains the backlog fast, renders the remaining tail in place — no
 * whole-message wipe — and falls back to one clean render only when finalMd differs
 * from what streamed (errors, result-only turns, placeholder texts). cancel() stops the
 * loop immediately and renders whatever was revealed, cleanly, with no caret left over.
 *
 * Lifecycle guarantees: one rAF loop per instance, parked when idle, cancelled by
 * finish()/cancel(); no timers; renders are chained through `component`, so Obsidian
 * unloads any child components with the owning view.
 */

/** Steady-state distance the visible text trails the wire by. */
const TARGET_LAG_MS = 900;
/** Reveal floor (chars/sec) — keeps a calm typewriter pace when the backlog is tiny. */
const MIN_CHARS_PER_SEC = 180;
/** finish(): drain whatever is left across at most this many frames. */
const FLUSH_FRAMES = 5;
const FLUSH_MIN_CHARS = 256;

export interface StreamRendererOpts {
  /**
   * Called after each visible growth. `stick` is whether the scroller was at (or near)
   * the bottom immediately BEFORE the growth — scroll to bottom iff it is true. Measuring
   * before the mutation is what keeps follow-mode from breaking when a settled block
   * lands taller than the plain text it replaced.
   */
  onGrow: (stick: boolean) => void;
  /** Measured right before each DOM mutation to compute `stick`. Default: always true. */
  isAtBottom?: () => boolean;
}

interface BlockCut {
  /** Exclusive end of the settled block's text within the tail. */
  end: number;
  /** Start of the remaining tail (the first content line after the blank run). */
  next: number;
}

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const BLANK_RE = /^[ \t]*$/;
const LIST_RE = /^ {0,3}(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$)/;
const LIST_CONT_RE = /^(?: {2,}|\t)/;

/** Non-overlapping `$$` tokens on one line — odd count toggles display-math state. */
function countMathTokens(line: string): number {
  let n = 0;
  let i = 0;
  for (;;) {
    const j = line.indexOf("$$", i);
    if (j < 0) return n;
    n++;
    i = j + 2;
  }
}

/**
 * A line that OPENS a fence, or null. CommonMark: a backtick fence's info string may
 * not contain a backtick — a prose line like ``` `foo` ``` is a paragraph, not a fence.
 * Without this check such a line would phantom-open a fence, freeze settling, and make
 * closeOpenFence() append a stray ``` at finish/cancel. Tilde fences are exempt.
 */
function openFence(line: string): RegExpExecArray | null {
  const m = FENCE_RE.exec(line);
  return m && m[1][0] === "`" && m[2].includes("`") ? null : m;
}

/**
 * A line that can belong to or continue a list: a list marker, or an indented
 * continuation line (which also covers 4-space indented code). Used on BOTH sides of a
 * candidate boundary; the test is deliberately generous, because over-holding is always
 * safe — one settled chunk containing two markdown blocks renders identically to the
 * split — while over-splitting is what visibly breaks a loose list in half.
 */
function isListy(line: string): boolean {
  return LIST_RE.test(line) || LIST_CONT_RE.test(line);
}

/**
 * Find the first COMPLETE markdown block in `tail`, or null if none has settled yet.
 * A block settles at a blank line, provided that:
 *  - the blank line is outside any code fence and outside open $$ math (both are held
 *    whole until they close — a half fence or half formula never renders);
 *  - the first non-blank line after it exists already (we need it to judge list
 *    continuation, and it means the block genuinely ended rather than paused);
 *  - the content lines adjacent to the blank (last before, first after) are not both
 *    list-ish — loose lists, including ones led in by a paragraph, items with
 *    continuation paragraphs, and items with indented code between them, must render
 *    as ONE list, never as restarted fragments.
 */
function findSettledBlock(tail: string): BlockCut | null {
  let inFence = false;
  let fenceChar = "";
  let fenceLen = 0;
  let inMath = false;
  let sawContent = false;
  let lastContentLine = ""; // the content line directly above a candidate boundary
  let boundaryStart = -1;
  let pos = 0;

  for (;;) {
    const nl = tail.indexOf("\n", pos);
    if (nl < 0) return null; // the final, still-growing line is never scanned
    const line = tail.slice(pos, nl);
    const lineStart = pos;
    pos = nl + 1;

    if (boundaryStart < 0) {
      // Inside the growing block.
      if (inFence) {
        const m = FENCE_RE.exec(line);
        if (m && m[1][0] === fenceChar && m[1].length >= fenceLen && m[2].trim() === "") {
          inFence = false;
        }
        continue;
      }
      if (inMath) {
        if (countMathTokens(line) % 2 === 1) inMath = false;
        continue;
      }
      if (BLANK_RE.test(line)) {
        if (sawContent) boundaryStart = lineStart; // candidate boundary
        continue;
      }
      sawContent = true;
      lastContentLine = line;
      const fm = openFence(line);
      if (fm) {
        inFence = true;
        fenceChar = fm[1][0];
        fenceLen = fm[1].length;
        continue;
      }
      if (countMathTokens(line) % 2 === 1) inMath = true;
      continue;
    }

    // After a candidate boundary: wait for the first non-blank line (the lookahead).
    if (BLANK_RE.test(line)) continue;
    if (isListy(lastContentLine) && isListy(line)) {
      // Not a real boundary — the same list continues. Absorb this line into the block.
      boundaryStart = -1;
      lastContentLine = line;
      const fm = openFence(line);
      if (fm) {
        inFence = true;
        fenceChar = fm[1][0];
        fenceLen = fm[1].length;
      } else if (countMathTokens(line) % 2 === 1) {
        inMath = true;
      }
      continue;
    }
    return { end: boundaryStart, next: lineStart };
  }
}

/** If `md` ends inside an open ``` fence, close it so a terminal render can't leak. */
function closeOpenFence(md: string): string {
  let inFence = false;
  let fenceChar = "";
  let fenceLen = 0;
  for (const line of md.split("\n")) {
    if (!inFence) {
      const m = openFence(line);
      if (m) {
        inFence = true;
        fenceChar = m[1][0];
        fenceLen = m[1].length;
      }
    } else {
      const m = FENCE_RE.exec(line);
      if (m && m[1][0] === fenceChar && m[1].length >= fenceLen && m[2].trim() === "") {
        inFence = false;
      }
    }
  }
  return inFence ? md + "\n" + fenceChar.repeat(fenceLen) : md;
}

/** Don't cut between the halves of a surrogate pair (emoji would mojibake for a frame). */
function safeCut(s: string, n: number): number {
  if (n >= s.length) return s.length;
  const c = s.charCodeAt(n - 1);
  return c >= 0xd800 && c <= 0xdbff ? n + 1 : n;
}

export class StreamRenderer {
  private pending = ""; // received from the wire, not yet revealed
  private wire = ""; // everything received (finish() compares against this)
  private tailText = ""; // revealed text not yet settled into a rendered block
  private carry = 0; // fractional chars/frame accumulator
  private raf: number | null = null;
  private lastFrameTs = 0;
  private state: "streaming" | "finishing" | "done" = "streaming";
  private built = false; // stream DOM created (the typing dots were cleared)
  private tailEl: HTMLElement | null = null;
  private tailTextNode: Text | null = null;
  private renderChain: Promise<void> = Promise.resolve();
  private drainWaiter: (() => void) | null = null;
  private readonly reduceMotion: boolean;

  constructor(
    private readonly container: HTMLElement,
    private readonly app: App,
    private readonly sourcePath: string,
    private readonly component: Component,
    private readonly opts: StreamRendererOpts,
  ) {
    // The CSS additions mirror both conditions, so JS pacing and CSS animation agree.
    this.reduceMotion =
      window.matchMedia("(prefers-reduced-motion: reduce)").matches ||
      document.body.classList.contains("reduced-motion"); // harmless if the app never sets it
  }

  /** Feed a wire delta. Cheap: buffers and (re)arms the frame loop. */
  push(delta: string): void {
    if (this.state !== "streaming" || !delta) return;
    this.wire += delta;
    this.pending += delta;
    this.ensureLoop();
  }

  /**
   * Complete the stream. If `finalText` is what actually streamed (or is omitted), the
   * backlog flushes fast and the tail renders IN PLACE — no wipe, no flash. If it differs
   * (error text, result-only turn, placeholder), falls back to one clean full render.
   */
  async finish(finalText?: string): Promise<void> {
    if (this.state === "done") return;
    if (finalText !== undefined && finalText !== this.wire) {
      await this.finishClean(finalText);
      return;
    }
    this.state = "finishing";
    if (this.pending.length > 0) {
      await new Promise<void>((resolve) => {
        this.drainWaiter = resolve;
        this.ensureLoop();
      });
    }
    if (this.state !== "finishing") return; // cancelled while draining
    this.state = "done";
    this.stopLoop();
    this.sealTail();
    await this.renderChain;
  }

  /**
   * Stop immediately: kill the rAF loop, drop the unrevealed backlog (the user said
   * stop), and render what already streamed as clean markdown — no dangling caret.
   * Idempotent; safe to call after finish().
   */
  cancel(): void {
    if (this.state === "done") return;
    const waiter = this.drainWaiter;
    this.drainWaiter = null;
    this.state = "done";
    this.stopLoop();
    this.pending = "";
    this.sealTail();
    if (waiter) waiter(); // release a finish() that was mid-drain; it exits on `state`
  }

  // ── frame loop ─────────────────────────────────────────────────────────────

  private ensureLoop(): void {
    if (this.raf === null && this.state !== "done") {
      this.lastFrameTs = performance.now();
      this.raf = requestAnimationFrame(this.frame);
    }
  }

  private stopLoop(): void {
    if (this.raf !== null) {
      cancelAnimationFrame(this.raf);
      this.raf = null;
    }
  }

  private readonly frame = (): void => {
    this.raf = null;
    if (this.state === "done") return;
    if (this.pending.length > 0) {
      const n = this.frameBudget();
      if (n > 0) {
        const cut = safeCut(this.pending, n);
        const chunk = this.pending.slice(0, cut);
        this.pending = this.pending.slice(cut);
        this.reveal(chunk);
      }
    }
    if (this.pending.length > 0) {
      this.lastFrameTs = performance.now();
      this.raf = requestAnimationFrame(this.frame);
      return;
    }
    // Backlog empty: park the loop. push() re-arms it; a waiting finish() proceeds.
    if (this.state === "finishing" && this.drainWaiter) {
      const w = this.drainWaiter;
      this.drainWaiter = null;
      w();
    }
  };

  /** Adaptive per-frame character budget. */
  private frameBudget(): number {
    const backlog = this.pending.length;
    if (this.reduceMotion) return backlog; // reduced motion: no typewriter, instant drain
    if (this.state === "finishing") {
      return Math.min(backlog, Math.max(FLUSH_MIN_CHARS, Math.ceil(backlog / FLUSH_FRAMES)));
    }
    // Refresh-rate independent: budget scales with real elapsed time.
    const now = performance.now();
    const dt = Math.min(48, Math.max(4, now - this.lastFrameTs));
    const min = (MIN_CHARS_PER_SEC * dt) / 1000;
    const rate = Math.max(min, (backlog * dt) / TARGET_LAG_MS);
    this.carry += rate;
    const n = Math.floor(this.carry);
    this.carry -= n;
    return Math.min(n, backlog);
  }

  // ── DOM ────────────────────────────────────────────────────────────────────

  /** First real text replaces whatever occupied the container (the typing dots). */
  private ensureBuilt(): void {
    if (this.built) return;
    this.built = true;
    this.container.empty();
    this.tailEl = this.container.createDiv({ cls: "cn-sr-tail" });
    this.tailTextNode = document.createTextNode("");
    this.tailEl.appendChild(this.tailTextNode);
    this.tailEl.createSpan({ cls: "cn-sr-caret" });
  }

  private reveal(chunk: string): void {
    const stick = this.opts.isAtBottom ? this.opts.isAtBottom() : true;
    this.ensureBuilt();
    this.tailText += chunk;
    if (this.tailTextNode) this.tailTextNode.appendData(chunk);
    // Boundaries only ever complete when a newline lands — skip the scan otherwise.
    if (chunk.indexOf("\n") >= 0) this.settleBlocks();
    this.opts.onGrow(stick);
  }

  /** Move every block that has settled out of the tail and into a rendered div. */
  private settleBlocks(): void {
    for (;;) {
      const cut = findSettledBlock(this.tailText);
      if (!cut) return;
      const md = this.tailText.slice(0, cut.end);
      if (this.tailTextNode) this.tailTextNode.deleteData(0, cut.next);
      this.tailText = this.tailText.slice(cut.next);
      this.enqueueBlock(md);
    }
  }

  /**
   * Insert the block's element synchronously (so DOM order is fixed even though renders
   * are async) and chain its one-and-only markdown render. Settled blocks never
   * re-render. Until its render lands, the block carries its text as a plain
   * placeholder — if the chain stalls on an earlier block (MathJax's lazy first load,
   * a slow post-processor), the just-settled text stays visible instead of vanishing.
   * The placeholder→rendered swap happens inside one microtask, so it cannot flash.
   */
  private enqueueBlock(md: string): void {
    const el = document.createElement("div");
    el.className = "cn-sr-block cn-sr-pending";
    el.textContent = md;
    if (this.tailEl && this.tailEl.parentElement === this.container) {
      this.container.insertBefore(el, this.tailEl);
    } else {
      this.container.appendChild(el);
    }
    this.renderChain = this.renderChain
      .then(async () => {
        const stick = this.opts.isAtBottom ? this.opts.isAtBottom() : true;
        el.empty();
        el.removeClass("cn-sr-pending");
        try {
          await MarkdownRenderer.render(this.app, md, el, this.sourcePath, this.component);
          if (!this.reduceMotion) el.addClass("cn-sr-in");
        } catch {
          // A failed render must not leave a hole — put the plain text back.
          el.setText(md);
          el.addClass("cn-sr-pending");
        }
        this.opts.onGrow(stick);
      })
      .catch(() => {
        /* an opts callback throwing must not wedge the pipeline */
      });
  }

  /**
   * Terminal, in-place completion: hand the remaining tail text to a settled block
   * (open fences auto-closed) and remove the plain tail + caret in the same synchronous
   * run — the placeholder already shows the identical text, so there is no flash, no
   * duplicate, and no caret lingering while the render chain drains.
   */
  private sealTail(): void {
    this.ensureBuilt();
    const md = this.tailText;
    this.tailText = "";
    if (md.trim().length > 0) this.enqueueBlock(closeOpenFence(md));
    const tailEl = this.tailEl;
    this.tailEl = null;
    this.tailTextNode = null;
    if (tailEl) tailEl.remove();
  }

  /** The sanctioned fallback: one clean render of text that differs from the stream. */
  private async finishClean(md: string): Promise<void> {
    this.state = "done";
    this.stopLoop();
    this.pending = "";
    await this.renderChain;
    const stick = this.opts.isAtBottom ? this.opts.isAtBottom() : true;
    this.container.empty();
    this.built = true;
    this.tailEl = null;
    this.tailTextNode = null;
    await MarkdownRenderer.render(this.app, md, this.container, this.sourcePath, this.component);
    this.opts.onGrow(stick);
  }
}
