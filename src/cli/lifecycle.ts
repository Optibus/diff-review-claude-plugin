import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { ensureStorageDir, lockPath } from "./storage.js";

export class LockError extends Error {
  constructor(message: string, public pid?: number) {
    super(message);
    this.name = "LockError";
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: unknown) {
    const err = e as { code?: string };
    // EPERM means process exists but we can't signal it; still alive.
    return err.code === "EPERM";
  }
}

export async function acquireLock(fingerprint: string): Promise<void> {
  await ensureStorageDir(fingerprint);
  const file = lockPath(fingerprint);
  try {
    const existing = await fs.readFile(file, "utf8");
    const pid = parseInt(existing.trim(), 10);
    if (!Number.isNaN(pid) && pidAlive(pid)) {
      throw new LockError(
        `Another diff-review is already running (PID ${pid}). Submit or cancel that one first.`,
        pid,
      );
    }
    // stale; reap
  } catch (e: unknown) {
    if (e instanceof LockError) throw e;
    const err = e as { code?: string };
    if (err.code !== "ENOENT") throw e;
  }
  await fs.writeFile(file, String(process.pid), "utf8");
}

export async function releaseLock(fingerprint: string): Promise<void> {
  try {
    const existing = await fs.readFile(lockPath(fingerprint), "utf8");
    const pid = parseInt(existing.trim(), 10);
    if (pid !== process.pid) return; // not ours
    await fs.unlink(lockPath(fingerprint));
  } catch (e: unknown) {
    const err = e as { code?: string };
    if (err.code !== "ENOENT") throw e;
  }
}

export function openBrowser(url: string): void {
  const platform = process.platform;
  let cmd: string;
  let args: string[];
  if (platform === "darwin") {
    cmd = "open";
    args = [url];
  } else if (platform === "win32") {
    cmd = "cmd";
    args = ["/c", "start", "", url];
  } else {
    cmd = "xdg-open";
    args = [url];
  }
  try {
    const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
    child.on("error", () => {/* user can copy the URL */});
    child.unref();
  } catch {
    // Browser open is best-effort.
  }
}
