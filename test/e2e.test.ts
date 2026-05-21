import { strict as assert } from "node:assert";
import { test } from "node:test";
import { spawn, execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { promisify } from "node:util";
import path from "node:path";
import { repoFingerprint, storageDir, saveDrafts } from "../src/cli/storage.js";

const exec = promisify(execFile);

const BIN = path.resolve("bin/diff-review.js");

async function makeRepo(): Promise<{ dir: string; fp: string }> {
  const dir = await fs.mkdtemp("/tmp/diff-review-e2e-");
  const g = (...args: string[]) => exec("git", args, { cwd: dir });
  await g("init", "-q", "-b", "main");
  await g("config", "user.email", "e@e");
  await g("config", "user.name", "E");
  await fs.writeFile(path.join(dir, "hello.txt"), "hello\nworld\n");
  await g("add", ".");
  await g("commit", "-q", "-m", "initial");
  await g("checkout", "-q", "-b", "topic");
  await fs.writeFile(path.join(dir, "hello.txt"), "hello\nWORLD\ngoodbye\n");
  await g("add", ".");
  await g("commit", "-q", "-m", "topic edit");
  const absGit = (await exec("git", ["rev-parse", "--absolute-git-dir"], { cwd: dir })).stdout.trim();
  return { dir, fp: repoFingerprint(absGit) };
}

async function cleanup(dir: string, fp: string) {
  try { await fs.rm(dir, { recursive: true, force: true }); } catch {}
  try { await fs.rm(storageDir(fp), { recursive: true, force: true }); } catch {}
}

function runBinary(args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], { cwd, env: { ...process.env } });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (b) => stdout += b);
    child.stderr.on("data", (b) => stderr += b);
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

test("e2e: --auto-submit with no drafts → empty review, exit 1", async () => {
  const { dir, fp } = await makeRepo();
  try {
    const r = await runBinary(["--auto-submit", "--no-browser"], dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /\(empty review\)/);
    assert.equal(r.stdout, "");
  } finally { await cleanup(dir, fp); }
});

test("e2e: --auto-submit with seeded drafts → markdown stdout, exit 0, drafts cleared", async () => {
  const { dir, fp } = await makeRepo();
  try {
    await saveDrafts(fp, {
      schemaVersion: 1,
      summary: "looks great overall",
      comments: {
        "hello.txt:2:2:RIGHT": {
          id: "hello.txt:2:2:RIGHT",
          file: "hello.txt",
          startLine: 2,
          endLine: 2,
          side: "RIGHT",
          body: "use lowercase",
          sourceId: "branch",
          updatedAt: new Date().toISOString(),
        },
        "hello.txt:3:3:RIGHT": {
          id: "hello.txt:3:3:RIGHT",
          file: "hello.txt",
          startLine: 3,
          endLine: 3,
          side: "RIGHT",
          body: "spell-check 'goodbye'",
          sourceId: "branch",
          updatedAt: new Date().toISOString(),
        },
      },
    });
    const r = await runBinary(["--auto-submit", "--no-browser"], dir);
    assert.equal(r.code, 0, `stderr was: ${r.stderr}`);
    assert.match(r.stdout, /^# Code review feedback/);
    assert.match(r.stdout, /## Overall\n\nlooks great overall/);
    assert.match(r.stdout, /### hello\.txt:2\n\nuse lowercase/);
    assert.match(r.stdout, /### hello\.txt:3\n\nspell-check 'goodbye'/);
    // Drafts should be cleared after a successful submit.
    const drafted = await fs.readFile(path.join(storageDir(fp), "drafts.json"), "utf8").catch(() => null);
    assert.equal(drafted, null);
  } finally { await cleanup(dir, fp); }
});

test("e2e: lock prevents concurrent runs", async () => {
  const { dir, fp } = await makeRepo();
  try {
    // Start a long-running instance (no auto-submit; will block on browser).
    const child = spawn(process.execPath, [BIN, "--no-browser"], {
      cwd: dir,
      env: { ...process.env },
    });
    // Wait for the server to start (it logs the URL to stderr).
    const ready = new Promise<void>((resolve) => {
      child.stderr.on("data", (b) => {
        if (String(b).includes("open http://")) resolve();
      });
    });
    await ready;

    const r = await runBinary(["--no-browser"], dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /already running/);

    child.kill("SIGINT");
    await new Promise((res) => child.on("close", res));
  } finally { await cleanup(dir, fp); }
});

test("e2e: full HTTP flow — start server, save draft via fetch, submit", async () => {
  const { dir, fp } = await makeRepo();
  try {
    const child = spawn(process.execPath, [BIN, "--no-browser"], {
      cwd: dir,
      env: { ...process.env },
    });

    let stdoutBuf = "";
    let stderrBuf = "";
    child.stdout.on("data", (b) => stdoutBuf += b);
    child.stderr.on("data", (b) => stderrBuf += b);

    const url = await new Promise<string>((resolve, reject) => {
      const onErr = (e: Error) => reject(e);
      child.on("error", onErr);
      child.stderr.on("data", (b) => {
        const m = String(b).match(/open (http:\/\/127\.0\.0\.1:\d+\/\?t=[a-f0-9]+)/);
        if (m) resolve(m[1]);
      });
    });

    const base = new URL(url);
    const token = base.searchParams.get("t")!;
    const port = base.port;

    // GET / returns HTML
    const home = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(home.status, 200);
    const html = await home.text();
    assert.match(html, /<!doctype html>/i);
    assert.match(html, /id="root"/);

    // GET /api/diff-sources
    const srcs = await fetch(`http://127.0.0.1:${port}/api/diff-sources?t=${token}`);
    const sBody = await srcs.json() as { sources: { id: string }[] };
    assert.ok(sBody.sources.length > 0);

    // GET /api/diff?source=branch
    const diff = await fetch(`http://127.0.0.1:${port}/api/diff?source=branch&t=${token}`);
    const dBody = await diff.json() as { diff: string; files: string[] };
    assert.match(dBody.diff, /WORLD/);
    assert.deepEqual(dBody.files, ["hello.txt"]);

    // PUT a draft
    const id = "hello.txt:2:2:RIGHT";
    const put = await fetch(`http://127.0.0.1:${port}/api/drafts/${encodeURIComponent(id)}?t=${token}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file: "hello.txt", startLine: 2, endLine: 2, side: "RIGHT", body: "needs lowercase", sourceId: "branch" }),
    });
    assert.equal(put.status, 200);

    // POST /api/submit
    const submit = await fetch(`http://127.0.0.1:${port}/api/submit?t=${token}`, { method: "POST" });
    assert.equal(submit.status, 200);

    // Process should exit cleanly with markdown on stdout
    const code = await new Promise<number>((res) => child.on("close", (c) => res(c ?? -1)));
    assert.equal(code, 0, `stderr was: ${stderrBuf}`);
    assert.match(stdoutBuf, /needs lowercase/);
  } finally { await cleanup(dir, fp); }
});

test("e2e: cancel via POST /api/cancel returns exit 1", async () => {
  const { dir, fp } = await makeRepo();
  try {
    const child = spawn(process.execPath, [BIN, "--no-browser"], { cwd: dir });
    let stderrBuf = "";
    child.stderr.on("data", (b) => stderrBuf += b);

    const url = await new Promise<string>((resolve) => {
      child.stderr.on("data", (b) => {
        const m = String(b).match(/open (http:\/\/127\.0\.0\.1:\d+\/\?t=[a-f0-9]+)/);
        if (m) resolve(m[1]);
      });
    });
    const base = new URL(url);
    const token = base.searchParams.get("t")!;
    const port = base.port;

    await fetch(`http://127.0.0.1:${port}/api/cancel?t=${token}`, { method: "POST" });
    const code = await new Promise<number>((res) => child.on("close", (c) => res(c ?? -1)));
    assert.equal(code, 1);
    assert.match(stderrBuf, /\(review cancelled\)/);
  } finally { await cleanup(dir, fp); }
});
