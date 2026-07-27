import type { Category } from '../types';

interface Props {
  categories: Category[];
  selected: string;
  onChange: (slug: string) => void;
}

export default function CategoryFilter({ categories, selected, onChange }: Props) {
  return (
    <select
      value={selected}
      onChange={(e) => onChange(e.target.value)}
      className="bg-white border border-gray-300 rounded-lg px-3 py-2 text-sm
                 text-gray-700 focus:outline-none focus:border-cyan-500 focus:ring-1 focus:ring-cyan-500
                 min-w-[180px]"
    >
      <option value="">All categories</option>
      {categories.map((cat) => (
        <option key={cat.category_slug} value={cat.category_slug}>
          {cat.category_title_en || cat.category_title} ({cat.count})
        </option>
      ))}
    </select>
  );
}
