import { strict as assert } from "node:assert";
import { test } from "node:test";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import {
  clearDrafts,
  commentId,
  draftsPath,
  loadDrafts,
  repoFingerprint,
  saveDrafts,
  storageDir,
} from "../src/cli/storage.js";
import type { DraftStore } from "../src/cli/types.js";

const TEST_GIT_DIR = `/tmp/diff-review-test-${process.pid}/.git`;
const FP = repoFingerprint(TEST_GIT_DIR);

async function cleanup() {
  try {
    await fs.rm(storageDir(FP), { recursive: true, force: true });
  } catch {/* ignore */}
}

test("repoFingerprint is deterministic and 16 hex chars", () => {
  const fp = repoFingerprint("/some/path/.git");
  assert.equal(fp.length, 16);
  assert.match(fp, /^[0-9a-f]{16}$/);
  assert.equal(fp, repoFingerprint("/some/path/.git"));
  assert.notEqual(fp, repoFingerprint("/other/path/.git"));
});

test("storageDir is under ~/.diff-review", () => {
  const dir = storageDir("abc123");
  assert.equal(dir, path.join(homedir(), ".diff-review", "abc123"));
});

test("loadDrafts returns empty store when file missing", async () => {
  await cleanup();
  const store = await loadDrafts(FP);
  assert.equal(store.schemaVersion, 1);
  assert.deepEqual(store.comments, {});
  assert.equal(store.summary, "");
});

test("save then load round-trips", async () => {
  await cleanup();
  const store: DraftStore = {
    schemaVersion: 1,
    comments: {
      "a.ts:1:1:RIGHT": {
        id: "a.ts:1:1:RIGHT",
        file: "a.ts",
        startLine: 1,
        endLine: 1,
        side: "RIGHT",
        body: "fix this",
        sourceId: "branch",
        updatedAt: "2026-01-01T00:00:00Z",
      },
    },
    summary: "ok",
  };
  await saveDrafts(FP, store);
  // file should exist
  await fs.access(draftsPath(FP));
  const loaded = await loadDrafts(FP);
  assert.deepEqual(loaded, store);
  await cleanup();
});

test("clearDrafts removes file and is idempotent", async () => {
  await cleanup();
  const store: DraftStore = { schemaVersion: 1, comments: {}, summary: "x" };
  await saveDrafts(FP, store);
  await clearDrafts(FP);
  await assert.rejects(() => fs.access(draftsPath(FP)));
  await clearDrafts(FP); // no throw on missing
  await cleanup();
});

test("loadDrafts ignores malformed files (returns empty)", async () => {
  await cleanup();
  await fs.mkdir(storageDir(FP), { recursive: true });
  await fs.writeFile(draftsPath(FP), "{not json}", "utf8");
  await assert.rejects(() => loadDrafts(FP)); // JSON parse error bubbles up
  await fs.writeFile(draftsPath(FP), JSON.stringify({ schemaVersion: 99 }), "utf8");
  const store = await loadDrafts(FP);
  assert.deepEqual(store, { schemaVersion: 1, comments: {}, summary: "" });
  await cleanup();
});

test("commentId is stable and unique by anchor", () => {
  const id = commentId({ file: "x.ts", startLine: 1, endLine: 5, side: "RIGHT" });
  assert.equal(id, "x.ts:1:5:RIGHT");
});
