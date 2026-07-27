/**
 * 3dskydb Cloudflare Worker API
 *
 * Thin REST layer between the Python scrapers and D1.
 * Free-tier safe: only simple SQL queries, no heavy computation.
 *
 * Endpoints:
 *   POST /api/models/seed    — batch-insert slugs from sitemaps
 *   POST /api/models/detail  — upsert full model detail + children
 *   POST /api/models/next    — get next batch of unfetched slugs
 *   GET  /api/stats          — row counts
 */

export interface Env {
  DB: D1Database;
  API_KEY: string;
  ADMIN_API_KEY: string;
}

// ── Auth ────────────────────────────────────────────────────────────

function requireAuth(request: Request, env: Env): Response | null {
  const auth = request.headers.get("Authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : auth;
  // Accept either the read API_KEY or the ADMIN_API_KEY
  if (token !== env.API_KEY && token !== env.ADMIN_API_KEY) {
    return Response.json({ success: false, error: "unauthorized" }, { status: 401 });
  }
  return null; // ok
}

// ── Router ──────────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // Auth only on write/admin /api/ routes (POST, PUT, DELETE). GET is public.
    if (path.startsWith("/api/") && request.method !== "GET" && request.method !== "OPTIONS") {
      const authError = requireAuth(request, env);
      if (authError) return authError;
    }

    // CORS preflight
    if (request.method === "OPTIONS") {
      return handleCORS(request);
    }

    // Health check (no auth)
    if (path === "/" || path === "/health") {
      return corsHeaders(Response.json({ ok: true, db: "3dskydb" }));
    }

    // ── POST /api/models/seed — batch-insert slugs ──
    if (path === "/api/models/seed" && request.method === "POST") {
      return corsHeaders(await handleSeed(request, env));
    }

    // ── POST /api/models/next — get unfetched slugs ──
    if (path === "/api/models/next" && request.method === "POST") {
      return corsHeaders(await handleNext(request, env));
    }

    // ── POST /api/models/detail — upsert full detail ──
    if (path === "/api/models/detail" && request.method === "POST") {
      return corsHeaders(await handleDetail(request, env));
    }

    // ── POST /api/models/bulk — upsert many models at once ──
    if (path === "/api/models/bulk" && request.method === "POST") {
      return corsHeaders(await handleBulk(request, env));
    }

    // ── POST /api/models/exists — check which slugs exist ──
    if (path === "/api/models/exists" && request.method === "POST") {
      return corsHeaders(await handleExists(request, env));
    }

    // ── GET /api/stats ──
    if (path === "/api/stats" && request.method === "GET") {
      return corsHeaders(await handleStats(env));
    }

    // ── GET /api/models — public: paginated model list ──
    if (path === "/api/models" && request.method === "GET") {
      return corsHeaders(await handleListModels(request, env));
    }

    // ── GET /api/models/:slug — public: single model detail ──
    if (path.startsWith("/api/models/") && request.method === "GET") {
      const slug = path.split("/api/models/")[1];
      if (slug && !slug.includes("/")) {
        return corsHeaders(await handleGetModel(slug, env));
      }
    }

    // ── GET /api/categories — public: distinct categories ──
    if (path === "/api/categories" && request.method === "GET") {
      return corsHeaders(await handleCategories(env));
    }

    // ── POST /api/proxy — forward request to 3dsky.org (bypass GH IP block) ──
    if (path === "/api/proxy" && request.method === "POST") {
      return corsHeaders(await handleProxy(request, env));
    }

    return corsHeaders(Response.json({ success: false, error: "not found" }, { status: 404 }));
  },
};

// ── Handlers ────────────────────────────────────────────────────────

/** POST /api/models/seed — body: { slugs: string[] } */
async function handleSeed(request: Request, env: Env): Promise<Response> {
  try {
    const { slugs } = (await request.json()) as { slugs: string[] };
    if (!Array.isArray(slugs) || slugs.length === 0) {
      return Response.json({ success: false, error: "slugs array required" }, { status: 400 });
    }

    // D1 batch limit is 100 statements per call — chunk if needed
    const D1_BATCH_MAX = 100;
    const stmt = env.DB.prepare("INSERT OR IGNORE INTO model (slug) VALUES (?)");
    let inserted = 0;

    for (let i = 0; i < slugs.length; i += D1_BATCH_MAX) {
      const chunk = slugs.slice(i, i + D1_BATCH_MAX);
      const batch = chunk.map((s) => stmt.bind(s));
      const results = await env.DB.batch(batch);
      inserted += results.filter((r) => r.meta.rows_written > 0).length;
    }

    return Response.json({ success: true, received: slugs.length, inserted });
  } catch (e: any) {
    return Response.json({ success: false, error: e.message }, { status: 500 });
  }
}

/** POST /api/models/next — body: { limit?: number } → { slugs: string[] } */
async function handleNext(request: Request, env: Env): Promise<Response> {
  try {
    const { limit } = (await request.json()) as { limit?: number };
    const take = Math.min(limit ?? 500, 1000);

    const result = await env.DB.prepare(
      "SELECT slug FROM model WHERE detail_fetched = 0 ORDER BY id LIMIT ?"
    )
      .bind(take)
      .all<{ slug: string }>();

    return Response.json({ success: true, slugs: result.results.map((r) => r.slug) });
  } catch (e: any) {
    return Response.json({ success: false, error: e.message }, { status: 500 });
  }
}

/** POST /api/models/detail — full upsert with child records */
async function handleDetail(request: Request, env: Env): Promise<Response> {
  try {
    const body = (await request.json()) as ModelDetailPayload;
    const { slug } = body;
    if (!slug) {
      return Response.json({ success: false, error: "slug required" }, { status: 400 });
    }

    const statements = buildModelStatements(body, env);
    await env.DB.batch(statements);

    return Response.json({ success: true, slug });
  } catch (e: any) {
    return Response.json({ success: false, error: e.message }, { status: 500 });
  }
}

/** POST /api/models/bulk — body: { models: ModelDetailPayload[] } */
async function handleBulk(request: Request, env: Env): Promise<Response> {
  try {
    const { models } = (await request.json()) as { models: ModelDetailPayload[] };
    if (!Array.isArray(models) || models.length === 0) {
      return Response.json({ success: false, error: "models array required" }, { status: 400 });
    }

    let succeeded = 0;
    let failed = 0;
    const errors: string[] = [];

    for (const body of models) {
      try {
        const statements = buildModelStatements(body, env);
        await env.DB.batch(statements);
        succeeded++;
      } catch (e: any) {
        failed++;
        errors.push(`${body.slug}: ${e.message}`);
      }
    }

    return Response.json({ success: true, received: models.length, succeeded, failed, errors: errors.slice(0, 10) });
  } catch (e: any) {
    return Response.json({ success: false, error: e.message }, { status: 500 });
  }
}

/** Build D1 batch statements for a single model upsert */
function buildModelStatements(body: ModelDetailPayload, env: Env): D1PreparedStatement[] {
  const statements: D1PreparedStatement[] = [];
  const { slug } = body;

  // 1. Ensure row exists, then update
  statements.push(
    env.DB.prepare("INSERT OR IGNORE INTO model (slug) VALUES (?1)").bind(slug)
  );
  statements.push(
    env.DB.prepare(`
      UPDATE model SET
        title = ?1, title_en = ?2, description = ?3, description_en = ?4,
        type = ?5, type_text = ?6, style = ?7, style_en = ?8,
        price = ?9, price_usd = ?10, polygons = ?11, size_kb = ?12,
        length_cm = ?13, width_cm = ?14, height_cm = ?15,
        platform = ?16, platform_en = ?17, render = ?18,
        category_slug = ?19, category_title = ?20, category_title_en = ?21,
        subcategory_slug = ?22, subcategory_title = ?23, subcategory_title_en = ?24,
        form_id = ?25, form_title = ?26, form_title_en = ?27,
        is_created_with_ai = ?28, version = ?29, created_at = ?30,
        detail_fetched = 1, detail_fetched_at = datetime('now')
      WHERE slug = ?31
    `).bind(
      body.title ?? null, body.title_en ?? null,
      body.description ?? null, body.description_en ?? null,
      body.type ?? null, body.type_text ?? null,
      body.style ?? null, body.style_en ?? null,
      body.price ?? null, body.price_usd ?? null,
      body.polygons ?? null, body.size_kb ?? null,
      body.length_cm ?? null, body.width_cm ?? null, body.height_cm ?? null,
      body.platform ?? null, body.platform_en ?? null, body.render ?? null,
      body.category_slug ?? null, body.category_title ?? null, body.category_title_en ?? null,
      body.subcategory_slug ?? null, body.subcategory_title ?? null, body.subcategory_title_en ?? null,
      body.form_id ?? null, body.form_title ?? null, body.form_title_en ?? null,
      body.is_created_with_ai ? 1 : 0,
      body.version ?? null, body.created_at ?? null,
      slug
    )
  );

  // 2. Images
  statements.push(
    env.DB.prepare("DELETE FROM model_image WHERE model_id = (SELECT id FROM model WHERE slug = ?1)").bind(slug)
  );
  for (const img of body.images ?? []) {
    statements.push(
      env.DB.prepare(
        "INSERT INTO model_image (model_id, web_path, sort) VALUES ((SELECT id FROM model WHERE slug = ?1), ?2, ?3)"
      ).bind(slug, img.web_path, img.sort ?? 0)
    );
  }

  // 3. Materials
  statements.push(
    env.DB.prepare("DELETE FROM model_material WHERE model_id = (SELECT id FROM model WHERE slug = ?1)").bind(slug)
  );
  for (const mat of body.materials ?? []) {
    statements.push(
      env.DB.prepare(
        "INSERT INTO model_material (model_id, material, material_en) VALUES ((SELECT id FROM model WHERE slug = ?1), ?2, ?3)"
      ).bind(slug, mat.material ?? null, mat.material_en ?? null)
    );
  }

  // 4. Colors
  statements.push(
    env.DB.prepare("DELETE FROM model_color WHERE model_id = (SELECT id FROM model WHERE slug = ?1)").bind(slug)
  );
  for (const col of body.colors ?? []) {
    statements.push(
      env.DB.prepare(
        "INSERT INTO model_color (model_id, hex, title, title_en) VALUES ((SELECT id FROM model WHERE slug = ?1), ?2, ?3, ?4)"
      ).bind(slug, col.hex ?? null, col.title ?? null, col.title_en ?? null)
    );
  }

  // 5. Formats
  statements.push(
    env.DB.prepare("DELETE FROM model_format WHERE model_id = (SELECT id FROM model WHERE slug = ?1)").bind(slug)
  );
  for (const fmt of body.formats ?? []) {
    statements.push(
      env.DB.prepare(
        "INSERT INTO model_format (model_id, title) VALUES ((SELECT id FROM model WHERE slug = ?1), ?2)"
      ).bind(slug, fmt.title ?? null)
    );
  }

  // 6. Tags
  statements.push(
    env.DB.prepare("DELETE FROM model_tag WHERE model_id = (SELECT id FROM model WHERE slug = ?1)").bind(slug)
  );
  for (const tag of body.tags ?? []) {
    const tagTitle = tag.title;
    if (!tagTitle) continue;
    statements.push(
      env.DB.prepare("INSERT OR IGNORE INTO tag (title, multiple) VALUES (?1, ?2)").bind(tagTitle, tag.multiple ?? 1)
    );
    statements.push(
      env.DB.prepare(
        "INSERT OR IGNORE INTO model_tag (model_id, tag_id) VALUES ((SELECT id FROM model WHERE slug = ?1), (SELECT id FROM tag WHERE title = ?2))"
      ).bind(slug, tagTitle)
    );
  }

  return statements;
}

/** POST /api/models/exists — body: { slugs: string[] } → { existing: string[] } */
async function handleExists(request: Request, env: Env): Promise<Response> {
  try {
    const { slugs } = (await request.json()) as { slugs: string[] };
    if (!Array.isArray(slugs) || slugs.length === 0) {
      return Response.json({ success: false, error: "slugs array required" }, { status: 400 });
    }

    // D1 doesn't support WHERE slug IN (?,?,?) with dynamic length well,
    // so we query one at a time. For small batches this is fine.
    const existing: string[] = [];
    const stmt = env.DB.prepare("SELECT 1 FROM model WHERE slug = ?1 LIMIT 1");
    for (const slug of slugs) {
      const row = await stmt.bind(slug).first();
      if (row) existing.push(slug);
    }

    return Response.json({ success: true, existing });
  } catch (e: any) {
    return Response.json({ success: false, error: e.message }, { status: 500 });
  }
}

/** GET /api/stats */
async function handleStats(env: Env): Promise<Response> {
  try {
    const total = await env.DB.prepare("SELECT COUNT(*) as c FROM model").first<{ c: number }>();
    const fetched = await env.DB.prepare("SELECT COUNT(*) as c FROM model WHERE detail_fetched = 1").first<{ c: number }>();
    const errors = await env.DB.prepare("SELECT COUNT(*) as c FROM scrape_errors").first<{ c: number }>();
    const images = await env.DB.prepare("SELECT COUNT(*) as c FROM model_image").first<{ c: number }>();
    const tags = await env.DB.prepare("SELECT COUNT(*) as c FROM tag").first<{ c: number }>();

    return Response.json({
      success: true,
      total_models: total?.c ?? 0,
      detail_fetched: fetched?.c ?? 0,
      detail_pending: (total?.c ?? 0) - (fetched?.c ?? 0),
      scrape_errors: errors?.c ?? 0,
      total_images: images?.c ?? 0,
      total_tags: tags?.c ?? 0,
    });
  } catch (e: any) {
    return Response.json({ success: false, error: e.message }, { status: 500 });
  }
}

// ── Types ───────────────────────────────────────────────────────────

interface ModelDetailPayload {
  slug: string;
  title?: string | null;
  title_en?: string | null;
  description?: string | null;
  description_en?: string | null;
  type?: number | null;
  type_text?: string | null;
  style?: string | null;
  style_en?: string | null;
  price?: number | null;
  price_usd?: number | null;
  polygons?: number | null;
  size_kb?: number | null;
  length_cm?: number | null;
  width_cm?: number | null;
  height_cm?: number | null;
  platform?: string | null;
  platform_en?: string | null;
  render?: string | null;
  category_slug?: string | null;
  category_title?: string | null;
  category_title_en?: string | null;
  subcategory_slug?: string | null;
  subcategory_title?: string | null;
  subcategory_title_en?: string | null;
  form_id?: number | null;
  form_title?: string | null;
  form_title_en?: string | null;
  is_created_with_ai?: boolean;
  version?: string | null;
  created_at?: string | null;
  images?: { web_path: string; sort?: number }[];
  materials?: { material?: string | null; material_en?: string | null }[];
  colors?: { hex?: string | null; title?: string | null; title_en?: string | null }[];
  formats?: { title?: string | null }[];
  tags?: { title: string; multiple?: number }[];
}

// ── CORS ────────────────────────────────────────────────────────────

/** POST /api/proxy — forward request to 3dsky.org (bypasses GH IP block) */
async function handleProxy(request: Request, env: Env): Promise<Response> {
  try {
    const { url, method, headers: reqHeaders, body: reqBody } = await request.json() as {
      url: string;
      method?: string;
      headers?: Record<string, string>;
      body?: any;
    };
    if (!url) {
      return Response.json({ success: false, error: "url required" }, { status: 400 });
    }

    // Only allow proxying to 3dsky.org domains
    const target = new URL(url);
    if (!target.hostname.endsWith("3dsky.org")) {
      return Response.json({ success: false, error: "only 3dsky.org targets allowed" }, { status: 403 });
    }

    const fetchInit: RequestInit = {
      method: method || "GET",
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; 3dskydb-proxy/1.0)",
        "Content-Type": "application/json",
        ...(reqHeaders || {}),
      },
    };

    if (reqBody && method !== "GET") {
      fetchInit.body = JSON.stringify(reqBody);
    }

    const resp = await fetch(url, fetchInit);
    const text = await resp.text();

    return Response.json({
      success: resp.ok,
      status: resp.status,
      body: text,
    });
  } catch (e: any) {
    return Response.json({ success: false, error: e.message }, { status: 500 });
  }
}

// ── CORS ────────────────────────────────────────────────────────────

const ALLOW_ORIGIN = "*"; // Public API — open to any frontend

function corsHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", ALLOW_ORIGIN);
  headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Authorization, Content-Type");
  headers.set("Access-Control-Max-Age", "86400");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function handleCORS(request: Request): Response {
  // Mirror the request's origin if present, otherwise allow all
  const origin = request.headers.get("Origin") || ALLOW_ORIGIN;
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Authorization, Content-Type",
      "Access-Control-Max-Age": "86400",
    },
  });
}

// ── Public listing endpoints ────────────────────────────────────────

/** GET /api/models — paginated list with optional search & category filter */
async function handleListModels(request: Request, env: Env): Promise<Response> {
  try {
    const url = new URL(request.url);
    const page = Math.max(1, parseInt(url.searchParams.get("page") || "1"));
    const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get("limit") || "24")));
    const search = (url.searchParams.get("search") || "").trim();
    const category = (url.searchParams.get("category") || "").trim();
    const offset = (page - 1) * limit;

    // Build WHERE clause with numbered params — show ALL models, not just fetched ones
    const conditions: string[] = [];
    const values: any[] = [];

    if (search) {
      values.push(`%${search}%`);
      conditions.push(`(title LIKE ?${values.length} OR title_en LIKE ?${values.length} OR slug LIKE ?${values.length})`);
    }
    if (category) {
      values.push(category);
      conditions.push(`category_slug = ?${values.length}`);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    // Count total matching — only bind if there are values
    let countSql = `SELECT COUNT(*) as c FROM model ${where}`;
    const countRow = values.length > 0
      ? await env.DB.prepare(countSql).bind(...values).first<{ c: number }>()
      : await env.DB.prepare(countSql).first<{ c: number }>();
    const total = countRow?.c ?? 0;

    // Fetch page — LIMIT/OFFSET are integer literals (safe from injection since we parseInt them)
    const sql = `SELECT id, slug, title, title_en, type_text, price_usd, polygons,
                        category_slug, category_title, category_title_en,
                        subcategory_title, subcategory_title_en,
                        platform, render, created_at, slug_seeded_at
                 FROM model ${where}
                 ORDER BY COALESCE(version, created_at, slug_seeded_at) DESC
                 LIMIT ${limit} OFFSET ${offset}`;

    const rows = values.length > 0
      ? await env.DB.prepare(sql).bind(...values).all<ModelListRow>()
      : await env.DB.prepare(sql).all<ModelListRow>();

    // Get first image for each model in this page
    const modelIds = rows.results.map((r) => r.id);
    const imagesMap = await getFirstImages(env, modelIds);

    const models = rows.results.map((r) => ({
      ...r,
      first_image: imagesMap.get(r.id) ?? null,
    }));

    return Response.json({
      success: true,
      models,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (e: any) {
    return Response.json({ success: false, error: e.message }, { status: 500 });
  }
}

/** GET /api/models/:slug — full model detail with children (works even without detail_fetched) */
async function handleGetModel(slug: string, env: Env): Promise<Response> {
  try {
    const model = await env.DB.prepare(
      `SELECT * FROM model WHERE slug = ?1`
    ).bind(slug).first<ModelRow>();

    if (!model) {
      return Response.json({ success: false, error: "not found" }, { status: 404 });
    }

    // Fetch children in parallel
    const [images, materials, colors, formats, tags] = await Promise.all([
      env.DB.prepare("SELECT web_path, sort FROM model_image WHERE model_id = ?1 ORDER BY sort").bind(model.id).all<{ web_path: string; sort: number }>(),
      env.DB.prepare("SELECT material, material_en FROM model_material WHERE model_id = ?1").bind(model.id).all<{ material: string | null; material_en: string | null }>(),
      env.DB.prepare("SELECT hex, title, title_en FROM model_color WHERE model_id = ?1").bind(model.id).all<{ hex: string | null; title: string | null; title_en: string | null }>(),
      env.DB.prepare("SELECT title FROM model_format WHERE model_id = ?1").bind(model.id).all<{ title: string | null }>(),
      env.DB.prepare(
        "SELECT t.title, t.multiple FROM tag t INNER JOIN model_tag mt ON mt.tag_id = t.id WHERE mt.model_id = ?1"
      ).bind(model.id).all<{ title: string; multiple: number }>(),
    ]);

    return Response.json({
      success: true,
      model: {
        ...model,
        images: images.results,
        materials: materials.results,
        colors: colors.results,
        formats: formats.results,
        tags: tags.results,
      },
    });
  } catch (e: any) {
    return Response.json({ success: false, error: e.message }, { status: 500 });
  }
}

/** GET /api/categories — distinct categories with counts */
async function handleCategories(env: Env): Promise<Response> {
  try {
    const rows = await env.DB.prepare(
      `SELECT category_slug, category_title, category_title_en, COUNT(*) as count
       FROM model WHERE category_slug IS NOT NULL
       GROUP BY category_slug
       ORDER BY count DESC`
    ).all<{ category_slug: string; category_title: string | null; category_title_en: string | null; count: number }>();

    return Response.json({ success: true, categories: rows.results });
  } catch (e: any) {
    return Response.json({ success: false, error: e.message }, { status: 500 });
  }
}

/** Get first image (lowest sort) for each model id */
async function getFirstImages(env: Env, modelIds: number[]): Promise<Map<number, string>> {
  if (modelIds.length === 0) return new Map();
  const map = new Map<number, string>();
  // D1 doesn't support WHERE model_id IN (...) with dynamic lists well,
  // so query per model. For page sizes ≤100 this is fine.
  const stmt = env.DB.prepare(
    "SELECT web_path FROM model_image WHERE model_id = ?1 ORDER BY sort LIMIT 1"
  );
  for (const id of modelIds) {
    const row = await stmt.bind(id).first<{ web_path: string }>();
    if (row) map.set(id, row.web_path);
  }
  return map;
}

// ── Row types ───────────────────────────────────────────────────────

interface ModelListRow {
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
}

interface ModelRow {
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
}
