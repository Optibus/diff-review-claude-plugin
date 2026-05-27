import type { CSSProperties, ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import type { FileData } from "react-diff-view";
import { displayPath } from "./paths";

interface Props {
  files: FileData[];
  commentCountByFile: Record<string, number>;
  activeFile: string | null;
  onSelect: (file: string) => void;
}

function fileLabel(f: FileData): string {
  if (f.type === "rename") return `${f.oldPath} → ${f.newPath}`;
  return displayPath(f);
}

function typeBadge(f: FileData): string {
  switch (f.type) {
    case "add":
      return "A";
    case "delete":
      return "D";
    case "rename":
      return "R";
    case "copy":
      return "C";
    default:
      return "M";
  }
}

function fileKey(f: FileData): string {
  return displayPath(f) || fileLabel(f);
}

function filePathForMatch(f: FileData): string {
  // Match against both sides so renamed files find both the old and new path.
  if (f.type === "rename") return `${f.oldPath ?? ""} ${f.newPath ?? ""}`;
  return displayPath(f);
}

type DirNode = { kind: "dir"; name: string; id: string; children: TreeNode[] };
type FileNode = { kind: "file"; name: string; file: FileData; key: string };
type TreeNode = DirNode | FileNode;

function buildTree(files: FileData[]): DirNode {
  const root: DirNode = { kind: "dir", name: "", id: "", children: [] };
  for (const f of files) {
    const path = displayPath(f);
    const parts = path.split("/").filter(Boolean);
    const dirs = parts.slice(0, -1);
    const leafName = parts[parts.length - 1] ?? fileLabel(f);
    let cursor = root;
    for (const part of dirs) {
      let next = cursor.children.find((c): c is DirNode => c.kind === "dir" && c.name === part);
      if (!next) {
        next = {
          kind: "dir",
          name: part,
          id: cursor.id ? `${cursor.id}/${part}` : part,
          children: [],
        };
        cursor.children.push(next);
      }
      cursor = next;
    }
    cursor.children.push({ kind: "file", name: leafName, file: f, key: fileKey(f) });
  }
  return root;
}

// VS Code-style: any dir whose only child is also a dir gets merged into it.
// Recurses bottom-up so chains of length > 2 collapse fully.
function compressDir(node: DirNode): DirNode {
  const children: TreeNode[] = node.children.map((c) => (c.kind === "dir" ? compressDir(c) : c));
  let merged: DirNode = { ...node, children };
  while (
    merged.name !== "" && // never compress the synthetic root
    merged.children.length === 1 &&
    merged.children[0].kind === "dir"
  ) {
    const only = merged.children[0];
    merged = {
      kind: "dir",
      name: `${merged.name}/${only.name}`,
      id: only.id, // deepest id is unique within the tree
      children: only.children,
    };
  }
  return merged;
}

function ancestorIdsFor(root: DirNode, targetKey: string): string[] {
  const result: string[] = [];
  function walk(node: DirNode, acc: string[]): boolean {
    for (const c of node.children) {
      if (c.kind === "file") {
        if (c.key === targetKey) {
          result.push(...acc);
          return true;
        }
      } else {
        if (walk(c, [...acc, c.id])) return true;
      }
    }
    return false;
  }
  walk(root, []);
  return result;
}

// Returns the subset of the tree where every leaf file's full path matches
// the (lowercased) query, plus any ancestors needed to reach them. Returns
// null if the whole subtree has no match.
function filterTree(node: DirNode, q: string): DirNode | null {
  const kept: TreeNode[] = [];
  for (const c of node.children) {
    if (c.kind === "file") {
      if (filePathForMatch(c.file).toLowerCase().includes(q)) kept.push(c);
    } else {
      const sub = filterTree(c, q);
      if (sub) kept.push(sub);
    }
  }
  if (kept.length === 0) return null;
  return { ...node, children: kept };
}

function countFiles(node: DirNode): number {
  let n = 0;
  for (const c of node.children) {
    if (c.kind === "file") n++;
    else n += countFiles(c);
  }
  return n;
}

export function FileTree({ files, commentCountByFile, activeFile, onSelect }: Props) {
  const root = useMemo(() => compressDir(buildTree(files)), [files]);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [query, setQuery] = useState("");

  const trimmedQuery = query.trim().toLowerCase();
  const filtering = trimmedQuery.length > 0;
  const displayRoot = useMemo(
    () => (filtering ? filterTree(root, trimmedQuery) : root),
    [root, filtering, trimmedQuery],
  );
  const matchCount = useMemo(() => (displayRoot ? countFiles(displayRoot) : 0), [displayRoot]);

  // Auto-expand ancestors when activeFile changes from the outside.
  useEffect(() => {
    if (!activeFile) return;
    const ancestors = ancestorIdsFor(root, activeFile);
    if (ancestors.length === 0) return;
    setCollapsed((prev) => {
      let changed = false;
      const next = new Set(prev);
      for (const id of ancestors) {
        if (next.delete(id)) changed = true;
      }
      return changed ? next : prev;
    });
  }, [activeFile, root]);

  const toggle = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  if (files.length === 0) {
    return <nav className="filetree filetree--empty">No files in this diff.</nav>;
  }

  const renderNode = (node: TreeNode, depth: number): ReactNode => {
    const style = { "--depth": depth } as CSSProperties;
    if (node.kind === "file") {
      const f = node.file;
      const count = commentCountByFile[displayPath(f)] ?? 0;
      const isActive = activeFile === node.key;
      return (
        <li key={`f:${node.key}`}>
          <button
            type="button"
            className={`filetree__item filetree__item--file ${isActive ? "is-active" : ""}`}
            onClick={() => onSelect(node.key)}
            title={fileLabel(f)}
            style={style}
          >
            <span className={`filetree__badge filetree__badge--${f.type}`}>{typeBadge(f)}</span>
            <span className="filetree__name">{node.name}</span>
            {count > 0 && <span className="filetree__count">{count}</span>}
          </button>
        </li>
      );
    }
    // While a filter is active, ignore the persisted collapsed state so
    // matches are never hidden behind a folder the user collapsed earlier.
    const isCollapsed = filtering ? false : collapsed.has(node.id);
    return (
      <li key={`d:${node.id}`}>
        <button
          type="button"
          className="filetree__item filetree__item--dir"
          onClick={() => toggle(node.id)}
          title={node.name}
          style={style}
          aria-expanded={!isCollapsed}
        >
          <span className="filetree__chevron" aria-hidden="true">
            {isCollapsed ? "▶" : "▼"}
          </span>
          <span className="filetree__dirname">{node.name}/</span>
        </button>
        {!isCollapsed && (
          <ul className="filetree__list">{node.children.map((c) => renderNode(c, depth + 1))}</ul>
        )}
      </li>
    );
  };

  return (
    <nav className="filetree">
      <div className="filetree__search">
        <input
          type="search"
          className="filetree__search-input"
          placeholder="Filter files…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") setQuery("");
          }}
          aria-label="Filter files"
        />
      </div>
      <div className="filetree__header">
        {filtering
          ? `${matchCount} of ${files.length} file${files.length === 1 ? "" : "s"}`
          : `${files.length} file${files.length === 1 ? "" : "s"} changed`}
      </div>
      {displayRoot && displayRoot.children.length > 0 ? (
        <ul className="filetree__list">{displayRoot.children.map((c) => renderNode(c, 0))}</ul>
      ) : (
        <div className="filetree__empty">No files match.</div>
      )}
    </nav>
  );
}
