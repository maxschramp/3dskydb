import type {
  ListResponse,
  DetailResponse,
  CategoriesResponse,
} from './types';

const API_BASE = 'https://3dskydb-api.maxschramp.workers.dev';

async function fetchJSON<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${res.statusText}`);
  }
  return res.json();
}

export async function fetchModels(params: {
  page?: number;
  limit?: number;
  search?: string;
  category?: string;
}): Promise<ListResponse> {
  const searchParams = new URLSearchParams();
  if (params.page) searchParams.set('page', String(params.page));
  if (params.limit) searchParams.set('limit', String(params.limit));
  if (params.search) searchParams.set('search', params.search);
  if (params.category) searchParams.set('category', params.category);

  return fetchJSON<ListResponse>(
    `${API_BASE}/api/models?${searchParams.toString()}`
  );
}

export async function fetchModel(slug: string): Promise<DetailResponse> {
  return fetchJSON<DetailResponse>(`${API_BASE}/api/models/${slug}`);
}

export async function fetchCategories(): Promise<CategoriesResponse> {
  return fetchJSON<CategoriesResponse>(`${API_BASE}/api/categories`);
}

/** Build a CDN URL for a model preview image */
export function imageUrl(webPath: string | null): string | null {
  if (!webPath) return null;
  return `https://b4.3dsky.org/media/cache/models-list-webp/${webPath}`;
}

/** Build the 3dsky.org product page URL */
export function modelPageUrl(slug: string): string {
  return `https://3dsky.org/3dmodels/show/${slug}`;
}
