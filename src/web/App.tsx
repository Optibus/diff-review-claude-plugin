import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FileData, ViewType } from "react-diff-view";
import { api, openEventStream } from "./api";
import { DiffSourcePicker } from "./DiffSourcePicker";
import { FileTree } from "./FileTree";
import { DiffView } from "./DiffView";
import { SummaryBox } from "./SummaryBox";
import type { DiffSource, Draft, DraftStore } from "../cli/types";

type AppState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; ctx: { branch: string; root: string }; sources: DiffSource[] }
  | { kind: "submitted" }
  | { kind: "cancelled" };

export function App() {
  const [state, setState] = useState<AppState>({ kind: "loading" });
  const [currentSource, setCurrentSource] = useState<string>("");
  const [diffText, setDiffText] = useState<string>("");
  const [files, setFiles] = useState<FileData[]>([]);
  const [drafts, setDrafts] = useState<DraftStore>({ schemaVersion: 1, comments: {}, summary: "" });
  const [viewType, setViewType] = useState<ViewType>("unified");
  const [activeFile, setActiveFile] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
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
    return openEventStream(() => {/* heartbeat */});
  }, []);

  // Load diff whenever source changes
  useEffect(() => {
    if (!currentSource) return;
    (async () => {
      try {
        const { diff } = await api.diff(currentSource);
        setDiffText(diff);
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
      };
      const saved = await api.saveDraft(id, draft);
      setDrafts((d) => ({ ...d, comments: { ...d.comments, [id]: saved } }));
    },
    [drafts, currentSource],
  );

  const onDeleteDraft = useCallback(
    async (id: string) => {
      await api.deleteDraft(id);
      setDrafts((d) => {
        const { [id]: _omit, ...rest } = d.comments;
        return { ...d, comments: rest };
      });
    },
    [],
  );

  const onSaveSummary = useCallback(
    async (summary: string) => {
      await api.saveSummary(summary);
      setDrafts((d) => ({ ...d, summary }));
    },
    [],
  );

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
  if (state.kind === "error") return <div className="bigmsg bigmsg--error">Error: {state.message}</div>;
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
        <p>Your drafts are saved. Run <code>/diff-review</code> again to resume.</p>
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
            /> Unified
          </label>
          <label className="viewtype">
            <input
              type="radio"
              name="viewtype"
              value="split"
              checked={viewType === "split"}
              onChange={() => setViewType("split")}
            /> Split
          </label>
        </div>
        <div className="topbar__right">
          <span className="topbar__count">{totalComments} comment{totalComments === 1 ? "" : "s"}</span>
          <button onClick={onDiscardClick} disabled={busy}>Discard</button>
          <button className="primary" onClick={onSubmit} disabled={busy || !canSubmit} title={canSubmit ? "" : "Add a comment or summary first"}>
            Submit review
          </button>
        </div>
      </header>
      {confirmingDiscard && (
        <div className="confirm-bar">
          <span>Discard this review? Drafts remain saved for next time.</span>
          <button onClick={() => void doCancel()} disabled={busy}>Yes, discard</button>
          <button onClick={() => setConfirmingDiscard(false)} disabled={busy}>Keep editing</button>
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
            onParsed={setFiles}
            onStartComment={onStartComment}
            onSave={onSaveDraft}
            onDelete={onDeleteDraft}
            registerFileAnchor={(key, el) => { fileRefs.current[key] = el; }}
          />
        </div>
        <SummaryBox initialValue={drafts.summary} onSave={onSaveSummary} />
      </main>
    </div>
  );
}
