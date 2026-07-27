/** Model as returned by GET /api/models (list view) */
export interface ModelSummary {
  id: number;
  slug: string;
  title: string | null;
  title_en: string | null;
  type_text: string | null;
  price_usd: number | null;
  polygons: number | null;
  category_slug: string | null;
  category_title: string | null;
  category_title_en: string | null;
  subcategory_title: string | null;
  subcategory_title_en: string | null;
  platform: string | null;
  render: string | null;
  created_at: string | null;
  slug_seeded_at: string | null;
  first_image: string | null;
}

/** Full model detail from GET /api/models/:slug */
export interface ModelDetail {
  id: number;
  slug: string;
  title: string | null;
  title_en: string | null;
  description: string | null;
  description_en: string | null;
  type: number | null;
  type_text: string | null;
  style: string | null;
  style_en: string | null;
  price: number | null;
  price_usd: number | null;
  polygons: number | null;
  vertices: number | null;
  size_kb: number | null;
  length_cm: number | null;
  width_cm: number | null;
  height_cm: number | null;
  platform: string | null;
  platform_en: string | null;
  render: string | null;
  category_slug: string | null;
  category_title: string | null;
  category_title_en: string | null;
  subcategory_slug: string | null;
  subcategory_title: string | null;
  subcategory_title_en: string | null;
  form_id: number | null;
  form_title: string | null;
  form_title_en: string | null;
  is_created_with_ai: number | null;
  version: string | null;
  created_at: string | null;
  slug_seeded_at: string | null;
  detail_fetched_at: string | null;
  images: ModelImage[];
  materials: ModelMaterial[];
  colors: ModelColor[];
  formats: ModelFormat[];
  tags: ModelTag[];
}

export interface ModelImage {
  web_path: string;
  sort: number;
}

export interface ModelMaterial {
  material: string | null;
  material_en: string | null;
}

export interface ModelColor {
  hex: string | null;
  title: string | null;
  title_en: string | null;
}

export interface ModelFormat {
  title: string | null;
}

export interface ModelTag {
  title: string;
  multiple: number;
}

export interface Category {
  category_slug: string;
  category_title: string | null;
  category_title_en: string | null;
  count: number;
}

export interface Pagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export interface ListResponse {
  success: boolean;
  models: ModelSummary[];
  pagination: Pagination;
  error?: string;
}

export interface DetailResponse {
  success: boolean;
  model: ModelDetail;
  error?: string;
}

export interface CategoriesResponse {
  success: boolean;
  categories: Category[];
  error?: string;
}
