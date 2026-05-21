import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import * as git from "./git.js";
import { acquireLock, openBrowser, releaseLock, LockError } from "./lifecycle.js";
import { createServer } from "./server.js";
import { clearDrafts, loadDrafts, repoFingerprint } from "./storage.js";
import { formatReview } from "./output.js";
import { EMBEDDED_HTML } from "./embedded.js";
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
      process.stderr.write(`diff-review: ${e.message}\n`);
      return 1;
    }
    throw e;
  }

  const token = randomBytes(32).toString("hex");

  let submissionResolver: ((r: SubmissionResult) => void) | null = null;
  const submission = new Promise<SubmissionResult>((resolve) => { submissionResolver = resolve; });

  const server = await createServer({
    cwd: args.cwd,
    fingerprint,
    html: EMBEDDED_HTML,
    token,
    port: args.port || undefined,
    onResolve: (r) => submissionResolver?.(r),
  });

  const sigintHandler = () => { submissionResolver?.({ cancelled: true }); };
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

  if (result.cancelled) {
    process.stderr.write(`(review cancelled)\n`);
    return 1;
  }

  const store = result.store ?? (await loadDrafts(fingerprint));
  const md = formatReview(store);
  if (!md) {
    process.stderr.write(`(empty review)\n`);
    return 1;
  }
  process.stdout.write(md);
  if (!md.endsWith("\n")) process.stdout.write("\n");
  // Clear drafts only after a successful submit
  await clearDrafts(fingerprint);
  return 0;
}

main().then((code) => process.exit(code)).catch((e: Error) => {
  process.stderr.write(`diff-review: ${e.message ?? e}\n`);
  process.exit(1);
});
