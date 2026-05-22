import type { FileData } from "react-diff-view";

// react-diff-view's parser stores the literal "/dev/null" in newPath for
// deleted files and in oldPath for added files. Use this anywhere we need a
// single human-readable path — it returns the real side.
export function displayPath(f: FileData): string {
  if (f.type === "delete") return f.oldPath ?? "";
  if (f.type === "add") return f.newPath ?? "";
  return f.newPath ?? f.oldPath ?? "";
}
