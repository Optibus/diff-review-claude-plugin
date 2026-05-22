import { useCallback, useEffect, useRef, useState } from "react";

interface Props {
  initialSummary: string;
  onSaveSummary: (value: string) => Promise<void>;
  onSubmit: () => void | Promise<void>;
  busy: boolean;
  canSubmit: boolean;
  hasSummary: boolean;
}

export function SubmitPopover({
  initialSummary,
  onSaveSummary,
  onSubmit,
  busy,
  canSubmit,
  hasSummary,
}: Props) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(initialSummary);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const debounce = useRef<number | undefined>(undefined);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const valueRef = useRef(value);
  valueRef.current = value;

  useEffect(() => setValue(initialSummary), [initialSummary]);

  const flushSave = useCallback(() => {
    if (debounce.current) {
      window.clearTimeout(debounce.current);
      debounce.current = undefined;
    }
    void onSaveSummary(valueRef.current).then(() => setSavedAt(Date.now()));
  }, [onSaveSummary]);

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        flushSave();
        setOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        flushSave();
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, flushSave]);

  useEffect(() => {
    if (open) {
      // Defer to let the popover mount before focusing.
      const id = window.setTimeout(() => textareaRef.current?.focus(), 0);
      return () => window.clearTimeout(id);
    }
  }, [open]);

  function handleChange(next: string) {
    setValue(next);
    if (debounce.current) window.clearTimeout(debounce.current);
    debounce.current = window.setTimeout(() => {
      void onSaveSummary(next).then(() => setSavedAt(Date.now()));
    }, 600);
  }

  return (
    <div className="submit-wrap" ref={wrapRef}>
      <button
        type="button"
        className={`primary submit-trigger ${hasSummary ? "has-summary" : ""}`}
        onClick={() => setOpen((o) => !o)}
        disabled={busy}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        Submit review
        <span className="submit-trigger__chevron" aria-hidden="true">▾</span>
      </button>
      {open && (
        <div className="submit-popover" role="dialog" aria-label="Submit review">
          <div className="submit-popover__header">
            <span>Overall summary</span>
            {savedAt && <span className="summary__saved">Saved</span>}
          </div>
          <textarea
            ref={textareaRef}
            className="summary__textarea submit-popover__textarea"
            value={value}
            rows={8}
            placeholder="Optional high-level feedback (markdown supported)"
            onChange={(e) => handleChange(e.target.value)}
            onBlur={() => flushSave()}
          />
          <div className="submit-popover__footer">
            <span className="submit-popover__hint">
              {canSubmit ? "" : "Add a comment or summary first"}
            </span>
            <button
              type="button"
              className="primary"
              onClick={() => {
                flushSave();
                void onSubmit();
              }}
              disabled={busy || !canSubmit}
            >
              Submit
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
