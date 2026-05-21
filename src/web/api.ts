import type { DiffSource, Draft, DraftStore } from "../cli/types";

const url = new URL(window.location.href);
const TOKEN = url.searchParams.get("t") ?? "";

function withToken(path: string): string {
  const u = new URL(path, window.location.origin);
  u.searchParams.set("t", TOKEN);
  return u.toString();
}

async function jsonReq<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(withToken(path), {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try { msg = ((await res.json()) as { error?: string }).error ?? msg; } catch {/* ignore */}
    throw new Error(msg);
  }
  return res.json() as Promise<T>;
}

export const api = {
  context: () => jsonReq<{ branch: string; root: string }>("/api/context"),
  sources: () => jsonReq<{ sources: DiffSource[] }>("/api/diff-sources"),
  diff: (sourceId: string) =>
    jsonReq<{ diff: string; files: string[]; sourceId: string }>(`/api/diff?source=${encodeURIComponent(sourceId)}`),
  fileAt: (sourceId: string, filePath: string, side: "old" | "new") =>
    jsonReq<{ content: string | null }>(
      `/api/source?source=${encodeURIComponent(sourceId)}&path=${encodeURIComponent(filePath)}&side=${side}`,
    ),
  drafts: () => jsonReq<DraftStore>("/api/drafts"),
  saveDraft: (id: string, draft: Omit<Draft, "id" | "updatedAt">) =>
    jsonReq<Draft>(`/api/drafts/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify(draft) }),
  deleteDraft: (id: string) =>
    jsonReq<{ ok: true }>(`/api/drafts/${encodeURIComponent(id)}`, { method: "DELETE" }),
  saveSummary: (summary: string) =>
    jsonReq<{ summary: string }>("/api/summary", { method: "PUT", body: JSON.stringify({ summary }) }),
  submit: () => jsonReq<{ ok: true }>("/api/submit", { method: "POST" }),
  cancel: () => jsonReq<{ ok: true }>("/api/cancel", { method: "POST" }),
};

export function openEventStream(onPing: () => void): () => void {
  const es = new EventSource(withToken("/api/events"));
  es.addEventListener("hello", () => onPing());
  es.onerror = () => {/* let browser auto-reconnect */};
  return () => es.close();
}
