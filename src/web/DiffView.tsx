import { Fragment, useMemo, useState } from "react";
import {
  Decoration,
  Diff,
  Hunk,
  computeNewLineNumber,
  findChangeByNewLineNumber,
  getChangeKey,
  parseDiff,
} from "react-diff-view";
import type { ChangeData, DiffType, FileData, ViewType } from "react-diff-view";
import type { Draft } from "../cli/types";
import { CommentThread } from "./CommentThread";

export interface FileBlock {
  file: FileData;
  key: string;
}

interface Props {
  diffText: string;
  drafts: Draft[];
  sourceId: string;
  viewType: ViewType;
  onParsed?: (files: FileData[]) => void;
  /** Called when a new comment anchor is requested. Caller creates the draft. */
  onStartComment: (file: string, startLine: number, endLine: number) => void;
  onSave: (id: string, body: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  registerFileAnchor: (key: string, el: HTMLElement | null) => void;
}

interface PendingAnchor {
  file: string;
  line: number;
}

function fileKey(f: FileData): string {
  return f.newPath || f.oldPath || "";
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

  // Pending anchor: first click sets it; second click in same file extends.
  const [pendingByFile, setPendingByFile] = useState<Record<string, PendingAnchor>>({});

  // Group drafts by file
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
        const fileDrafts = draftsByFile.get(path) ?? [];
        const inFileOrphans = fileDrafts.filter((d) => d.sourceId !== sourceId);

        // Build widgets keyed by change.
        const widgets: Record<string, React.ReactNode> = {};
        const widgetEntries = new Map<string, Draft[]>();

        for (const d of fileDrafts) {
          if (d.sourceId !== sourceId) continue;
          // Anchor at endLine on RIGHT side (the new file).
          const change = findChangeByNewLineNumber(file.hunks, d.endLine);
          if (!change) continue;
          const key = getChangeKey(change);
          if (!widgetEntries.has(key)) widgetEntries.set(key, []);
          widgetEntries.get(key)!.push(d);
        }

        // If there's a pending anchor for this file, render an empty thread at the pending line.
        const pending = pendingByFile[path];
        if (pending) {
          const change = findChangeByNewLineNumber(file.hunks, pending.line);
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
                    setPendingByFile((p) => { const { [path]: _omit, ...rest } = p; return rest; });
                    await onSave(d.id.startsWith("__pending__:") ? canonicalId(d) : d.id, body);
                  }}
                  onDelete={async () => {
                    if (d.id.startsWith("__pending__:")) {
                      setPendingByFile((p) => { const { [path]: _omit, ...rest } = p; return rest; });
                    } else {
                      await onDelete(d.id);
                    }
                  }}
                />
              ))}
            </div>
          );
        }

        const handleGutterClick = (
          args: { change: ChangeData | null },
          ev: React.MouseEvent,
        ) => {
          if (!args.change) return;
          const lineNo = computeNewLineNumber(args.change);
          if (lineNo < 0) return; // deletion line on left
          const existing = pendingByFile[path];
          if (ev.shiftKey && existing) {
            const start = Math.min(existing.line, lineNo);
            const end = Math.max(existing.line, lineNo);
            setPendingByFile((p) => { const { [path]: _omit, ...rest } = p; return rest; });
            onStartComment(path, start, end);
          } else {
            setPendingByFile((p) => ({ ...p, [path]: { file: path, line: lineNo } }));
          }
        };

        const diffType = (file.type ?? "modify") as DiffType;

        return (
          <section
            className="filediff"
            key={path}
            ref={(el) => registerFileAnchor(path, el)}
          >
            <header className="filediff__header">
              <code>{path}</code>
              <span className="filediff__type">{file.type}</span>
            </header>
            {inFileOrphans.length > 0 && (
              <div className="filediff__orphans">
                <strong>{inFileOrphans.length} comment(s) from other diff sources — switch source to see them.</strong>
              </div>
            )}
            {file.hunks.length === 0 ? (
              <div className="filediff__empty">(no textual diff)</div>
            ) : (
              <Diff
                diffType={diffType}
                viewType={viewType}
                hunks={file.hunks}
                widgets={widgets}
                gutterEvents={{ onClick: handleGutterClick }}
              >
                {(hunks) =>
                  hunks.map((h, i) => (
                    <Fragment key={i}>
                      <Decoration>
                        <div className="hunk-header">@@ -{h.oldStart},{h.oldLines} +{h.newStart},{h.newLines} @@</div>
                      </Decoration>
                      <Hunk hunk={h} />
                    </Fragment>
                  ))
                }
              </Diff>
            )}
          </section>
        );
      })}
    </div>
  );
}

function canonicalId(d: Draft): string {
  return `${d.file}:${d.startLine}:${d.endLine}:${d.side}`;
}
