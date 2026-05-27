import type { DiffSource } from "../cli/types";

interface Props {
  sources: DiffSource[];
  current: string;
  onChange: (id: string) => void;
}

export function DiffSourcePicker({ sources, current, onChange }: Props) {
  return (
    <label className="picker">
      <span className="picker__label">Diff:</span>
      <select className="picker__select" value={current} onChange={(e) => onChange(e.target.value)}>
        {sources.map((s) => (
          <option key={s.id} value={s.id}>
            {s.label}
          </option>
        ))}
      </select>
    </label>
  );
}
