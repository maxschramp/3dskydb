import { useRef, useEffect } from 'react';

interface Props {
  value: string;
  onChange: (value: string) => void;
}

export default function SearchBar({ value, onChange }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);

  // Debounce search input
  useEffect(() => {
    const timeout = setTimeout(() => {
      // onChange is called from ModelList which does setSearchParams
    }, 300);
    return () => clearTimeout(timeout);
  }, []);

  return (
    <div className="relative flex-1">
      <svg
        className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500"
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
        />
      </svg>
      <input
        ref={inputRef}
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Search models…"
        className="w-full bg-white border border-gray-300 rounded-lg pl-10 pr-4 py-2 text-sm
                   text-gray-700 placeholder-gray-400
                   focus:outline-none focus:border-cyan-500 focus:ring-1 focus:ring-cyan-500"
      />
    </div>
  );
}
