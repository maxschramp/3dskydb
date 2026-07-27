import { useState, useEffect, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { fetchModels } from '../api';
import type { ModelSummary, Pagination } from '../types';
import ModelCard from '../components/ModelCard';
import PaginationBar from '../components/PaginationBar';
import PerPageSelect from '../components/PerPageSelect';

export default function ModelList() {
  const [searchParams, setSearchParams] = useSearchParams();

  const currentPage = parseInt(searchParams.get('page') || '1');
  const currentLimit = parseInt(searchParams.get('limit') || '25');
  const currentSearch = searchParams.get('search') || '';
  const currentCategory = searchParams.get('category') || '';

  const [models, setModels] = useState<ModelSummary[]>([]);
  const [pagination, setPagination] = useState<Pagination | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchModels({
        page: currentPage,
        limit: currentLimit,
        search: currentSearch || undefined,
        category: currentCategory || undefined,
      });
      if (data.success) {
        setModels(data.models);
        setPagination(data.pagination);
      } else {
        setError(data.error || 'Unknown error');
      }
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [currentPage, currentLimit, currentSearch, currentCategory]);

  useEffect(() => {
    load();
  }, [load]);

  function updateParams(updates: Record<string, string>) {
    const next = new URLSearchParams(searchParams);
    for (const [k, v] of Object.entries(updates)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    if ('limit' in updates) next.set('page', '1');
    setSearchParams(next);
  }

  return (
    <div className="px-4 py-4">
      {/* Header row: count + per-page */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <p className="text-sm text-gray-500">
            <span className="font-semibold text-gray-700">{pagination?.total.toLocaleString() ?? '...'}</span>
            {' '}models found
          </p>
          <select
            defaultValue="newest"
            className="text-sm text-gray-500 bg-transparent border-none cursor-pointer focus:outline-none"
          >
            <option value="newest">Newest</option>
          </select>
        </div>
        <PerPageSelect value={currentLimit} onChange={(v) => updateParams({ limit: v })} />
      </div>

      {/* Error */}
      {error && (
        <div className="bg-red-50 border border-red-300 text-red-700 px-4 py-3 rounded mb-4 text-sm">
          {error}
        </div>
      )}

      {/* Loading skeleton */}
      {loading && (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
          {Array.from({ length: currentLimit }).map((_, i) => (
            <div key={i} className="animate-pulse">
              <div className="aspect-square bg-gray-100" />
              <div className="mt-1.5 space-y-1 px-0.5">
                <div className="h-3.5 bg-gray-100 rounded w-3/4" />
                <div className="h-3 bg-gray-100 rounded w-1/2" />
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Empty */}
      {!loading && models.length === 0 && (
        <div className="text-center py-16 text-gray-400">
          <p className="text-lg">No models found.</p>
          <p className="text-sm mt-1">Try a different category.</p>
        </div>
      )}

      {/* Grid — 3dsky style: no card borders, tight spacing */}
      {!loading && models.length > 0 && (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
            {models.map((m) => (
              <ModelCard key={m.id} model={m} />
            ))}
          </div>

          {pagination && pagination.totalPages > 1 && (
            <PaginationBar
              pagination={pagination}
              onPage={(p) => updateParams({ page: String(p) })}
            />
          )}
        </>
      )}
    </div>
  );
}

