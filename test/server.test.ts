import { strict as assert } from "node:assert";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { promisify } from "node:util";
import path from "node:path";
import { createServer } from "../src/cli/server.js";
import { repoFingerprint, storageDir } from "../src/cli/storage.js";
import type { SubmissionResult } from "../src/cli/types.js";

const exec = promisify(execFile);

interface Harness {
  cwd: string;
  fingerprint: string;
  token: string;
  url: string;
  port: number;
  close: () => Promise<void>;
  resolved: Promise<SubmissionResult>;
}

async function makeRepo(): Promise<string> {
  const dir = await fs.mkdtemp("/tmp/diff-review-srv-");
  const g = (...args: string[]) => exec("git", args, { cwd: dir });
  await g("init", "-q", "-b", "main");
  await g("config", "user.email", "t@t");
  await g("config", "user.name", "T");
  await fs.writeFile(path.join(dir, "a.txt"), "alpha\nbeta\ngamma\n");
  await g("add", ".");
  await g("commit", "-q", "-m", "initial");
  await g("checkout", "-q", "-b", "feat");
  await fs.writeFile(path.join(dir, "a.txt"), "alpha\nBETA\ngamma\ndelta\n");
  await g("add", ".");
  await g("commit", "-q", "-m", "feat change");
  // unstaged
  await fs.writeFile(path.join(dir, "a.txt"), "alpha\nBETA\ngamma\ndelta\nepsilon\n");
  return dir;
}

async function startHarness(): Promise<Harness> {
  const cwd = await makeRepo();
  const absGitDir = (await exec("git", ["rev-parse", "--absolute-git-dir"], { cwd })).stdout.trim();
  const fingerprint = repoFingerprint(absGitDir + ":" + Math.random()); // unique per test
  try { await fs.rm(storageDir(fingerprint), { recursive: true, force: true }); } catch {}
  const token = "test-token-" + Math.random().toString(36).slice(2);
  let resolver!: (r: SubmissionResult) => void;
  const resolved = new Promise<SubmissionResult>((r) => { resolver = r; });
  const server = await createServer({
    cwd,
    fingerprint,
    html: "<html>UI</html>",
    token,
    onResolve: (r) => resolver(r),
  });
  return {
    cwd,
    fingerprint,
    token,
    url: server.url,
    port: server.port,
    resolved,
    close: async () => {
      await server.close();
      await fs.rm(cwd, { recursive: true, force: true });
      try { await fs.rm(storageDir(fingerprint), { recursive: true, force: true }); } catch {}
    },
  };
}

function api(h: Harness, p: string, init?: RequestInit) {
  const sep = p.includes("?") ? "&" : "?";
  return fetch(`http://127.0.0.1:${h.port}${p}${sep}t=${h.token}`, init);
}

test("GET / returns the HTML", async () => {
  const h = await startHarness();
  try {
    const r = await fetch(`http://127.0.0.1:${h.port}/`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get("content-type") ?? "", /text\/html/);
    const body = await r.text();
    assert.match(body, /<html>UI<\/html>/);
  } finally { await h.close(); }
});

test("API requires token", async () => {
  const h = await startHarness();
  try {
    const r = await fetch(`http://127.0.0.1:${h.port}/api/drafts`);
    assert.equal(r.status, 401);
  } finally { await h.close(); }
});

test("API accepts token via query and via X-Token header", async () => {
  const h = await startHarness();
  try {
    const r1 = await api(h, "/api/drafts");
    assert.equal(r1.status, 200);
    const r2 = await fetch(`http://127.0.0.1:${h.port}/api/drafts`, { headers: { "X-Token": h.token } });
    assert.equal(r2.status, 200);
  } finally { await h.close(); }
});

test("GET /api/diff-sources includes branch and uncommitted options, default first", async () => {
  const h = await startHarness();
  try {
    const r = await api(h, "/api/diff-sources");
    const body = await r.json() as { sources: { id: string; kind: string }[] };
    const ids = body.sources.map((s) => s.id);
    assert.ok(ids.includes("branch"));
    assert.ok(ids.includes("branch-with-uncommitted"));
    assert.ok(ids.includes("uncommitted"));
    assert.ok(ids.some((id) => id.startsWith("commit:")));
    // Default (first) should be the full branch diff including uncommitted work.
    assert.equal(body.sources[0].id, "branch-with-uncommitted");
  } finally { await h.close(); }
});

test("GET /api/diff?source=branch returns committed diff only", async () => {
  const h = await startHarness();
  try {
    const r = await api(h, "/api/diff?source=branch");
    const body = await r.json() as { diff: string; files: string[] };
    assert.match(body.diff, /diff --git a\/a\.txt/);
    assert.match(body.diff, /BETA/);
    assert.doesNotMatch(body.diff, /epsilon/);
    assert.deepEqual(body.files, ["a.txt"]);
  } finally { await h.close(); }
});

test("GET /api/diff against an advanced base excludes commits that landed on base after divergence (merge-base semantics)", async () => {
  // Build a repo where main moves forward after the feature branch
  // diverged. The branch diff should NOT include that drift.
  const dir = await fs.mkdtemp("/tmp/diff-review-mb-");
  const g = (...args: string[]) => exec("git", args, { cwd: dir });
  try {
    await g("init", "-q", "-b", "main");
    await g("config", "user.email", "t@t");
    await g("config", "user.name", "T");
    await fs.writeFile(path.join(dir, "shared.txt"), "v1\n");
    await g("add", ".");
    await g("commit", "-q", "-m", "shared v1");

    // Feature branches off here.
    await g("checkout", "-q", "-b", "feat");
    await fs.writeFile(path.join(dir, "feat.txt"), "feature\n");
    await g("add", ".");
    await g("commit", "-q", "-m", "feat work");

    // Main advances independently with a completely separate file.
    await g("checkout", "-q", "main");
    await fs.writeFile(path.join(dir, "main-only.txt"), "added on main later\n");
    await g("add", ".");
    await g("commit", "-q", "-m", "main advances");

    // Back on feat — main now has commits feat doesn't.
    await g("checkout", "-q", "feat");

    const absGitDir = (await exec("git", ["rev-parse", "--absolute-git-dir"], { cwd: dir })).stdout.trim();
    const fingerprint = repoFingerprint(absGitDir + ":" + Math.random());
    try { await fs.rm(storageDir(fingerprint), { recursive: true, force: true }); } catch {}
    const token = "mb-token";
    let resolver!: (r: SubmissionResult) => void;
    const resolved = new Promise<SubmissionResult>((r) => { resolver = r; });
    const server = await createServer({
      cwd: dir, fingerprint, html: "<html>UI</html>", token,
      onResolve: (r) => resolver(r),
    });
    try {
      const r = await fetch(`http://127.0.0.1:${server.port}/api/diff?source=branch&t=${token}`);
      const body = await r.json() as { diff: string; files: string[] };
      // Only the feat branch's own file should appear; main's later
      // commit must NOT show up because we diff from the merge-base.
      assert.deepEqual(body.files, ["feat.txt"]);
      assert.doesNotMatch(body.diff, /main-only\.txt/);
      assert.match(body.diff, /feature/);
    } finally {
      await server.close();
      void resolved;
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("GET /api/diff?source=uncommitted returns working tree only", async () => {
  const h = await startHarness();
  try {
    const r = await api(h, "/api/diff?source=uncommitted");
    const body = await r.json() as { diff: string };
    assert.match(body.diff, /epsilon/);
  } finally { await h.close(); }
});

test("PUT and GET /api/drafts round-trip", async () => {
  const h = await startHarness();
  try {
    const id = "a.txt:1:3:RIGHT";
    const draft = { file: "a.txt", startLine: 1, endLine: 3, side: "RIGHT", body: "rename this", sourceId: "branch" };
    const put = await api(h, `/api/drafts/${encodeURIComponent(id)}`, {
      method: "PUT", body: JSON.stringify(draft), headers: { "content-type": "application/json" },
    });
    assert.equal(put.status, 200);
    const list = await api(h, "/api/drafts");
    const store = await list.json() as { comments: Record<string, { body: string }> };
    assert.equal(store.comments[id].body, "rename this");
  } finally { await h.close(); }
});

test("DELETE /api/drafts/:id removes the draft", async () => {
  const h = await startHarness();
  try {
    const id = "a.txt:2:2:RIGHT";
    await api(h, `/api/drafts/${encodeURIComponent(id)}`, {
      method: "PUT",
      body: JSON.stringify({ file: "a.txt", startLine: 2, endLine: 2, side: "RIGHT", body: "x", sourceId: "branch" }),
      headers: { "content-type": "application/json" },
    });
    const del = await api(h, `/api/drafts/${encodeURIComponent(id)}`, { method: "DELETE" });
    assert.equal(del.status, 200);
    const list = await api(h, "/api/drafts");
    const store = await list.json() as { comments: Record<string, unknown> };
    assert.equal(store.comments[id], undefined);
  } finally { await h.close(); }
});

test("PUT /api/summary stores the summary", async () => {
  const h = await startHarness();
  try {
    const r = await api(h, "/api/summary", {
      method: "PUT", body: JSON.stringify({ summary: "lgtm" }), headers: { "content-type": "application/json" },
    });
    assert.equal(r.status, 200);
    const list = await api(h, "/api/drafts");
    const store = await list.json() as { summary: string };
    assert.equal(store.summary, "lgtm");
  } finally { await h.close(); }
});

test("POST /api/submit resolves the server with current store", async () => {
  const h = await startHarness();
  try {
    await api(h, "/api/summary", {
      method: "PUT", body: JSON.stringify({ summary: "approved" }), headers: { "content-type": "application/json" },
    });
    const r = await api(h, "/api/submit", { method: "POST" });
    assert.equal(r.status, 200);
    const result = await h.resolved;
    assert.equal(result.cancelled, false);
    assert.equal(result.store?.summary, "approved");
  } finally { await h.close(); }
});

test("POST /api/cancel resolves the server as cancelled", async () => {
  const h = await startHarness();
  try {
    const r = await api(h, "/api/cancel", { method: "POST" });
    assert.equal(r.status, 200);
    const result = await h.resolved;
    assert.equal(result.cancelled, true);
  } finally { await h.close(); }
});

test("GET /api/source returns file content for the old side", async () => {
  const h = await startHarness();
  try {
    const r = await api(h, "/api/source?source=branch&path=a.txt&side=old");
    assert.equal(r.status, 200);
    const body = await r.json() as { content: string | null };
    assert.match(body.content ?? "", /alpha\nbeta\ngamma/);
  } finally { await h.close(); }
});

test("GET /api/source returns null content for a file that didn't exist on a side", async () => {
  const h = await startHarness();
  try {
    // a.txt didn't exist at base+1 commits; this is the initial state.
    const r = await api(h, "/api/source?source=branch&path=nonexistent.txt&side=old");
    assert.equal(r.status, 200);
    const body = await r.json() as { content: string | null };
    assert.equal(body.content, null);
  } finally { await h.close(); }
});

test("GET /api/source rejects ../ path-traversal attempts", async () => {
  const h = await startHarness();
  try {
    const r = await api(h, "/api/source?source=branch&path=../etc/passwd&side=old");
    assert.equal(r.status, 400);
  } finally { await h.close(); }
});

test("PUT /api/drafts rejects invalid payload", async () => {
  const h = await startHarness();
  try {
    const r = await api(h, "/api/drafts/x.ts:1:1:RIGHT", {
      method: "PUT", body: JSON.stringify({ file: "", startLine: 0, endLine: 0, body: "x" }),
      headers: { "content-type": "application/json" },
    });
    assert.equal(r.status, 500);
    const body = await r.json() as { error: string };
    assert.match(body.error, /required|positive/);
  } finally { await h.close(); }
});
