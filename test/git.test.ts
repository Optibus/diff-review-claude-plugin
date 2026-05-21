import { strict as assert } from "node:assert";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { promisify } from "node:util";
import path from "node:path";
import {
  changedFiles,
  commitsBetween,
  currentBranch,
  defaultBaseBranch,
  getDiff,
  isGitRepo,
  repoRoot,
  gitDir,
} from "../src/cli/git.js";

const exec = promisify(execFile);

async function makeFixtureRepo(): Promise<string> {
  const dir = await fs.mkdtemp("/tmp/diff-review-fix-");
  const g = (...args: string[]) => exec("git", args, { cwd: dir });
  await g("init", "-q", "-b", "main");
  await g("config", "user.email", "test@test");
  await g("config", "user.name", "Test");
  await fs.writeFile(path.join(dir, "a.txt"), "line1\nline2\nline3\n");
  await g("add", ".");
  await g("commit", "-q", "-m", "first");
  // second commit on main
  await fs.writeFile(path.join(dir, "b.txt"), "hello\n");
  await g("add", ".");
  await g("commit", "-q", "-m", "second");
  // branch off
  await g("checkout", "-q", "-b", "feature");
  await fs.writeFile(path.join(dir, "a.txt"), "line1\nLINE2\nline3\nline4\n");
  await g("add", ".");
  await g("commit", "-q", "-m", "feature change 1");
  await fs.writeFile(path.join(dir, "c.txt"), "new file\n");
  await g("add", ".");
  await g("commit", "-q", "-m", "feature change 2");
  // unstaged change
  await fs.writeFile(path.join(dir, "a.txt"), "line1\nLINE2\nline3\nline4\nline5\n");
  return dir;
}

test("isGitRepo true inside repo, false outside", async () => {
  const dir = await makeFixtureRepo();
  assert.equal(await isGitRepo(dir), true);
  assert.equal(await isGitRepo("/tmp"), false);
  await fs.rm(dir, { recursive: true, force: true });
});

test("repoRoot and gitDir resolve correctly", async () => {
  const dir = await makeFixtureRepo();
  const realDir = await fs.realpath(dir);
  assert.equal(await repoRoot(dir), realDir);
  const gd = await gitDir(dir);
  assert.equal(gd, path.join(realDir, ".git"));
  await fs.rm(dir, { recursive: true, force: true });
});

test("currentBranch returns branch name", async () => {
  const dir = await makeFixtureRepo();
  assert.equal(await currentBranch(dir), "feature");
  await fs.rm(dir, { recursive: true, force: true });
});

test("defaultBaseBranch falls back to main when no remote", async () => {
  const dir = await makeFixtureRepo();
  assert.equal(await defaultBaseBranch(dir), "main");
  await fs.rm(dir, { recursive: true, force: true });
});

test("commitsBetween lists commits in range", async () => {
  const dir = await makeFixtureRepo();
  const commits = await commitsBetween("main", "feature", dir);
  assert.equal(commits.length, 2);
  // git log returns newest first
  assert.equal(commits[0].subject, "feature change 2");
  assert.equal(commits[1].subject, "feature change 1");
  assert.ok(commits[0].sha.length === 40);
  assert.ok(commits[0].shortSha.length >= 7);
  await fs.rm(dir, { recursive: true, force: true });
});

test("getDiff range returns committed diff (no unstaged)", async () => {
  const dir = await makeFixtureRepo();
  const out = await getDiff({ range: "main..feature" }, dir);
  assert.match(out, /diff --git a\/a\.txt b\/a\.txt/);
  assert.match(out, /diff --git a\/c\.txt b\/c\.txt/);
  assert.doesNotMatch(out, /line5/); // unstaged not included
  await fs.rm(dir, { recursive: true, force: true });
});

test("getDiff with includeUnstaged includes working tree changes", async () => {
  const dir = await makeFixtureRepo();
  const out = await getDiff({ range: "main..feature", includeUnstaged: true }, dir);
  assert.match(out, /line5/);
  await fs.rm(dir, { recursive: true, force: true });
});

test("getDiff unstagedOnly returns only working tree diff", async () => {
  const dir = await makeFixtureRepo();
  const out = await getDiff({ unstagedOnly: true }, dir);
  assert.match(out, /line5/);
  // The committed change from main..feature should still show because unstaged
  // compares working tree to HEAD; HEAD has line4 already.
  // So we should NOT see line4 as an addition (it's already in HEAD).
  // We *should* see line5 as the only addition.
  assert.doesNotMatch(out, /\+line4/);
  await fs.rm(dir, { recursive: true, force: true });
});

test("getDiff commit returns single-commit diff", async () => {
  const dir = await makeFixtureRepo();
  const commits = await commitsBetween("main", "feature", dir);
  const earlier = commits[1]; // "feature change 1"
  const out = await getDiff({ commit: earlier.sha }, dir);
  assert.match(out, /LINE2/);
  assert.doesNotMatch(out, /new file/); // c.txt is a later commit
  await fs.rm(dir, { recursive: true, force: true });
});

test("changedFiles lists files in the range", async () => {
  const dir = await makeFixtureRepo();
  const files = await changedFiles({ range: "main..feature" }, dir);
  assert.deepEqual(files.sort(), ["a.txt", "c.txt"]);
  await fs.rm(dir, { recursive: true, force: true });
});
