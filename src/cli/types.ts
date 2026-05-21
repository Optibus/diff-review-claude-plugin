export type Side = "LEFT" | "RIGHT";

export interface Draft {
  id: string;
  file: string;
  startLine: number;
  endLine: number;
  side: Side;
  body: string;
  sourceId: string;
  updatedAt: string;
}

export interface DraftStore {
  schemaVersion: 1;
  comments: Record<string, Draft>;
  summary: string;
}

export interface DiffSource {
  id: string;
  label: string;
  kind: "branch-vs-base" | "branch-vs-base-with-unstaged" | "unstaged" | "commit";
  commit?: string;
  base?: string;
}

export interface SubmissionResult {
  cancelled: boolean;
  store?: DraftStore;
}
