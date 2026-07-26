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

    // Auth on all /api/ routes
    if (path.startsWith("/api/")) {
      const authError = requireAuth(request, env);
      if (authError) return authError;
    }

    // Health check (no auth)
    if (path === "/" || path === "/health") {
      return Response.json({ ok: true, db: "3dskydb" });
    }

    // ── POST /api/models/seed — batch-insert slugs ──
    if (path === "/api/models/seed" && request.method === "POST") {
      return handleSeed(request, env);
    }

    // ── POST /api/models/next — get unfetched slugs ──
    if (path === "/api/models/next" && request.method === "POST") {
      return handleNext(request, env);
    }

    // ── POST /api/models/detail — upsert full detail ──
    if (path === "/api/models/detail" && request.method === "POST") {
      return handleDetail(request, env);
    }

    // ── GET /api/stats ──
    if (path === "/api/stats" && request.method === "GET") {
      return handleStats(env);
    }

    return Response.json({ success: false, error: "not found" }, { status: 404 });
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

    // Build all SQL statements into one batch for atomicity
    const statements: D1PreparedStatement[] = [];

    // 1. Upsert model row
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

    // We need the model id for child tables. D1 doesn't support RETURNING well,
    // so we do a separate query after the update. For the batch, we'll use a
    // subquery approach: delete children by slug-derived subquery, then insert.
    // This avoids needing the integer id in the same transaction.

    // 2. Delete and re-insert images
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

    // 3. Delete and re-insert materials
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

    // 4. Delete and re-insert colors
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

    // 5. Delete and re-insert formats
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

    // 6. Delete and re-insert tags
    statements.push(
      env.DB.prepare("DELETE FROM model_tag WHERE model_id = (SELECT id FROM model WHERE slug = ?1)").bind(slug)
    );
    for (const tag of body.tags ?? []) {
      const tagTitle = tag.title;
      if (!tagTitle) continue;
      // Upsert tag, then link
      statements.push(
        env.DB.prepare("INSERT OR IGNORE INTO tag (title, multiple) VALUES (?1, ?2)").bind(tagTitle, tag.multiple ?? 1)
      );
      statements.push(
        env.DB.prepare(
          "INSERT OR IGNORE INTO model_tag (model_id, tag_id) VALUES ((SELECT id FROM model WHERE slug = ?1), (SELECT id FROM tag WHERE title = ?2))"
        ).bind(slug, tagTitle)
      );
    }

    // Execute entire batch (D1 batches are atomic per https://developers.cloudflare.com/d1/)
    await env.DB.batch(statements);

    return Response.json({ success: true, slug });
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
