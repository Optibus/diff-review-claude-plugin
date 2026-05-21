import type { DraftStore } from "./types.js";

function lineLabel(startLine: number, endLine: number): string {
  return startLine === endLine ? `${startLine}` : `${startLine}-${endLine}`;
}

/**
 * Format a submitted review as markdown for stdout. Comments sorted by file then
 * by start line. If both summary and comments are empty, returns null (caller
 * should treat as "empty review").
 */
export function formatReview(store: DraftStore): string | null {
  const summary = store.summary?.trim() ?? "";
  const comments = Object.values(store.comments);
  if (!summary && comments.length === 0) return null;

  const lines: string[] = [];
  lines.push("# Code review feedback");
  lines.push("");

  if (summary) {
    lines.push("## Overall");
    lines.push("");
    lines.push(summary);
    lines.push("");
  }

  if (comments.length > 0) {
    lines.push("## Comments");
    lines.push("");
    const sorted = [...comments].sort((a, b) => {
      if (a.file !== b.file) return a.file < b.file ? -1 : 1;
      if (a.startLine !== b.startLine) return a.startLine - b.startLine;
      return a.endLine - b.endLine;
    });
    for (const c of sorted) {
      lines.push(`### ${c.file}:${lineLabel(c.startLine, c.endLine)}`);
      lines.push("");
      lines.push(c.body.trim());
      lines.push("");
    }
  }

  return lines.join("\n").replace(/\n+$/, "\n");
}
