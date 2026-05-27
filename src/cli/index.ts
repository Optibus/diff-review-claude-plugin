import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import { EMBEDDED_HTML } from "./embedded.js";
import * as git from "./git.js";
import {
  acquireLock,
  LockError,
  openBrowser,
  readInstance,
  releaseLock,
  writeInstance,
} from "./lifecycle.js";
import { formatReview } from "./output.js";
import { createServer } from "./server.js";
import { clearDrafts, loadDrafts, repoFingerprint } from "./storage.js";
import type { SubmissionResult } from "./types.js";

interface ParsedArgs {
  cwd: string;
  noBrowser: boolean;
  /** Test mode: auto-submit current drafts immediately (no UI). */
  autoSubmit: boolean;
  /** Override port for testing. */
  port: number;
  /** Print help and exit. */
  help: boolean;
  /** Diff source preselection (free-form, parsed by web UI). */
  preselect: string;
}

function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = {
    cwd: process.cwd(),
    noBrowser: false,
    autoSubmit: false,
    port: 0,
    help: false,
    preselect: "",
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--no-browser") args.noBrowser = true;
    else if (a === "--auto-submit") args.autoSubmit = true;
    else if (a === "--help" || a === "-h") args.help = true;
    else if (a === "--port") args.port = parseInt(argv[++i] ?? "0", 10);
    else if (a === "--cwd") args.cwd = argv[++i] ?? args.cwd;
    else if (a.startsWith("--port=")) args.port = parseInt(a.slice(7), 10);
    else if (a.startsWith("--cwd=")) args.cwd = a.slice(6);
    else if (!a.startsWith("--")) args.preselect = a;
  }
  return args;
}

function printHelp() {
  process.stderr.write(`diff-review — open a GitHub-style diff GUI in the browser.

USAGE
  diff-review [diff-source]

OPTIONS
  --cwd <path>     Run against this directory (default: $PWD)
  --no-browser     Don't auto-open the browser; print the URL instead
  --auto-submit    Submit immediately with current drafts and exit (test mode)
  --port <n>       Bind to a specific port (default: random free port)
  -h, --help       Show this help

DIFF-SOURCE (optional positional)
  Free-form pre-selection of the diff source in the UI. Currently informational.

The tool blocks until you click "Submit review" or "Discard" in the browser.
On submit, the structured review is written to stdout as Markdown.
On cancel or empty review, exits non-zero with a message on stderr.
`);
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return 0;
  }

  // Verify cwd exists and is a git repo
  try {
    await fs.access(args.cwd);
  } catch {
    process.stderr.write(`diff-review: directory not found: ${args.cwd}\n`);
    return 2;
  }
  if (!(await git.isGitRepo(args.cwd))) {
    process.stderr.write(`diff-review: not a git working tree: ${args.cwd}\n`);
    return 2;
  }

  const absGitDir = await git.gitDir(args.cwd);
  const fingerprint = repoFingerprint(absGitDir);

  try {
    await acquireLock(fingerprint);
  } catch (e) {
    if (e instanceof LockError) {
      // Another instance is alive. Treat this as a "reconnect" rather than a
      // hard error: open the user's browser at the existing instance's URL so
      // they pick up where they left off.
      const existing = await readInstance(fingerprint);
      if (existing) {
        const url = `http://127.0.0.1:${existing.port}/?t=${existing.token}`;
        process.stderr.write(
          `diff-review: another review is already running (PID ${existing.pid}). Reopening at ${url}\n`,
        );
        if (!args.noBrowser) openBrowser(url);
        process.stdout.write(`(reconnected — review still open in your browser)\n`);
        return 0;
      }
      // Lock is held but we have no instance.json — typically because the
      // running process is an older version that didn't write one. Give the
      // user something they can act on.
      process.stderr.write(
        `diff-review: another diff-review is running (PID ${e.pid ?? "?"}) but I can't recover its URL` +
          ` — likely an older version of the plugin. Either submit/discard it from its open browser tab,` +
          ` or free the lock with: kill ${e.pid ?? "<pid>"}\n`,
      );
      return 1;
    }
    throw e;
  }

  const token = randomBytes(32).toString("hex");

  let submissionResolver: ((r: SubmissionResult) => void) | null = null;
  const submission = new Promise<SubmissionResult>((resolve) => {
    submissionResolver = resolve;
  });

  const server = await createServer({
    cwd: args.cwd,
    fingerprint,
    html: EMBEDDED_HTML,
    token,
    port: args.port || undefined,
    onResolve: (r) => submissionResolver?.(r),
  });

  await writeInstance(fingerprint, {
    pid: process.pid,
    port: server.port,
    token,
  });

  const sigintHandler = () => {
    submissionResolver?.({ cancelled: true });
  };
  process.on("SIGINT", sigintHandler);
  process.on("SIGTERM", sigintHandler);

  if (!args.autoSubmit) {
    process.stderr.write(`diff-review: open ${server.url}\n`);
    if (!args.noBrowser) openBrowser(server.url);
  }

  let result: SubmissionResult;
  try {
    if (args.autoSubmit) {
      const store = await loadDrafts(fingerprint);
      result = { cancelled: false, store };
    } else {
      result = await submission;
    }
  } finally {
    await server.close();
    process.off("SIGINT", sigintHandler);
    process.off("SIGTERM", sigintHandler);
    await releaseLock(fingerprint);
  }

  // Cancel and empty-review are normal no-op outcomes, not errors. Emit the
  // sentinel on stdout and exit 0 (like the reconnect path) so the slash
  // command's `!`-substitution succeeds and Claude reads the marker as the
  // review output, rather than reporting a failed shell command.
  if (result.cancelled) {
    process.stdout.write(`(review cancelled)\n`);
    return 0;
  }

  const store = result.store ?? (await loadDrafts(fingerprint));
  const md = formatReview(store);
  if (!md) {
    process.stdout.write(`(empty review)\n`);
    return 0;
  }
  process.stdout.write(md);
  if (!md.endsWith("\n")) process.stdout.write("\n");
  // Clear drafts only after a successful submit
  await clearDrafts(fingerprint);
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((e: Error) => {
    process.stderr.write(`diff-review: ${e.message ?? e}\n`);
    process.exit(1);
  });
