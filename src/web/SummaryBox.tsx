import { useEffect, useRef, useState } from "react";

interface Props {
  initialValue: string;
  onSave: (value: string) => Promise<void>;
}

export function SummaryBox({ initialValue, onSave }: Props) {
  const [value, setValue] = useState(initialValue);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const debounce = useRef<number | undefined>(undefined);

  useEffect(() => setValue(initialValue), [initialValue]);

  function handleChange(next: string) {
    setValue(next);
    if (debounce.current) window.clearTimeout(debounce.current);
    debounce.current = window.setTimeout(() => {
      void onSave(next).then(() => setSavedAt(Date.now()));
    }, 600);
  }

  return (
    <aside className="summary">
      <div className="summary__header">
        <h3>Overall summary</h3>
        {savedAt && <span className="summary__saved">Saved</span>}
      </div>
      <textarea
        className="summary__textarea"
        value={value}
        rows={10}
        placeholder="Optional high-level feedback (markdown supported)"
        onChange={(e) => handleChange(e.target.value)}
        onBlur={() => {
          if (debounce.current) window.clearTimeout(debounce.current);
          void onSave(value).then(() => setSavedAt(Date.now()));
        }}
      />
    </aside>
  );
}
