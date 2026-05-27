import { useState } from "react";
import type { Draft } from "../cli/types";

interface Props {
  draft: Draft;
  onSave: (body: string) => Promise<void>;
  onDelete: () => Promise<void>;
  initiallyEditing?: boolean;
}

export function CommentThread({ draft, onSave, onDelete, initiallyEditing = false }: Props) {
  const [editing, setEditing] = useState(initiallyEditing || draft.body === "");
  const [body, setBody] = useState(draft.body);
  const [saving, setSaving] = useState(false);

  const range =
    draft.startLine === draft.endLine
      ? `Line ${draft.startLine}`
      : `Lines ${draft.startLine}–${draft.endLine}`;
  const isUnstartedSingleLine = draft.body === "" && draft.startLine === draft.endLine;

  if (editing) {
    return (
      <div className="thread thread--editing">
        <div className="thread__header">
          {range}
          {isUnstartedSingleLine && (
            <span className="thread__hint"> — Shift+click another line to extend</span>
          )}
        </div>
        <textarea
          className="thread__textarea"
          value={body}
          // biome-ignore lint/a11y/noAutofocus: focusing the comment box right after the user clicks a line is the intended flow
          autoFocus
          rows={4}
          placeholder="Leave a comment"
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault();
              void save();
            }
            if (e.key === "Escape") {
              e.preventDefault();
              if (draft.body === "") void onDelete();
              else {
                setBody(draft.body);
                setEditing(false);
              }
            }
          }}
        />
        <div className="thread__actions">
          <button type="button" onClick={save} disabled={saving || body.trim() === ""}>
            {saving ? "Saving…" : "Save"}
          </button>
          <button
            type="button"
            onClick={() => {
              if (draft.body === "") void onDelete();
              else {
                setBody(draft.body);
                setEditing(false);
              }
            }}
            disabled={saving}
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="thread">
      <div className="thread__header">{range}</div>
      <div className="thread__body">{draft.body}</div>
      <div className="thread__actions">
        <button type="button" onClick={() => setEditing(true)}>
          Edit
        </button>
        <button type="button" onClick={() => void onDelete()}>
          Delete
        </button>
      </div>
    </div>
  );

  async function save() {
    if (body.trim() === "") return;
    setSaving(true);
    try {
      await onSave(body);
      setEditing(false);
    } finally {
      setSaving(false);
    }
  }
}
