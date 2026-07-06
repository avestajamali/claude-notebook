import { spawn, ChildProcess } from "child_process";
import * as fs from "fs";
import * as path from "path";

/**
 * The engine boundary: wraps the Claude Code CLI (`claude -p`, stream-json). The CLI
 * runs as a subprocess and uses whatever authentication it is already configured with.
 * An SDK/background engine can be slotted in behind this same interface later.
 *
 * Security model (see README):
 *  - The prompt is passed to the CLI over STDIN, never on the command line, so chat
 *    content can never be interpreted by a shell.
 *  - Tools are gated by an explicit ALLOWLIST per mode — read-only modes cannot write,
 *    and NO mode is granted Bash/WebFetch/WebSearch/Task. The CLI's fully-permissive
 *    "bypass" permission mode is never used.
 *  - The permission mode is pinned per call: read-only turns run in `default`; edit turns
 *    run in `acceptEdits` so the allowlisted Write/Edit execute unprompted in headless mode.
 *  - Edit turns pass `writeRoot` (the vault root): the write grant is emitted path-scoped
 *    to that tree, so a prompt-injected turn can't write outside the vault — a write no
 *    rule matches is simply denied in headless mode.
 */

/** Read-only tool set: inspect the vault, never mutate it, never touch shell or network. */
const READ_ONLY_TOOLS = ["Read", "Grep", "Glob", "LS", "TodoWrite"];
/** The file-writing tools edit mode adds — still no Bash/WebFetch/WebSearch/Task. */
const WRITE_TOOLS = ["Write", "Edit", "MultiEdit"];
/** Unscoped edit set — the fallback when no usable writeRoot is available. */
const EDIT_TOOLS = [...READ_ONLY_TOOLS, ...WRITE_TOOLS];

/**
 * An absolute OS path as a permission-rule path specifier: `//`-anchored, POSIX slashes,
 * Windows drive letter lowercased, `/**` appended so the rule covers the whole tree —
 * `C:\Vault` → `//c/Vault/**` (docs: code.claude.com/docs/en/permissions, "Read and Edit";
 * behaviour verified against Claude Code 2.1.199). Returns null for a non-absolute path:
 * a relative pattern would anchor at the cwd and could scope the grant to the wrong tree,
 * so the caller falls back to the unscoped tools instead.
 */
function scopeSpecifier(root: string): string | null {
  let p = root.replace(/\\/g, "/").replace(/\/+$/, "");
  const drive = /^([A-Za-z]):($|\/)/.exec(p);
  if (drive) p = `/${drive[1].toLowerCase()}${p.slice(2)}`;
  if (!p.startsWith("/") || p === "/") return null;
  return `/${p}/**`;
}

/** Hard cap on one turn — breaks a wedged child that never emits `close` so `busy` can't stick. */
const TURN_TIMEOUT_MS = 20 * 60 * 1000;

/** Turn an opaque CLI failure into something a first-run user can act on. */
function friendlyError(raw: string): string {
  const s = (raw || "").trim();
  if (/invalid api key|authenticat|unauthorized|not logged in|please run .*login|oauth|\b401\b/i.test(s)) {
    return "Claude CLI isn't signed in — run `claude` in a terminal, log in, then try again.";
  }
  return s || "Claude exited unexpectedly.";
}

export interface EngineCallbacks {
  onText: (delta: string) => void;
  onToolUse?: (name: string, input: unknown) => void;
  onDone: (info: { sessionId: string | null; text: string; error?: string }) => void;
}

export interface RunOpts {
  cwd: string;
  sessionId?: string | null;
  systemPrompt?: string;
  /** chat/quiz = true (read-only tools only). edit/save = false (Write/Edit granted, acceptEdits mode). */
  readOnly: boolean;
  /** Absolute OS path writes are confined to on edit turns (normally the vault root). When set,
   *  the write grant is emitted as path-scoped rules (`Edit(//c/vault/**)`) instead of bare tool
   *  names, so the turn can't write outside it. Ignored on readOnly turns; unset, non-absolute,
   *  or on the .cmd-shim spawn path it falls back to today's bare write tools. */
  writeRoot?: string;
  /** Pin the model for this spawn — e.g. "claude-opus-4-8" for analysis, "claude-haiku-4-5"
   *  for cheap classify/route. Omit to use the CLI/subscription default. */
  model?: string;
}

interface ClaudeBin {
  cmd: string;
  shell: boolean;
}

function resolveClaude(): ClaudeBin {
  const home = process.env.USERPROFILE || process.env.HOME || "";
  const appdata = process.env.APPDATA || "";
  const exe = [
    path.join(home, ".local", "bin", "claude.exe"),
    path.join(home, ".local", "bin", "claude"),
  ];
  for (const c of exe) {
    try {
      if (c && fs.existsSync(c)) return { cmd: c, shell: false };
    } catch {
      /* ignore */
    }
  }
  // .cmd / .bat shims require a shell on Windows.
  const cmdShim = path.join(appdata, "npm", "claude.cmd");
  try {
    if (fs.existsSync(cmdShim)) return { cmd: cmdShim, shell: true };
  } catch {
    /* ignore */
  }
  return { cmd: "claude", shell: true };
}

export class ClaudeEngine {
  private child: ChildProcess | null = null;
  /** Bumped on every run() and on cancel(); lets a late-finishing turn detect it was superseded. */
  private runToken = 0;

  /** True while a turn is in flight. */
  get busy(): boolean {
    return this.child !== null;
  }

  run(prompt: string, opts: RunOpts, cb: EngineCallbacks): void {
    const myToken = ++this.runToken;
    const { cmd, shell } = resolveClaude();

    const env = { ...process.env };
    // Use the CLI's interactive login rather than an env-borne credential/endpoint, so
    // every turn stays on the account the CLI is signed in to. Scrub the whole family:
    // API_KEY and AUTH_TOKEN both override the login; BASE_URL and the Bedrock/Vertex
    // switches would silently redirect turns (with full note bodies) to another endpoint.
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;
    delete env.ANTHROPIC_BASE_URL;
    delete env.CLAUDE_CODE_USE_BEDROCK;
    delete env.CLAUDE_CODE_USE_VERTEX;

    // Scope the write grant to writeRoot. A BARE allow rule matches every path, so it would
    // bypass acceptEdits' working-directory scoping and let an edit turn write outside the
    // vault; scoped, an out-of-root write matches no rule and headless mode denies it, while
    // in-root writes are covered by both the rule and acceptEdits itself. The `Edit(...)`
    // rule family gates ALL file-writing tools — on CLI 2.1.199 a scoped `Write(...)` rule
    // is inert (verified), but it rides along for CLI versions that honor it: scoped rules
    // can only ever be narrower than bare grants. On the .cmd-shim path (shell:true) cmd.exe
    // receives argv space-joined and unquoted, so a specifier containing spaces (vault paths
    // often do) would shatter into garbage rules — keep the bare tools there (known gap; that
    // path is only taken when claude.exe itself is missing).
    const writeScope =
      !opts.readOnly && !shell && opts.writeRoot ? scopeSpecifier(opts.writeRoot) : null;
    const allowedTools = opts.readOnly
      ? READ_ONLY_TOOLS
      : writeScope
        ? [...READ_ONLY_TOOLS, ...WRITE_TOOLS.map((t) => `${t}(${writeScope})`)]
        : EDIT_TOOLS;

    // The prompt is delivered over stdin (below), never as an argv entry, so it can never
    // be parsed by a shell. The permission mode is explicit so edit-mode writes don't ride
    // on the CLI's implicit default.
    const args = [
      "-p",
      "--output-format",
      "stream-json",
      "--include-partial-messages",
      "--verbose",
      "--permission-mode",
      opts.readOnly ? "default" : "acceptEdits",
      "--allowedTools",
      ...allowedTools,
    ];
    if (opts.model) {
      args.push("--model", opts.model);
    }
    if (opts.sessionId) {
      args.push("--resume", opts.sessionId);
    } else if (opts.systemPrompt) {
      // The system prompt is the only free-form argv value. On the shell:true (.cmd shim)
      // fallback the whole command line is handed to cmd.exe unquoted, so strip the
      // characters that let cmd.exe expand or chain: `%VAR%` expansion, and the
      // &, |, <, >, ^ metacharacters (a note path may legally contain them). The
      // .exe path (shell:false) passes argv discretely and needs no stripping.
      const sp = shell ? opts.systemPrompt.replace(/[%&|<>^]/g, "") : opts.systemPrompt;
      args.push("--append-system-prompt", sp);
    }

    let child: ChildProcess;
    try {
      child = spawn(cmd, args, { cwd: opts.cwd, env, shell, stdio: ["pipe", "pipe", "pipe"] });
    } catch (e) {
      if (this.runToken === myToken) {
        cb.onDone({ sessionId: opts.sessionId ?? null, text: "", error: friendlyError(String(e)) });
      }
      return;
    }
    this.child = child;

    let sessionId: string | null = opts.sessionId ?? null;
    let finalText = "";
    let resultError: string | undefined;
    let stderr = "";
    let buf = "";
    let done = false;
    let watchdog: ReturnType<typeof setTimeout> | null = null;

    /** This turn has been cancelled or replaced by a newer one. */
    const superseded = () => this.runToken !== myToken;

    const finish = (info: { text: string; error?: string }) => {
      if (done) return;
      done = true;
      if (watchdog) {
        clearTimeout(watchdog);
        watchdog = null;
      }
      // Only relinquish `busy` if we still own it — never null a newer turn's child.
      if (this.child === child) this.child = null;
      // A cancelled/superseded turn must not push output or completion into the UI.
      if (superseded()) return;
      cb.onDone({ sessionId, text: info.text, error: info.error });
    };

    // An async EPIPE (CLI dies before reading the prompt, or a huge prompt) must not throw.
    child.stdin?.on("error", () => {});
    try {
      child.stdin?.setDefaultEncoding("utf8");
      child.stdin?.write(prompt);
      child.stdin?.end();
    } catch {
      /* the close/error handler will surface it */
    }

    const processLine = (raw: string) => {
      // `done` guards the window between finish() (watchdog/error paths, which don't bump
      // runToken) and the child actually dying: late stdout must not push into a turn the
      // view has already completed (invariant 6).
      if (done || superseded()) return;
      const line = raw.trim();
      if (!line) return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let evt: any;
      try {
        evt = JSON.parse(line);
      } catch {
        return;
      }
      if (evt.session_id) sessionId = evt.session_id;

      if (evt.type === "stream_event" && evt.event) {
        const e = evt.event;
        if (
          e.type === "content_block_delta" &&
          e.delta?.type === "text_delta" &&
          typeof e.delta.text === "string"
        ) {
          finalText += e.delta.text;
          cb.onText(e.delta.text);
        } else if (e.type === "content_block_start" && e.content_block?.type === "tool_use") {
          cb.onToolUse?.(e.content_block.name, e.content_block.input);
        }
      } else if (evt.type === "result") {
        if (!finalText && typeof evt.result === "string") finalText = evt.result;
        if (evt.is_error) resultError = typeof evt.result === "string" ? evt.result : "error";
      }
    };

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        processLine(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
      }
    });

    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (c: string) => {
      stderr += c;
    });

    child.on("error", (err) => {
      const code = (err as NodeJS.ErrnoException).code;
      const msg =
        code === "ENOENT"
          ? "Claude CLI not found — check it's installed and on your PATH."
          : friendlyError(err.message);
      finish({ text: finalText, error: msg });
    });

    child.on("close", (code) => {
      if (buf.trim()) processLine(buf); // flush a trailing line with no newline (often `result`)
      buf = "";
      if (resultError) {
        finish({ text: finalText, error: friendlyError(resultError) });
      } else if (code !== 0) {
        // Surface the failure even if some partial text streamed — don't hide a crash.
        finish({ text: finalText, error: friendlyError(stderr.trim() || `claude exited with code ${code}`) });
      } else {
        finish({ text: finalText });
      }
    });

    watchdog = setTimeout(() => {
      this.killTree(child);
      finish({ text: finalText, error: "Claude timed out — check the CLI is installed and signed in." });
    }, TURN_TIMEOUT_MS);
  }

  /** Kill the in-flight turn and invalidate its callbacks so a fast re-send can't collide with it. */
  cancel(): void {
    this.runToken++;
    const c = this.child;
    this.child = null;
    if (c) this.killTree(c);
  }

  /** On Windows, kill the whole process tree (shell + grandchild); elsewhere a plain kill. */
  private killTree(c: ChildProcess): void {
    try {
      if (process.platform === "win32" && typeof c.pid === "number") {
        spawn("taskkill", ["/pid", String(c.pid), "/T", "/F"]);
      } else {
        c.kill();
      }
    } catch {
      /* best effort */
    }
  }
}
