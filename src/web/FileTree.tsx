import type { FileData } from "react-diff-view";

interface Props {
  files: FileData[];
  commentCountByFile: Record<string, number>;
  activeFile: string | null;
  onSelect: (file: string) => void;
}

function fileLabel(f: FileData): string {
  if (f.type === "rename") return `${f.oldPath} → ${f.newPath}`;
  return f.newPath ?? f.oldPath ?? "";
}

function typeBadge(f: FileData): string {
  switch (f.type) {
    case "add": return "A";
    case "delete": return "D";
    case "rename": return "R";
    case "copy": return "C";
    default: return "M";
  }
}

export function FileTree({ files, commentCountByFile, activeFile, onSelect }: Props) {
  if (files.length === 0) {
    return <nav className="filetree filetree--empty">No files in this diff.</nav>;
  }
  return (
    <nav className="filetree">
      <div className="filetree__header">{files.length} file{files.length === 1 ? "" : "s"} changed</div>
      <ul>
        {files.map((f) => {
          const label = fileLabel(f);
          const key = f.newPath || f.oldPath || label;
          const count = commentCountByFile[f.newPath ?? ""] ?? commentCountByFile[f.oldPath ?? ""] ?? 0;
          return (
            <li key={key}>
              <button
                className={`filetree__item ${activeFile === key ? "is-active" : ""}`}
                onClick={() => onSelect(key)}
                title={label}
              >
                <span className={`filetree__badge filetree__badge--${f.type}`}>{typeBadge(f)}</span>
                <span className="filetree__name">{label}</span>
                {count > 0 && <span className="filetree__count">{count}</span>}
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
