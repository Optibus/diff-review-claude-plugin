import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChangeData, FileData, ViewType } from "react-diff-view";
import { computeNewLineNumber, computeOldLineNumber } from "react-diff-view";
import type { DiffSource, Draft, DraftStore } from "../cli/types";
import { api, openEventStream } from "./api";
import { DiffSourcePicker } from "./DiffSourcePicker";
import { DiffView } from "./DiffView";
import { FileTree } from "./FileTree";
import { displayPath } from "./paths";
import { SubmitPopover } from "./SubmitPopover";

function snippetFor(
  files: FileData[],
  filePath: string,
  startLine: number,
  endLine: number,
  side: "LEFT" | "RIGHT",
): string | undefined {
  const file = files.find((f) => displayPath(f) === filePath);
  if (!file) return undefined;
  const lineNoOf = side === "LEFT" ? computeOldLineNumber : computeNewLineNumber;
  const lines: string[] = [];
  for (const hunk of file.hunks) {
    for (const change of hunk.changes as ChangeData[]) {
      const n = lineNoOf(change);
      if (n >= startLine && n <= endLine) lines.push(change.content);
    }
  }
  return lines.length > 0 ? lines.join("\n") : undefined;
}

type AppState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; ctx: { branch: string; root: string }; sources: DiffSource[] }
  | { kind: "submitted" }
  | { kind: "cancelled" }
  | { kind: "superseded" };

export function App() {
  const [state, setState] = useState<AppState>({ kind: "loading" });
  const [currentSource, setCurrentSource] = useState<string>("");
  const [diffText, setDiffText] = useState<string>("");
  const [fileAttrs, setFileAttrs] = useState<Record<string, Record<string, string>>>({});
  const [files, setFiles] = useState<FileData[]>([]);
  const [drafts, setDrafts] = useState<DraftStore>({ schemaVersion: 1, comments: {}, summary: "" });
  const [viewType, setViewType] = useState<ViewType>("unified");
  const [activeFile, setActiveFile] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  const [confirmingClearAll, setConfirmingClearAll] = useState(false);
  const fileRefs = useRef<Record<string, HTMLElement | null>>({});

  // Initial load
  useEffect(() => {
    (async () => {
      try {
        const [ctx, { sources }, drafts] = await Promise.all([
          api.context(),
          api.sources(),
          api.drafts(),
        ]);
        setState({ kind: "ready", ctx, sources });
        setDrafts(drafts);
        setCurrentSource(sources[0]?.id ?? "");
      } catch (e: unknown) {
        setState({ kind: "error", message: (e as Error).message });
      }
    })();
  }, []);

  // Keep server alive
  useEffect(() => {
    return openEventStream({
      onSuperseded: () => setState({ kind: "superseded" }),
    });
  }, []);

  // Load diff whenever source changes
  useEffect(() => {
    if (!currentSource) return;
    (async () => {
      try {
        const { diff, attrs } = await api.diff(currentSource);
        setDiffText(diff);
        setFileAttrs(attrs ?? {});
      } catch (e: unknown) {
        setState({ kind: "error", message: (e as Error).message });
      }
    })();
  }, [currentSource]);

  const draftList = useMemo(() => Object.values(drafts.comments), [drafts]);

  const commentCountByFile = useMemo(() => {
    const m: Record<string, number> = {};
    for (const d of draftList) {
      if (d.sourceId !== currentSource) continue;
      if (d.body.trim() === "") continue;
      m[d.file] = (m[d.file] ?? 0) + 1;
    }
    return m;
  }, [draftList, currentSource]);

  const onStartComment = useCallback(
    (file: string, startLine: number, endLine: number) => {
      const id = `${file}:${startLine}:${endLine}:RIGHT`;
      if (drafts.comments[id]) return; // already exists
      const stub: Draft = {
        id,
        file,
        startLine,
        endLine,
        side: "RIGHT",
        body: "",
        sourceId: currentSource,
        updatedAt: new Date().toISOString(),
      };
      setDrafts((d) => ({ ...d, comments: { ...d.comments, [id]: stub } }));
    },
    [drafts, currentSource],
  );

  const onSaveDraft = useCallback(
    async (id: string, body: string) => {
      const existing = drafts.comments[id];
      const parts = id.split(":");
      const side = (parts.pop() ?? "RIGHT") as "LEFT" | "RIGHT";
      const endLine = parseInt(parts.pop() ?? "0", 10);
      const startLine = parseInt(parts.pop() ?? "0", 10);
      const file = parts.join(":");
      const draft = {
        file: existing?.file ?? file,
        startLine: existing?.startLine ?? startLine,
        endLine: existing?.endLine ?? endLine,
        side: existing?.side ?? side,
        body,
        sourceId: currentSource,
        sourceLabel:
          state.kind === "ready"
            ? state.sources.find((s) => s.id === currentSource)?.label
            : undefined,
        lineSnippet: snippetFor(files, file, startLine, endLine, side),
      };
      const saved = await api.saveDraft(id, draft);
      setDrafts((d) => ({ ...d, comments: { ...d.comments, [id]: saved } }));
    },
    [drafts, currentSource, files, state],
  );

  const onDeleteDraft = useCallback(async (id: string) => {
    await api.deleteDraft(id);
    setDrafts((d) => {
      const { [id]: _omit, ...rest } = d.comments;
      return { ...d, comments: rest };
    });
  }, []);

  const onSaveSummary = useCallback(async (summary: string) => {
    await api.saveSummary(summary);
    setDrafts((d) => ({ ...d, summary }));
  }, []);

  const onSubmit = useCallback(async () => {
    setBusy(true);
    try {
      await api.submit();
      setState({ kind: "submitted" });
    } catch (e) {
      setState({ kind: "error", message: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }, []);

  const doCancel = useCallback(async () => {
    setBusy(true);
    try {
      await api.cancel();
      setState({ kind: "cancelled" });
    } catch (e) {
      setState({ kind: "error", message: (e as Error).message });
    } finally {
      setBusy(false);
      setConfirmingDiscard(false);
    }
  }, []);

  const doClearAll = useCallback(async () => {
    setBusy(true);
    try {
      await api.clearAllComments();
      setDrafts((d) => ({ ...d, comments: {} }));
    } catch (e) {
      setState({ kind: "error", message: (e as Error).message });
    } finally {
      setBusy(false);
      setConfirmingClearAll(false);
    }
  }, []);

  const onClearAllClick = useCallback(() => {
    setConfirmingClearAll(true);
  }, []);

  const onDiscardClick = useCallback(() => {
    const hasContent =
      Object.values(drafts.comments).some((d) => d.body.trim() !== "") ||
      drafts.summary.trim() !== "";
    if (!hasContent) {
      void doCancel();
    } else {
      setConfirmingDiscard(true);
    }
  }, [drafts, doCancel]);

  if (state.kind === "loading") return <div className="bigmsg">Loading…</div>;
  if (state.kind === "error")
    return <div className="bigmsg bigmsg--error">Error: {state.message}</div>;
  if (state.kind === "submitted")
    return (
      <div className="bigmsg bigmsg--good">
        <h1>Review submitted.</h1>
        <p>You can close this tab. Claude is reading your feedback now.</p>
      </div>
    );
  if (state.kind === "cancelled")
    return (
      <div className="bigmsg">
        <h1>Review cancelled.</h1>
        <p>
          Your drafts are saved. Run <code>/diff-review</code> again to resume.
        </p>
      </div>
    );
  if (state.kind === "superseded")
    return (
      <div className="bigmsg">
        <h1>This review is now open in another tab.</h1>
        <p>
          Only one tab at a time can edit a review. Switch to the newer tab or close this one — your
          drafts are safe on disk.
        </p>
      </div>
    );

  const totalComments = Object.values(drafts.comments).filter((d) => d.body.trim() !== "").length;
  const summaryHasContent = drafts.summary.trim().length > 0;
  const canSubmit = totalComments > 0 || summaryHasContent;

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar__left">
          <strong>diff-review</strong>
          <span className="topbar__branch">{state.ctx.branch}</span>
          <DiffSourcePicker
            sources={state.sources}
            current={currentSource}
            onChange={setCurrentSource}
          />
          <label className="viewtype">
            <input
              type="radio"
              name="viewtype"
              value="unified"
              checked={viewType === "unified"}
              onChange={() => setViewType("unified")}
            />{" "}
            Unified
          </label>
          <label className="viewtype">
            <input
              type="radio"
              name="viewtype"
              value="split"
              checked={viewType === "split"}
              onChange={() => setViewType("split")}
            />{" "}
            Split
          </label>
        </div>
        <div className="topbar__right">
          <span className="topbar__count">
            {totalComments} comment{totalComments === 1 ? "" : "s"}
          </span>
          <button
            type="button"
            onClick={onClearAllClick}
            disabled={busy || totalComments === 0}
            title={
              totalComments === 0
                ? "No comments to clear"
                : "Delete every saved comment in this review"
            }
          >
            Clear all comments
          </button>
          <button type="button" onClick={onDiscardClick} disabled={busy}>
            Discard
          </button>
          <SubmitPopover
            initialSummary={drafts.summary}
            onSaveSummary={onSaveSummary}
            onSubmit={onSubmit}
            busy={busy}
            canSubmit={canSubmit}
            hasSummary={summaryHasContent}
          />
        </div>
      </header>
      {confirmingDiscard && (
        <div className="confirm-bar">
          <span>Discard this review? Drafts remain saved for next time.</span>
          <button type="button" onClick={() => void doCancel()} disabled={busy}>
            Yes, discard
          </button>
          <button type="button" onClick={() => setConfirmingDiscard(false)} disabled={busy}>
            Keep editing
          </button>
        </div>
      )}
      {confirmingClearAll && (
        <div className="confirm-bar">
          <span>
            Delete all {totalComments} saved comment{totalComments === 1 ? "" : "s"}? The overall
            summary will be kept. This can't be undone.
          </span>
          <button type="button" onClick={() => void doClearAll()} disabled={busy}>
            Yes, clear comments
          </button>
          <button type="button" onClick={() => setConfirmingClearAll(false)} disabled={busy}>
            Cancel
          </button>
        </div>
      )}
      <main className="main">
        <FileTree
          files={files}
          commentCountByFile={commentCountByFile}
          activeFile={activeFile}
          onSelect={(f) => {
            setActiveFile(f);
            fileRefs.current[f]?.scrollIntoView({ behavior: "smooth", block: "start" });
          }}
        />
        <div className="diffpanel">
          <DiffView
            diffText={diffText}
            drafts={draftList}
            sourceId={currentSource}
            viewType={viewType}
            fileAttrs={fileAttrs}
            onParsed={setFiles}
            onStartComment={onStartComment}
            onSave={onSaveDraft}
            onDelete={onDeleteDraft}
            registerFileAnchor={(key, el) => {
              fileRefs.current[key] = el;
            }}
          />
        </div>
      </main>
    </div>
  );
}
