import { useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { fetchCategories } from '../api';
import type { Category } from '../types';

export default function Sidebar() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [categories, setCategories] = useState<Category[]>([]);
  const currentCategory = searchParams.get('category') || '';

  useEffect(() => {
    fetchCategories()
      .then((d) => { if (d.success) setCategories(d.categories); })
      .catch(() => {});
  }, []);

  function selectCategory(slug: string) {
    const next = new URLSearchParams(searchParams);
    if (slug) {
      next.set('category', slug);
      next.set('page', '1');
    } else {
      next.delete('category');
    }
    setSearchParams(next);
  }

  return (
    <aside className="w-56 bg-white border-r border-gray-200 pt-4 pb-8 flex-shrink-0 hidden md:block">
      <nav className="px-3">
        <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-2 px-2">
          Categories
        </h3>
        <ul className="space-y-0.5">
          <li>
            <button
              onClick={() => selectCategory('')}
              className={`w-full text-left px-2 py-1.5 text-sm rounded transition-colors ${
                !currentCategory
                  ? 'bg-cyan-50 text-cyan-700 font-medium'
                  : 'text-gray-600 hover:bg-gray-100'
              }`}
            >
              All models
            </button>
          </li>
          {categories.map((cat) => (
            <li key={cat.category_slug}>
              <button
                onClick={() => selectCategory(cat.category_slug)}
                className={`w-full text-left px-2 py-1.5 text-sm rounded transition-colors flex justify-between ${
                  currentCategory === cat.category_slug
                    ? 'bg-cyan-50 text-cyan-700 font-medium'
                    : 'text-gray-600 hover:bg-gray-100'
                }`}
              >
                <span>{cat.category_title_en || cat.category_title}</span>
                <span className="text-gray-400 text-xs">{cat.count}</span>
              </button>
            </li>
          ))}
        </ul>
      </nav>
    </aside>
  );
}
