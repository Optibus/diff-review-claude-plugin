import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function gitWithStdin(args: string[], stdin: string, cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (b: Buffer) => {
      stdout += b.toString();
    });
    child.stderr.on("data", (b: Buffer) => {
      stderr += b.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new GitError(`git ${args[0]} exited ${code}`, stderr));
    });
    child.stdin.end(stdin);
  });
}

export class GitError extends Error {
  constructor(
    message: string,
    public stderr?: string,
  ) {
    super(message);
    this.name = "GitError";
  }
}

async function git(args: string[], cwd: string, maxBuffer = 64 * 1024 * 1024): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd, maxBuffer });
    return stdout;
  } catch (e: unknown) {
    const err = e as { stderr?: string; message?: string };
    throw new GitError(err.message ?? "git failed", err.stderr);
  }
}

export async function isGitRepo(cwd: string): Promise<boolean> {
  try {
    await git(["rev-parse", "--is-inside-work-tree"], cwd);
    return true;
  } catch {
    return false;
  }
}

export async function repoRoot(cwd: string): Promise<string> {
  return (await git(["rev-parse", "--show-toplevel"], cwd)).trim();
}

export async function gitDir(cwd: string): Promise<string> {
  return (await git(["rev-parse", "--absolute-git-dir"], cwd)).trim();
}

export async function currentBranch(cwd: string): Promise<string> {
  return (await git(["rev-parse", "--abbrev-ref", "HEAD"], cwd)).trim();
}

/**
 * Detect the default base branch. Tries origin/HEAD, then common names.
 * Returns ref name like "origin/main" or "main". Throws if nothing usable.
 */
export async function defaultBaseBranch(cwd: string): Promise<string> {
  try {
    const out = (await git(["rev-parse", "--abbrev-ref", "origin/HEAD"], cwd)).trim();
    if (out && out !== "HEAD") return out;
  } catch {
    // fall through
  }
  const candidates = ["origin/main", "origin/master", "main", "master"];
  for (const c of candidates) {
    try {
      await git(["rev-parse", "--verify", c], cwd);
      return c;
    } catch {
      // try next
    }
  }
  throw new GitError("Could not determine default base branch (no main/master found).");
}

/**
 * Resolve the merge-base of two refs. Falls back to throwing GitError when
 * the two refs have no common ancestor (unrelated histories).
 */
export async function mergeBase(refA: string, refB: string, cwd: string): Promise<string> {
  const out = await git(["merge-base", refA, refB], cwd);
  return out.trim();
}

export interface Commit {
  sha: string;
  shortSha: string;
  subject: string;
  authorName: string;
  authorDate: string;
}

export async function commitsBetween(base: string, head: string, cwd: string): Promise<Commit[]> {
  const fmt = "%H%x1f%h%x1f%s%x1f%an%x1f%aI";
  const out = await git(["log", `--pretty=format:${fmt}`, `${base}..${head}`], cwd);
  if (!out.trim()) return [];
  return out
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [sha, shortSha, subject, authorName, authorDate] = line.split("\x1f");
      return { sha, shortSha, subject, authorName, authorDate };
    });
}

export interface DiffOptions {
  range?: string; // e.g. "main..HEAD" or "main...HEAD"
  /** Layer uncommitted (staged + unstaged) changes on top of the committed range. */
  includeUncommitted?: boolean;
  /** Just `git diff HEAD` — everything not yet committed, staged or not. */
  uncommittedOnly?: boolean;
  commit?: string; // single commit -> show that commit's diff
}

/**
 * Return raw `git diff` output for the given source. Browser-side parser handles structure.
 *
 * Note: "uncommitted" means working-tree changes vs HEAD — this naturally
 * includes both staged and unstaged work (`git diff HEAD` walks the whole
 * working tree, ignoring the index state). For sources that include
 * uncommitted work, untracked-but-not-gitignored files are also appended
 * as synthetic new-file diffs so the user can review additions that
 * haven't been `git add`-ed yet.
 */
export async function getDiff(opts: DiffOptions, cwd: string): Promise<string> {
  const common = ["--no-color", "--find-renames", "--no-ext-diff"];
  if (opts.commit) {
    // `git diff <sha>^!` is shorthand for `git diff <sha>^ <sha>`.
    return git(["diff", ...common, `${opts.commit}^!`], cwd);
  }
  if (opts.uncommittedOnly) {
    const main = await git(["diff", ...common, "HEAD"], cwd);
    return main + (await untrackedDiff(cwd));
  }
  if (opts.range) {
    if (opts.includeUncommitted) {
      // `git diff <base>` compares the working tree (staged + unstaged) to the
      // base commit, naturally producing the committed range plus any local
      // uncommitted work.
      const base = opts.range.split(/\.\.\.?/)[0];
      const main = await git(["diff", ...common, base], cwd);
      return main + (await untrackedDiff(cwd));
    }
    return git(["diff", ...common, opts.range], cwd);
  }
  throw new GitError("getDiff: must provide range, commit, or uncommittedOnly");
}

/**
 * List untracked files (respecting .gitignore) as NUL-separated paths.
 */
async function listUntracked(cwd: string): Promise<string[]> {
  const out = await git(["ls-files", "--others", "--exclude-standard", "-z"], cwd);
  return out.split("\0").filter(Boolean);
}

/**
 * Produce a unified diff for each untracked file, concatenated. Each block
 * looks like a normal `git diff` "new file" entry so the client-side parser
 * can consume it without special-casing.
 *
 * `git diff --no-index` exits 1 when there's a difference (which is always,
 * since we compare /dev/null vs a real file). We therefore run it in a way
 * that tolerates exit 1.
 */
async function untrackedDiff(cwd: string): Promise<string> {
  const paths = await listUntracked(cwd);
  if (paths.length === 0) return "";
  const parts: string[] = [];
  for (const p of paths) {
    const out = await diffAgainstDevNull(p, cwd);
    if (out) {
      // `git diff --no-index` emits `a//dev/null` and `b/<path>` headers; we
      // rewrite the b-side path to drop the worktree-relative prefix `b/`
      // already present and leave the rest untouched. Nothing to rewrite —
      // the headers are already in the right form.
      parts.push(out);
    }
  }
  return parts.join("");
}

async function diffAgainstDevNull(path: string, cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = [
      "diff",
      "--no-color",
      "--no-ext-diff",
      "--binary",
      "--no-index",
      "--",
      "/dev/null",
      path,
    ];
    const child = spawn("git", args, { cwd });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (b: Buffer) => {
      stdout += b.toString();
    });
    child.stderr.on("data", (b: Buffer) => {
      stderr += b.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      // 0 = no diff (shouldn't happen here); 1 = diff produced (expected).
      if (code === 0 || code === 1) resolve(stdout);
      else reject(new GitError(`git diff --no-index exited ${code}`, stderr));
    });
  });
}

/**
 * Read a file's contents at a given git ref. Returns null if the path doesn't
 * exist at that ref (e.g., newly-added or deleted files).
 */
export async function readFileAtRef(
  ref: string,
  path: string,
  cwd: string,
): Promise<string | null> {
  try {
    return await git(["show", `${ref}:${path}`], cwd);
  } catch {
    return null;
  }
}

/**
 * Look up gitattributes for one or more paths. Returns `{ path: { attr: value } }`.
 * `value` is `"set"`, `"unset"`, `"unspecified"`, or the literal string value
 * the user set (e.g. `linguist-generated=true` → `"true"`).
 *
 * Uses a single `git check-attr --stdin` invocation so the cost is one git
 * process regardless of how many paths we look up.
 */
export async function getAttributes(
  paths: string[],
  attrs: string[],
  cwd: string,
): Promise<Record<string, Record<string, string>>> {
  const result: Record<string, Record<string, string>> = {};
  if (paths.length === 0 || attrs.length === 0) return result;
  const stdout = await gitWithStdin(
    ["check-attr", "--stdin", "-z", ...attrs],
    `${paths.join("\0")}\0`,
    cwd,
  );
  // -z format: <path>\0<attr>\0<value>\0  (one triple per record)
  const tokens = stdout.split("\0");
  for (let i = 0; i + 2 < tokens.length; i += 3) {
    const [path, attr, value] = [tokens[i], tokens[i + 1], tokens[i + 2]];
    if (!path) continue;
    if (!result[path]) result[path] = {};
    result[path][attr] = value;
  }
  return result;
}

/**
 * List files changed in a given diff. Used to validate draft anchors.
 */
export async function changedFiles(opts: DiffOptions, cwd: string): Promise<string[]> {
  const common = ["--name-only", "--no-color"];
  let args: string[];
  let includeUntracked = false;
  if (opts.commit) {
    args = ["diff", ...common, `${opts.commit}^!`];
  } else if (opts.uncommittedOnly) {
    args = ["diff", ...common, "HEAD"];
    includeUntracked = true;
  } else if (opts.range) {
    if (opts.includeUncommitted) {
      const base = opts.range.split(/\.\.\.?/)[0];
      args = ["diff", ...common, base];
      includeUntracked = true;
    } else {
      args = ["diff", ...common, opts.range];
    }
  } else {
    return [];
  }
  const out = await git(args, cwd);
  const tracked = out.split("\n").filter(Boolean);
  if (!includeUntracked) return tracked;
  const untracked = await listUntracked(cwd);
  // Preserve order: tracked first, then untracked. Dedupe just in case.
  return Array.from(new Set([...tracked, ...untracked]));
}
