import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { ensureStorageDir, instancePath, lockPath } from "./storage.js";

export interface InstanceInfo {
  pid: number;
  port: number;
  token: string;
}

export class LockError extends Error {
  constructor(
    message: string,
    public pid?: number,
  ) {
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
  // Best-effort: also clear the instance metadata file.
  try {
    await fs.unlink(instancePath(fingerprint));
  } catch (e: unknown) {
    const err = e as { code?: string };
    if (err.code !== "ENOENT") throw e;
  }
}

export async function writeInstance(fingerprint: string, info: InstanceInfo): Promise<void> {
  await ensureStorageDir(fingerprint);
  await fs.writeFile(instancePath(fingerprint), JSON.stringify(info), "utf8");
}

export async function readInstance(fingerprint: string): Promise<InstanceInfo | null> {
  try {
    const raw = await fs.readFile(instancePath(fingerprint), "utf8");
    const parsed = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed.pid === "number" &&
      typeof parsed.port === "number" &&
      typeof parsed.token === "string"
    ) {
      return parsed as InstanceInfo;
    }
    return null;
  } catch {
    return null;
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
    child.on("error", () => {
      /* user can copy the URL */
    });
    child.unref();
  } catch {
    // Browser open is best-effort.
  }
}
