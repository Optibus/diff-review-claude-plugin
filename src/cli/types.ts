export type Side = "LEFT" | "RIGHT";

export interface Draft {
  id: string;
  file: string;
  startLine: number;
  endLine: number;
  side: Side;
  body: string;
  sourceId: string;
  /** A human-readable label of the diff source at save time. Optional for backwards compat. */
  sourceLabel?: string;
  /** Snippet of the actual lines being commented on, so reviews survive line-number drift. */
  lineSnippet?: string;
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
  kind: "branch-vs-base" | "branch-vs-base-with-uncommitted" | "uncommitted" | "commit";
  commit?: string;
  base?: string;
}

export interface SubmissionResult {
  cancelled: boolean;
  store?: DraftStore;
}
