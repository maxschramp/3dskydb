import type { Pagination } from '../types';

interface Props {
  pagination: Pagination;
  onPage: (page: number) => void;
}

export default function PaginationBar({ pagination, onPage }: Props) {
  const { page, totalPages } = pagination;

  // Build page number list with ellipsis
  const pages: (number | '...')[] = [];
  const delta = 2; // pages to show around current
  for (let i = 1; i <= totalPages; i++) {
    if (
      i === 1 ||
      i === totalPages ||
      (i >= page - delta && i <= page + delta)
    ) {
      pages.push(i);
    } else if (pages[pages.length - 1] !== '...') {
      pages.push('...');
    }
  }

  return (
    <div className="flex items-center justify-center gap-1 mt-8">
      <button
        onClick={() => onPage(page - 1)}
        disabled={page <= 1}
        className="px-3 py-1.5 text-sm text-gray-500 hover:text-gray-700
                   disabled:opacity-30 disabled:cursor-not-allowed"
      >
        &larr; Prev
      </button>

      {pages.map((p, i) =>
        p === '...' ? (
          <span key={`ellipsis-${i}`} className="px-2 text-gray-300 text-sm">
            &hellip;
          </span>
        ) : (
          <button
            key={p}
            onClick={() => onPage(p)}
            className={`w-8 h-8 text-sm rounded transition-colors ${
              p === page
                ? 'bg-cyan-600 text-white font-medium'
                : 'text-gray-500 hover:text-gray-700 hover:bg-gray-100'
            }`}
          >
            {p}
          </button>
        )
      )}

      <button
        onClick={() => onPage(page + 1)}
        disabled={page >= totalPages}
        className="px-3 py-1.5 text-sm text-gray-500 hover:text-gray-700
                   disabled:opacity-30 disabled:cursor-not-allowed"
      >
        Next &rarr;
      </button>
    </div>
  );
}
