import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ChangeData,
  DiffType,
  FileData,
  HunkData,
  HunkTokens,
  ViewType,
} from "react-diff-view";
import {
  computeNewLineNumber,
  Decoration,
  Diff,
  findChangeByNewLineNumber,
  getChangeKey,
  Hunk,
  parseDiff,
  tokenize,
  useSourceExpansion,
} from "react-diff-view";
import type { Draft } from "../cli/types";
import { api } from "./api";
import { CommentThread } from "./CommentThread";
import { displayPath } from "./paths";
import { languageFor, refractor } from "./syntax";

interface Props {
  diffText: string;
  drafts: Draft[];
  sourceId: string;
  viewType: ViewType;
  fileAttrs?: Record<string, Record<string, string>>;
  onParsed?: (files: FileData[]) => void;
  onStartComment: (file: string, startLine: number, endLine: number) => void;
  onSave: (id: string, body: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  registerFileAnchor: (key: string, el: HTMLElement | null) => void;
}

function isGenerated(attrs: Record<string, string> | undefined): boolean {
  // gitattributes can express this as `linguist-generated` (set), or as
  // `linguist-generated=true`. Treat both as generated.
  if (!attrs) return false;
  const v = attrs["linguist-generated"];
  return v === "set" || v === "true";
}

function fileKey(f: FileData): string {
  return displayPath(f);
}

function canonicalId(d: Draft): string {
  return `${d.file}:${d.startLine}:${d.endLine}:${d.side}`;
}

export function DiffView({
  diffText,
  drafts,
  sourceId,
  viewType,
  fileAttrs,
  onParsed,
  onStartComment,
  onSave,
  onDelete,
  registerFileAnchor,
}: Props) {
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-parse only when the diff text changes; onParsed is a stable notify-callback we deliberately exclude
  const files: FileData[] = useMemo(() => {
    const parsed = diffText.trim() ? parseDiff(diffText) : [];
    onParsed?.(parsed);
    return parsed;
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
        const generated = isGenerated(fileAttrs?.[displayPath(file)]);
        return (
          <FileDiffPanel
            key={`${sourceId}:${path}`}
            file={file}
            path={path}
            sourceId={sourceId}
            viewType={viewType}
            generated={generated}
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
  generated: boolean;
  drafts: Draft[];
  onStartComment: (file: string, startLine: number, endLine: number) => void;
  onSave: (id: string, body: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  registerFileAnchor: (key: string, el: HTMLElement | null) => void;
}

interface PendingAnchor {
  line: number;
}

function FileDiffPanel({
  file,
  path,
  sourceId,
  viewType,
  generated,
  drafts: fileDrafts,
  onStartComment,
  onSave,
  onDelete,
  registerFileAnchor,
}: PanelProps) {
  const [oldSource, setOldSource] = useState<string | null>(null);
  const [oldSourceStatus, setOldSourceStatus] = useState<"idle" | "loading" | "missing">("idle");
  const [pending, setPending] = useState<PendingAnchor | null>(null);
  const [hoverLine, setHoverLine] = useState<number | null>(null);
  const [shiftHeld, setShiftHeld] = useState(false);
  const [expandedGenerated, setExpandedGenerated] = useState(false);
  const [hunks, expandRange] = useSourceExpansion(file.hunks, oldSource);

  // Track shift only while there's a pending anchor — that's the only time
  // the user might be about to extend a selection.
  useEffect(() => {
    if (!pending) {
      setShiftHeld(false);
      return;
    }
    const onDown = (e: KeyboardEvent) => {
      if (e.key === "Shift") setShiftHeld(true);
    };
    const onUp = (e: KeyboardEvent) => {
      if (e.key === "Shift") setShiftHeld(false);
    };
    window.addEventListener("keydown", onDown);
    window.addEventListener("keyup", onUp);
    return () => {
      window.removeEventListener("keydown", onDown);
      window.removeEventListener("keyup", onUp);
    };
  }, [pending]);

  const tokens: HunkTokens | null = useMemo(() => {
    const lang = languageFor(path);
    if (!lang) return null;
    // Prism tokenizes each line synchronously. Minified/generated files
    // routinely have lines >100KB which freezes the main thread; skip
    // highlighting for those — the diff still renders, just unstyled.
    for (const h of hunks) {
      for (const c of h.changes) {
        if (c.content.length > 5000) return null;
      }
    }
    try {
      return tokenize(hunks, { highlight: true, refractor, language: lang });
    } catch {
      return null;
    }
  }, [hunks, path]);

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

  const handleExpand = useCallback(
    (start: number, end: number) => {
      if (start > end) return;
      if (oldSource !== null) {
        expandRangeRef.current(start, end);
        return;
      }
      queuedExpansions.current.push({ start, end });
      void ensureOldSource();
    },
    [oldSource, ensureOldSource],
  );

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

  const handleGutterEnter = (args: { change: ChangeData | null }) => {
    if (!args.change) return;
    const lineNo = computeNewLineNumber(args.change);
    if (lineNo < 0) return;
    setHoverLine(lineNo);
  };

  // Highlight the anchor (and, while shift is held, the preview range to the
  // current hover) plus any draft still being composed (body === ""). The
  // library applies `diff-{gutter,code}-selected` classes for these keys.
  const selectedChanges = useMemo(() => {
    const ranges: Array<[number, number]> = [];
    if (pending) {
      let s = pending.line;
      let e = pending.line;
      if (shiftHeld && hoverLine !== null) {
        s = Math.min(pending.line, hoverLine);
        e = Math.max(pending.line, hoverLine);
      }
      ranges.push([s, e]);
    }
    for (const d of fileDrafts) {
      if (d.sourceId !== sourceId) continue;
      if (d.body !== "") continue;
      ranges.push([d.startLine, d.endLine]);
    }
    if (ranges.length === 0) return [];
    const keys: string[] = [];
    for (const h of hunks) {
      for (const c of h.changes) {
        const ln = computeNewLineNumber(c);
        if (ln < 0) continue;
        for (const [s, e] of ranges) {
          if (ln >= s && ln <= e) {
            keys.push(getChangeKey(c));
            break;
          }
        }
      }
    }
    return keys;
  }, [pending, shiftHeld, hoverLine, hunks, fileDrafts, sourceId]);

  // Strip a single trailing newline before counting lines so a file ending
  // in "\n" reports its true line count (not +1 for the empty tail element).
  const oldSourceLineCount = oldSource ? oldSource.replace(/\n$/, "").split("\n").length : null;
  const diffType = (file.type ?? "modify") as DiffType;

  const showCollapsed = generated && !expandedGenerated;

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: onMouseLeave only clears hover state for gutter affordances; the actual comment controls are real buttons
    <section
      className="filediff"
      ref={(el) => registerFileAnchor(path, el)}
      onMouseLeave={() => setHoverLine(null)}
    >
      <header className="filediff__header">
        <code>{path}</code>
        <span className="filediff__type">
          {generated && (
            <span
              className="filediff__generated"
              title="Marked linguist-generated in .gitattributes"
            >
              generated
            </span>
          )}
          {file.type}
        </span>
      </header>
      {inFileOrphans.length > 0 && (
        <div className="filediff__orphans">
          <strong>
            {inFileOrphans.length} comment(s) from other diff sources — switch source to see them.
          </strong>
        </div>
      )}
      {showCollapsed ? (
        <button
          type="button"
          className="filediff__collapsed"
          onClick={() => setExpandedGenerated(true)}
        >
          Generated file — show diff
        </button>
      ) : hunks.length === 0 ? (
        <div className="filediff__empty">(no textual diff)</div>
      ) : (
        <Diff
          diffType={diffType}
          viewType={viewType}
          hunks={hunks}
          widgets={widgets}
          tokens={tokens}
          selectedChanges={selectedChanges}
          gutterEvents={{ onClick: handleGutterClick, onMouseEnter: handleGutterEnter }}
        >
          {(visibleHunks) =>
            renderHunksWithExpand(visibleHunks, oldSourceLineCount, oldSourceStatus, handleExpand)
          }
        </Diff>
      )}
    </section>
  );
}

// react-diff-view's expandFromRawCode treats `end` as EXCLUSIVE
// (`source.slice(start-1, end-1)`). To reveal lines [a..b] inclusive,
// call expandRange(a, b+1). All ranges here use exclusive-end accordingly.
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
    // rangeEnd is one past the last hidden line (exclusive).
    let rangeStart: number;
    let rangeEnd: number;
    if (prev === null) {
      rangeStart = 1;
      rangeEnd = hunk.oldStart;
    } else {
      rangeStart = prev.oldStart + prev.oldLines;
      rangeEnd = hunk.oldStart;
    }
    const gap = rangeEnd - rangeStart;

    if (gap > 0) {
      elements.push(
        <Decoration key={`expand-${i}`}>
          <button
            type="button"
            className="expand-btn"
            disabled={oldSourceStatus === "missing"}
            onClick={() => handleExpand(rangeStart, rangeEnd)}
            title={oldSourceStatus === "missing" ? "File content unavailable on this side" : ""}
          >
            {oldSourceStatus === "loading"
              ? "Loading…"
              : `↕ Expand ${gap} hidden line${gap === 1 ? "" : "s"}`}
          </button>
        </Decoration>,
      );
    }

    elements.push(
      <Decoration key={`hdr-${i}`}>
        <div className="hunk-header">
          @@ -{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@
        </div>
      </Decoration>,
    );
    elements.push(<Hunk key={`hunk-${i}`} hunk={hunk} />);
  }

  // Decoration AFTER the last hunk if there's content remaining in oldSource.
  if (oldSourceLineCount !== null && hunks.length > 0) {
    const last = hunks[hunks.length - 1];
    const lastEndExclusive = last.oldStart + last.oldLines; // first hidden line
    const sourceEndExclusive = oldSourceLineCount + 1; // one past EOF
    const after = sourceEndExclusive - lastEndExclusive;
    if (after > 0) {
      elements.push(
        <Decoration key="expand-end">
          <button
            type="button"
            className="expand-btn"
            onClick={() => handleExpand(lastEndExclusive, sourceEndExclusive)}
          >
            ↕ Expand {after} hidden line{after === 1 ? "" : "s"}
          </button>
        </Decoration>,
      );
    }
  } else if (oldSourceLineCount === null && oldSourceStatus !== "missing" && hunks.length > 0) {
    // We don't know the EOF yet; show a button that triggers source load.
    const last = hunks[hunks.length - 1];
    const lastEndExclusive = last.oldStart + last.oldLines;
    elements.push(
      <Decoration key="expand-end-unknown">
        <button
          type="button"
          className="expand-btn expand-btn--probe"
          onClick={() => handleExpand(lastEndExclusive, lastEndExclusive + 20)}
        >
          {oldSourceStatus === "loading" ? "Loading…" : "↕ Expand below"}
        </button>
      </Decoration>,
    );
  }

  return elements;
}
