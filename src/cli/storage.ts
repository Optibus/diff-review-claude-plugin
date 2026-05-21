import { createHash, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { Draft, DraftStore } from "./types.js";

export function repoFingerprint(absGitDir: string): string {
  return createHash("sha1").update(absGitDir).digest("hex").slice(0, 16);
}

export function storageDir(fingerprint: string): string {
  return path.join(homedir(), ".diff-review", fingerprint);
}

export function draftsPath(fingerprint: string): string {
  return path.join(storageDir(fingerprint), "drafts.json");
}

export function lockPath(fingerprint: string): string {
  return path.join(storageDir(fingerprint), "lock");
}

export function instancePath(fingerprint: string): string {
  return path.join(storageDir(fingerprint), "instance.json");
}

function emptyStore(): DraftStore {
  return { schemaVersion: 1, comments: {}, summary: "" };
}

export async function ensureStorageDir(fingerprint: string): Promise<void> {
  await fs.mkdir(storageDir(fingerprint), { recursive: true });
}

export async function loadDrafts(fingerprint: string): Promise<DraftStore> {
  try {
    const buf = await fs.readFile(draftsPath(fingerprint), "utf8");
    const parsed = JSON.parse(buf);
    if (parsed && typeof parsed === "object" && parsed.schemaVersion === 1) {
      return {
        schemaVersion: 1,
        comments: parsed.comments ?? {},
        summary: typeof parsed.summary === "string" ? parsed.summary : "",
      };
    }
    return emptyStore();
  } catch (e: unknown) {
    const err = e as { code?: string };
    if (err.code === "ENOENT") return emptyStore();
    throw e;
  }
}

export async function saveDrafts(fingerprint: string, store: DraftStore): Promise<void> {
  await ensureStorageDir(fingerprint);
  const file = draftsPath(fingerprint);
  const tmp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(store, null, 2), "utf8");
  await fs.rename(tmp, file);
}

export async function clearDrafts(fingerprint: string): Promise<void> {
  try {
    await fs.unlink(draftsPath(fingerprint));
  } catch (e: unknown) {
    const err = e as { code?: string };
    if (err.code !== "ENOENT") throw e;
  }
}

export function commentId(d: Pick<Draft, "file" | "startLine" | "endLine" | "side">): string {
  return `${d.file}:${d.startLine}:${d.endLine}:${d.side}`;
}
