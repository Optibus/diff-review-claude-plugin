import { createServer as createHttpServer, IncomingMessage, ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { AddressInfo } from "node:net";
import * as git from "./git.js";
import * as storage from "./storage.js";
import type { Draft, DiffSource, SubmissionResult } from "./types.js";

export interface ServerDeps {
  cwd: string;
  fingerprint: string;
  html: string;
  token: string;
  onResolve: (result: SubmissionResult) => void;
  /** Port to bind to. 0 (default) picks any free port. */
  port?: number;
  /** If true, suppress browser-targeted logs (used when caller already prints status). */
  quiet?: boolean;
}

export interface RunningServer {
  port: number;
  url: string;
  close: () => Promise<void>;
  /** Notify server that it's still being watched (resets idle timer). */
  noteActivity: () => void;
}

const IDLE_TIMEOUT_MS = 60_000;
const HEARTBEAT_INTERVAL_MS = 15_000;

function send(res: ServerResponse, status: number, body: string, contentType = "text/plain; charset=utf-8") {
  res.writeHead(status, {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, data: unknown) {
  send(res, status, JSON.stringify(data), "application/json; charset=utf-8");
}

function constantTimeEq(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

async function readJsonBody(req: IncomingMessage, limitBytes = 1024 * 1024): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > limitBytes) throw new Error("Request body too large");
    chunks.push(buf);
  }
  const body = Buffer.concat(chunks).toString("utf8");
  if (!body) return undefined;
  return JSON.parse(body);
}

function parseDraftPayload(input: unknown, idFromUrl: string): Draft {
  if (!input || typeof input !== "object") throw new Error("Invalid payload");
  const r = input as Record<string, unknown>;
  const file = String(r.file ?? "");
  const startLine = Number(r.startLine);
  const endLine = Number(r.endLine);
  const side = r.side === "LEFT" ? "LEFT" : "RIGHT";
  const body = String(r.body ?? "");
  const sourceId = String(r.sourceId ?? "");
  if (!file) throw new Error("draft.file required");
  if (!Number.isInteger(startLine) || startLine < 1) throw new Error("draft.startLine must be positive integer");
  if (!Number.isInteger(endLine) || endLine < startLine) throw new Error("draft.endLine must be >= startLine");
  // Trust idFromUrl as the canonical id.
  return {
    id: idFromUrl,
    file,
    startLine,
    endLine,
    side,
    body,
    sourceId,
    updatedAt: new Date().toISOString(),
  };
}

async function listDiffSources(cwd: string): Promise<DiffSource[]> {
  const sources: DiffSource[] = [];
  let base: string | null = null;
  try {
    base = await git.defaultBaseBranch(cwd);
  } catch {
    base = null;
  }
  const head = await git.currentBranch(cwd);
  if (base) {
    sources.push({
      id: "branch",
      label: `${head} vs ${base}`,
      kind: "branch-vs-base",
      base,
    });
    sources.push({
      id: "branch-with-unstaged",
      label: `${head} vs ${base} (incl. unstaged)`,
      kind: "branch-vs-base-with-unstaged",
      base,
    });
  }
  sources.push({
    id: "unstaged",
    label: "Unstaged changes only",
    kind: "unstaged",
  });
  if (base) {
    try {
      const commits = await git.commitsBetween(base, "HEAD", cwd);
      for (const c of commits) {
        sources.push({
          id: `commit:${c.sha}`,
          label: `${c.shortSha} ${c.subject}`,
          kind: "commit",
          commit: c.sha,
        });
      }
    } catch {/* ignore */}
  }
  return sources;
}

function sourceToDiffOpts(source: DiffSource): git.DiffOptions {
  switch (source.kind) {
    case "branch-vs-base":
      return { range: `${source.base}..HEAD` };
    case "branch-vs-base-with-unstaged":
      return { range: `${source.base}..HEAD`, includeUnstaged: true };
    case "unstaged":
      return { unstagedOnly: true };
    case "commit":
      return { commit: source.commit! };
  }
}

export function createServer(deps: ServerDeps): Promise<RunningServer> {
  const { cwd, fingerprint, html, token, onResolve } = deps;
  let resolved = false;
  let idleTimer: NodeJS.Timeout | null = null;
  const sseClients = new Set<ServerResponse>();

  const resolveOnce = (result: SubmissionResult) => {
    if (resolved) return;
    resolved = true;
    onResolve(result);
  };

  const armIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (sseClients.size === 0) {
        resolveOnce({ cancelled: true });
      }
    }, IDLE_TIMEOUT_MS);
  };

  const noteActivity = () => {
    armIdleTimer();
  };

  const checkAuth = (url: URL): boolean => {
    const t = url.searchParams.get("t");
    if (!t) return false;
    return constantTimeEq(t, token);
  };

  // Cached sources per request lifetime keyed by id
  const sourceById = async (id: string): Promise<DiffSource | null> => {
    const sources = await listDiffSources(cwd);
    return sources.find((s) => s.id === id) ?? null;
  };

  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const pathname = url.pathname;

    // Static UI
    if (req.method === "GET" && pathname === "/") {
      send(res, 200, html, "text/html; charset=utf-8");
      noteActivity();
      return;
    }

    // Token check for everything else
    if (pathname.startsWith("/api/")) {
      const headerToken = (req.headers["x-token"] as string | undefined) ?? "";
      const ok = checkAuth(url) || (headerToken && constantTimeEq(headerToken, token));
      if (!ok) {
        send(res, 401, "unauthorized");
        return;
      }
    }

    try {
      if (req.method === "GET" && pathname === "/api/context") {
        const branch = await git.currentBranch(cwd);
        const root = await git.repoRoot(cwd);
        sendJson(res, 200, { branch, root });
        return;
      }

      if (req.method === "GET" && pathname === "/api/diff-sources") {
        const sources = await listDiffSources(cwd);
        sendJson(res, 200, { sources });
        return;
      }

      if (req.method === "GET" && pathname === "/api/diff") {
        const sourceId = url.searchParams.get("source") ?? "";
        const source = await sourceById(sourceId);
        if (!source) return sendJson(res, 404, { error: "unknown source" });
        const diff = await git.getDiff(sourceToDiffOpts(source), cwd);
        const files = await git.changedFiles(sourceToDiffOpts(source), cwd);
        sendJson(res, 200, { diff, files, sourceId: source.id });
        return;
      }

      if (req.method === "GET" && pathname === "/api/drafts") {
        const store = await storage.loadDrafts(fingerprint);
        sendJson(res, 200, store);
        return;
      }

      if (req.method === "PUT" && pathname.startsWith("/api/drafts/")) {
        const id = decodeURIComponent(pathname.slice("/api/drafts/".length));
        const payload = await readJsonBody(req);
        const draft = parseDraftPayload(payload, id);
        const store = await storage.loadDrafts(fingerprint);
        store.comments[id] = draft;
        await storage.saveDrafts(fingerprint, store);
        sendJson(res, 200, draft);
        return;
      }

      if (req.method === "DELETE" && pathname.startsWith("/api/drafts/")) {
        const id = decodeURIComponent(pathname.slice("/api/drafts/".length));
        const store = await storage.loadDrafts(fingerprint);
        delete store.comments[id];
        await storage.saveDrafts(fingerprint, store);
        sendJson(res, 200, { ok: true });
        return;
      }

      if (req.method === "PUT" && pathname === "/api/summary") {
        const payload = (await readJsonBody(req)) as { summary?: unknown } | undefined;
        const summary = String(payload?.summary ?? "");
        const store = await storage.loadDrafts(fingerprint);
        store.summary = summary;
        await storage.saveDrafts(fingerprint, store);
        sendJson(res, 200, { summary });
        return;
      }

      if (req.method === "POST" && pathname === "/api/submit") {
        const store = await storage.loadDrafts(fingerprint);
        sendJson(res, 200, { ok: true });
        // Close after responding so client sees confirmation.
        setImmediate(() => resolveOnce({ cancelled: false, store }));
        return;
      }

      if (req.method === "POST" && pathname === "/api/cancel") {
        sendJson(res, 200, { ok: true });
        setImmediate(() => resolveOnce({ cancelled: true }));
        return;
      }

      if (req.method === "GET" && pathname === "/api/events") {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-store",
          Connection: "keep-alive",
        });
        res.write(`event: hello\ndata: {}\n\n`);
        sseClients.add(res);
        const heartbeat = setInterval(() => {
          try { res.write(`:ping\n\n`); } catch { /* dead client */ }
        }, HEARTBEAT_INTERVAL_MS);
        const cleanup = () => {
          clearInterval(heartbeat);
          sseClients.delete(res);
          armIdleTimer();
        };
        req.on("close", cleanup);
        req.on("error", cleanup);
        noteActivity();
        return;
      }

      send(res, 404, "not found");
    } catch (e: unknown) {
      const err = e as Error;
      sendJson(res, 500, { error: err.message ?? "internal error" });
    }
  };

  const server = createHttpServer((req, res) => {
    Promise.resolve(handler(req, res)).catch((e: Error) => {
      try { sendJson(res, 500, { error: e.message }); } catch { /* response already sent */ }
    });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(deps.port ?? 0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      armIdleTimer();
      resolve({
        port: addr.port,
        url: `http://127.0.0.1:${addr.port}/?t=${token}`,
        noteActivity,
        close: () =>
          new Promise<void>((res) => {
            if (idleTimer) clearTimeout(idleTimer);
            for (const c of sseClients) {
              try { c.end(); } catch { /* ignore */ }
            }
            sseClients.clear();
            server.close(() => res());
            server.closeAllConnections?.();
          }),
      });
    });
  });
}

// Export internals for testing
export const __test = {
  listDiffSources,
  sourceToDiffOpts,
  parseDraftPayload,
};
