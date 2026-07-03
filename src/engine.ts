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
 *    and NO mode is granted Bash/WebFetch/WebSearch/Task. `bypassPermissions` is never used.
 */

/** Read-only tool set: inspect the vault, never mutate it, never touch shell or network. */
const READ_ONLY_TOOLS = ["Read", "Grep", "Glob", "LS", "TodoWrite"];
/** Edit mode adds file writes — still no Bash/WebFetch/WebSearch/Task. */
const EDIT_TOOLS = [...READ_ONLY_TOOLS, "Write", "Edit", "MultiEdit"];

export interface EngineCallbacks {
  onText: (delta: string) => void;
  onToolUse?: (name: string, input: unknown) => void;
  onDone: (info: { sessionId: string | null; text: string; error?: string }) => void;
}

export interface RunOpts {
  cwd: string;
  sessionId?: string | null;
  systemPrompt?: string;
  /** chat/quiz = true (no Write/Edit). edit/save = false (writes allowed under bypass). */
  readOnly: boolean;
  /** Pin the model for this spawn — e.g. "claude-opus-4-8" for the analysis tier,
   *  "claude-sonnet-4-6" for routine work, "claude-haiku-4-5" for classify/route/distill.
   *  Omit to use the CLI/subscription default. See (Pro-Plan Runtime Profile). */
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

  /** True while a turn is in flight. */
  get busy(): boolean {
    return this.child !== null;
  }

  run(prompt: string, opts: RunOpts, cb: EngineCallbacks): void {
    const { cmd, shell } = resolveClaude();

    const env = { ...process.env };
    // Use the CLI's interactive login rather than an API key picked up from the
    // environment, so usage stays on the account the CLI is signed in to.
    delete env.ANTHROPIC_API_KEY;

    // The prompt is delivered over stdin (below), never as an argv entry, so it can
    // never be parsed by a shell. Remaining args are fixed flags plus a model id and a
    // session UUID — no free-form user/web content ever reaches the command line.
    const args = [
      "-p",
      "--output-format",
      "stream-json",
      "--include-partial-messages",
      "--verbose",
      "--allowedTools",
      ...(opts.readOnly ? READ_ONLY_TOOLS : EDIT_TOOLS),
    ];
    if (opts.model) {
      // Per-spawn model tiering. `--model` is a supported claude CLI flag.
      args.push("--model", opts.model);
    }
    if (opts.sessionId) {
      args.push("--resume", opts.sessionId);
    } else if (opts.systemPrompt) {
      args.push("--append-system-prompt", opts.systemPrompt);
    }

    let child: ChildProcess;
    try {
      child = spawn(cmd, args, { cwd: opts.cwd, env, shell, stdio: ["pipe", "pipe", "pipe"] });
    } catch (e) {
      cb.onDone({ sessionId: opts.sessionId ?? null, text: "", error: String(e) });
      return;
    }
    this.child = child;

    // Hand the prompt to the CLI over stdin, then close it so the turn can begin.
    try {
      child.stdin?.setDefaultEncoding("utf8");
      child.stdin?.write(prompt);
      child.stdin?.end();
    } catch {
      /* if stdin is already gone the close handler will surface the error */
    }

    let sessionId: string | null = opts.sessionId ?? null;
    let finalText = "";
    let resultError: string | undefined;
    let stderr = "";
    let buf = "";
    let done = false;

    const finish = (info: { text: string; error?: string }) => {
      if (done) return;
      done = true;
      this.child = null;
      cb.onDone({ sessionId, text: info.text, error: info.error });
    };

    const processLine = (raw: string) => {
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
          : err.message;
      finish({ text: finalText, error: msg });
    });

    child.on("close", (code) => {
      if (buf.trim()) processLine(buf); // flush a trailing line with no newline (often `result`)
      buf = "";
      if (resultError) {
        finish({ text: finalText, error: resultError });
      } else if (code !== 0 && !finalText) {
        finish({ text: "", error: stderr.trim() || `claude exited with code ${code}` });
      } else {
        finish({ text: finalText });
      }
    });
  }

  /** Kill the in-flight turn. On Windows, kill the whole process tree (shell + grandchild). */
  cancel(): void {
    const c = this.child;
    if (!c) return;
    this.child = null;
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
