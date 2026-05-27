import { strict as assert } from "node:assert";
import { promises as fs } from "node:fs";
import { test } from "node:test";
import { acquireLock, LockError, releaseLock } from "../src/cli/lifecycle.js";
import { lockPath, repoFingerprint, storageDir } from "../src/cli/storage.js";

const FP = repoFingerprint(`/tmp/diff-review-lock-${process.pid}`);

async function cleanup() {
  try {
    await fs.rm(storageDir(FP), { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

test("acquireLock writes our PID; releaseLock removes it", async () => {
  await cleanup();
  await acquireLock(FP);
  const pid = parseInt((await fs.readFile(lockPath(FP), "utf8")).trim(), 10);
  assert.equal(pid, process.pid);
  await releaseLock(FP);
  await assert.rejects(() => fs.access(lockPath(FP)));
});

test("acquireLock reaps stale lock from dead PID", async () => {
  await cleanup();
  await fs.mkdir(storageDir(FP), { recursive: true });
  // PID 1 is init/launchd, definitely not a stale diff-review. Use a number we
  // can verify is dead. PID 999999 should not exist.
  await fs.writeFile(lockPath(FP), "999999", "utf8");
  await acquireLock(FP); // should not throw
  const pid = parseInt((await fs.readFile(lockPath(FP), "utf8")).trim(), 10);
  assert.equal(pid, process.pid);
  await releaseLock(FP);
});

test("acquireLock throws LockError when lock is held by live PID", async () => {
  await cleanup();
  await fs.mkdir(storageDir(FP), { recursive: true });
  await fs.writeFile(lockPath(FP), String(process.pid), "utf8");
  await assert.rejects(
    () => acquireLock(FP),
    (e: unknown) => e instanceof LockError,
  );
  await cleanup();
});
