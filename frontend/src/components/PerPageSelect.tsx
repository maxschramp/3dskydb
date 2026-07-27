interface Props {
  value: number;
  onChange: (value: string) => void;
}

const OPTIONS = [12, 24, 48, 96];

export default function PerPageSelect({ value, onChange }: Props) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="text-xs text-gray-400 bg-transparent border border-gray-200 rounded px-2 py-1
                 focus:outline-none focus:border-cyan-500 cursor-pointer"
    >
      {OPTIONS.map((n) => (
        <option key={n} value={n}>
          {n} per page
        </option>
      ))}
    </select>
  );
}

