import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Decoration,
  Diff,
  Hunk,
  computeNewLineNumber,
  findChangeByNewLineNumber,
  getChangeKey,
  getCollapsedLinesCountBetween,
  parseDiff,
  useSourceExpansion,
} from "react-diff-view";
import type { ChangeData, DiffType, FileData, HunkData, ViewType } from "react-diff-view";
import type { Draft } from "../cli/types";
import { CommentThread } from "./CommentThread";
import { api } from "./api";

interface Props {
  diffText: string;
  drafts: Draft[];
  sourceId: string;
  viewType: ViewType;
  onParsed?: (files: FileData[]) => void;
  onStartComment: (file: string, startLine: number, endLine: number) => void;
  onSave: (id: string, body: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  registerFileAnchor: (key: string, el: HTMLElement | null) => void;
}

function fileKey(f: FileData): string {
  return f.newPath || f.oldPath || "";
}

function canonicalId(d: Draft): string {
  return `${d.file}:${d.startLine}:${d.endLine}:${d.side}`;
}

export function DiffView({
  diffText,
  drafts,
  sourceId,
  viewType,
  onParsed,
  onStartComment,
  onSave,
  onDelete,
  registerFileAnchor,
}: Props) {
  const files: FileData[] = useMemo(() => {
    const parsed = diffText.trim() ? parseDiff(diffText) : [];
    onParsed?.(parsed);
    return parsed;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [diffText]);

  const draftsByFile = useMemo(() => {
    const m = new Map<string, Draft[]>();
    for (const d of drafts) {
      if (!m.has(d.file)) m.set(d.file, []);
      m.get(d.file)!.push(d);
    }
    return m;
  }, [drafts]);

  if (files.length === 0) {
    return <div className="diffview diffview--empty">No changes to review for this source.</div>;
  }

  return (
    <div className="diffview">
      {files.map((file) => {
        const path = fileKey(file);
        return (
          <FileDiffPanel
            key={`${sourceId}:${path}`}
            file={file}
            path={path}
            sourceId={sourceId}
            viewType={viewType}
            drafts={draftsByFile.get(path) ?? []}
            onStartComment={onStartComment}
            onSave={onSave}
            onDelete={onDelete}
            registerFileAnchor={registerFileAnchor}
          />
        );
      })}
    </div>
  );
}

interface PanelProps {
  file: FileData;
  path: string;
  sourceId: string;
  viewType: ViewType;
  drafts: Draft[];
  onStartComment: (file: string, startLine: number, endLine: number) => void;
  onSave: (id: string, body: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  registerFileAnchor: (key: string, el: HTMLElement | null) => void;
}

interface PendingAnchor { line: number }

function FileDiffPanel({
  file,
  path,
  sourceId,
  viewType,
  drafts: fileDrafts,
  onStartComment,
  onSave,
  onDelete,
  registerFileAnchor,
}: PanelProps) {
  const [oldSource, setOldSource] = useState<string | null>(null);
  const [oldSourceStatus, setOldSourceStatus] = useState<"idle" | "loading" | "missing">("idle");
  const [pending, setPending] = useState<PendingAnchor | null>(null);
  const [hunks, expandRange] = useSourceExpansion(file.hunks, oldSource);

  // expandRange is stable per-render but only effective once oldSource is loaded.
  // Capture the latest in a ref so deferred expansions use the up-to-date callback.
  const expandRangeRef = useRef(expandRange);
  expandRangeRef.current = expandRange;
  const queuedExpansions = useRef<Array<{ start: number; end: number }>>([]);

  const ensureOldSource = useCallback(async (): Promise<string | null> => {
    if (oldSource !== null) return oldSource;
    if (oldSourceStatus === "loading" || oldSourceStatus === "missing") return null;
    setOldSourceStatus("loading");
    try {
      const { content } = await api.fileAt(sourceId, file.oldPath ?? file.newPath ?? path, "old");
      if (content === null) {
        setOldSourceStatus("missing");
        return null;
      }
      setOldSource(content);
      setOldSourceStatus("idle");
      return content;
    } catch {
      setOldSourceStatus("missing");
      return null;
    }
  }, [oldSource, oldSourceStatus, sourceId, file, path]);

  // Drain queued expansions whenever the source becomes available.
  useEffect(() => {
    if (oldSource !== null && queuedExpansions.current.length > 0) {
      const queue = queuedExpansions.current;
      queuedExpansions.current = [];
      for (const { start, end } of queue) {
        expandRangeRef.current(start, end);
      }
    }
  }, [oldSource]);

  const handleExpand = useCallback((start: number, end: number) => {
    if (start > end) return;
    if (oldSource !== null) {
      expandRangeRef.current(start, end);
      return;
    }
    queuedExpansions.current.push({ start, end });
    void ensureOldSource();
  }, [oldSource, ensureOldSource]);

  // Build widgets keyed by change.
  const widgets: Record<string, React.ReactNode> = {};
  const widgetEntries = new Map<string, Draft[]>();
  const inFileOrphans = fileDrafts.filter((d) => d.sourceId !== sourceId);

  for (const d of fileDrafts) {
    if (d.sourceId !== sourceId) continue;
    const change = findChangeByNewLineNumber(hunks, d.endLine);
    if (!change) continue;
    const key = getChangeKey(change);
    if (!widgetEntries.has(key)) widgetEntries.set(key, []);
    widgetEntries.get(key)!.push(d);
  }

  if (pending) {
    const change = findChangeByNewLineNumber(hunks, pending.line);
    if (change) {
      const key = getChangeKey(change);
      const stub: Draft = {
        id: `__pending__:${path}:${pending.line}:${pending.line}:RIGHT`,
        file: path,
        startLine: pending.line,
        endLine: pending.line,
        side: "RIGHT",
        body: "",
        sourceId,
        updatedAt: new Date().toISOString(),
      };
      if (!widgetEntries.has(key)) widgetEntries.set(key, []);
      widgetEntries.get(key)!.push(stub);
    }
  }

  for (const [key, list] of widgetEntries) {
    widgets[key] = (
      <div className="thread__container">
        {list.map((d) => (
          <CommentThread
            key={d.id}
            draft={d}
            initiallyEditing={d.id.startsWith("__pending__:") || d.body === ""}
            onSave={async (body) => {
              setPending(null);
              await onSave(d.id.startsWith("__pending__:") ? canonicalId(d) : d.id, body);
            }}
            onDelete={async () => {
              if (d.id.startsWith("__pending__:")) {
                setPending(null);
              } else {
                await onDelete(d.id);
              }
            }}
          />
        ))}
      </div>
    );
  }

  const handleGutterClick = (args: { change: ChangeData | null }, ev: React.MouseEvent) => {
    if (!args.change) return;
    const lineNo = computeNewLineNumber(args.change);
    if (lineNo < 0) return;
    if (ev.shiftKey && pending) {
      const start = Math.min(pending.line, lineNo);
      const end = Math.max(pending.line, lineNo);
      setPending(null);
      onStartComment(path, start, end);
    } else {
      setPending({ line: lineNo });
    }
  };

  // Strip a single trailing newline before counting lines so a file ending
  // in "\n" reports its true line count (not +1 for the empty tail element).
  const oldSourceLineCount = oldSource
    ? oldSource.replace(/\n$/, "").split("\n").length
    : null;
  const diffType = (file.type ?? "modify") as DiffType;

  return (
    <section className="filediff" ref={(el) => registerFileAnchor(path, el)}>
      <header className="filediff__header">
        <code>{path}</code>
        <span className="filediff__type">{file.type}</span>
      </header>
      {inFileOrphans.length > 0 && (
        <div className="filediff__orphans">
          <strong>{inFileOrphans.length} comment(s) from other diff sources — switch source to see them.</strong>
        </div>
      )}
      {hunks.length === 0 ? (
        <div className="filediff__empty">(no textual diff)</div>
      ) : (
        <Diff
          diffType={diffType}
          viewType={viewType}
          hunks={hunks}
          widgets={widgets}
          gutterEvents={{ onClick: handleGutterClick }}
        >
          {(visibleHunks) => renderHunksWithExpand(
            visibleHunks,
            oldSourceLineCount,
            oldSourceStatus,
            handleExpand,
          )}
        </Diff>
      )}
    </section>
  );
}

function renderHunksWithExpand(
  hunks: HunkData[],
  oldSourceLineCount: number | null,
  oldSourceStatus: "idle" | "loading" | "missing",
  handleExpand: (start: number, end: number) => void,
): React.ReactElement[] {
  const elements: React.ReactElement[] = [];
  for (let i = 0; i < hunks.length; i++) {
    const hunk = hunks[i];
    const prev = i > 0 ? hunks[i - 1] : null;

    // Decoration BEFORE this hunk: gap from prev (or from line 1).
    let gap: number;
    let rangeStart: number;
    let rangeEnd: number;
    if (prev === null) {
      gap = hunk.oldStart - 1;
      rangeStart = 1;
      rangeEnd = hunk.oldStart - 1;
    } else {
      gap = getCollapsedLinesCountBetween(prev, hunk);
      rangeStart = prev.oldStart + prev.oldLines;
      rangeEnd = hunk.oldStart - 1;
    }

    if (gap > 0) {
      elements.push(
        <Decoration key={`expand-${i}`}>
          <button
            className="expand-btn"
            disabled={oldSourceStatus === "missing"}
            onClick={() => handleExpand(rangeStart, rangeEnd)}
            title={oldSourceStatus === "missing" ? "File content unavailable on this side" : ""}
          >
            {oldSourceStatus === "loading" ? "Loading…" : `↕ Expand ${gap} hidden line${gap === 1 ? "" : "s"}`}
          </button>
        </Decoration>,
      );
    }

    elements.push(
      <Decoration key={`hdr-${i}`}>
        <div className="hunk-header">@@ -{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@</div>
      </Decoration>,
    );
    elements.push(<Hunk key={`hunk-${i}`} hunk={hunk} />);
  }

  // Decoration AFTER the last hunk if there's content remaining in oldSource.
  if (oldSourceLineCount !== null && hunks.length > 0) {
    const last = hunks[hunks.length - 1];
    const after = oldSourceLineCount - (last.oldStart + last.oldLines - 1);
    if (after > 0) {
      elements.push(
        <Decoration key="expand-end">
          <button
            className="expand-btn"
            onClick={() => handleExpand(last.oldStart + last.oldLines, oldSourceLineCount)}
          >
            ↕ Expand {after} hidden line{after === 1 ? "" : "s"}
          </button>
        </Decoration>,
      );
    }
  } else if (oldSourceLineCount === null && oldSourceStatus !== "missing" && hunks.length > 0) {
    // We don't know the EOF yet; show a button that triggers source load.
    const last = hunks[hunks.length - 1];
    elements.push(
      <Decoration key="expand-end-unknown">
        <button
          className="expand-btn expand-btn--probe"
          onClick={() => handleExpand(last.oldStart + last.oldLines, last.oldStart + last.oldLines + 19)}
        >
          {oldSourceStatus === "loading" ? "Loading…" : "↕ Expand below"}
        </button>
      </Decoration>,
    );
  }

  return elements;
}
