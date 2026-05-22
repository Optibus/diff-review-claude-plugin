import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export class GitError extends Error {
  constructor(message: string, public stderr?: string) {
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
  range?: string;             // e.g. "main..HEAD" or "main...HEAD"
  /** Layer uncommitted (staged + unstaged) changes on top of the committed range. */
  includeUncommitted?: boolean;
  /** Just `git diff HEAD` — everything not yet committed, staged or not. */
  uncommittedOnly?: boolean;
  commit?: string;            // single commit -> show that commit's diff
}

/**
 * Return raw `git diff` output for the given source. Browser-side parser handles structure.
 *
 * Note: "uncommitted" means working-tree changes vs HEAD — this naturally
 * includes both staged and unstaged work (`git diff HEAD` walks the whole
 * working tree, ignoring the index state).
 */
export async function getDiff(opts: DiffOptions, cwd: string): Promise<string> {
  const common = ["--no-color", "--find-renames", "--no-ext-diff"];
  if (opts.commit) {
    // `git diff <sha>^!` is shorthand for `git diff <sha>^ <sha>`.
    return git(["diff", ...common, `${opts.commit}^!`], cwd);
  }
  if (opts.uncommittedOnly) {
    return git(["diff", ...common, "HEAD"], cwd);
  }
  if (opts.range) {
    if (opts.includeUncommitted) {
      // `git diff <base>` compares the working tree (staged + unstaged) to the
      // base commit, naturally producing the committed range plus any local
      // uncommitted work.
      const base = opts.range.split(/\.\.\.?/)[0];
      return git(["diff", ...common, base], cwd);
    }
    return git(["diff", ...common, opts.range], cwd);
  }
  throw new GitError("getDiff: must provide range, commit, or uncommittedOnly");
}

/**
 * Read a file's contents at a given git ref. Returns null if the path doesn't
 * exist at that ref (e.g., newly-added or deleted files).
 */
export async function readFileAtRef(ref: string, path: string, cwd: string): Promise<string | null> {
  try {
    return await git(["show", `${ref}:${path}`], cwd);
  } catch {
    return null;
  }
}

/**
 * List files changed in a given diff. Used to validate draft anchors.
 */
export async function changedFiles(opts: DiffOptions, cwd: string): Promise<string[]> {
  const common = ["--name-only", "--no-color"];
  let args: string[];
  if (opts.commit) {
    args = ["diff", ...common, `${opts.commit}^!`];
  } else if (opts.uncommittedOnly) {
    args = ["diff", ...common, "HEAD"];
  } else if (opts.range) {
    if (opts.includeUncommitted) {
      const base = opts.range.split(/\.\.\.?/)[0];
      args = ["diff", ...common, base];
    } else {
      args = ["diff", ...common, opts.range];
    }
  } else {
    return [];
  }
  const out = await git(args, cwd);
  return out.split("\n").filter(Boolean);
}
