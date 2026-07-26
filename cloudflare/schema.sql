-- 3dskydb D1 Schema
-- Run: npx wrangler d1 execute 3dskydb --file=cloudflare/schema.sql

-- ── Core model table ──
CREATE TABLE IF NOT EXISTS model (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    slug            TEXT NOT NULL UNIQUE,
    title           TEXT,
    title_en        TEXT,
    description     TEXT,
    description_en  TEXT,
    type            INTEGER,            -- 1=free, 2=pro
    type_text       TEXT,               -- 'free','pro'
    style           TEXT,
    style_en        TEXT,
    price           INTEGER,            -- internal currency (RUB?)
    price_usd       REAL,
    polygons        INTEGER,
    vertices        INTEGER,
    size_kb         INTEGER,
    length_cm       REAL,
    width_cm        REAL,
    height_cm       REAL,
    platform        TEXT,               -- denormalized, e.g. '3dsMax 2017 + obj'
    platform_en     TEXT,
    render          TEXT,               -- denormalized, e.g. 'Vray+Corona'
    category_slug   TEXT,
    category_title  TEXT,
    category_title_en TEXT,
    subcategory_slug TEXT,
    subcategory_title TEXT,
    subcategory_title_en TEXT,
    form_id         INTEGER,
    form_title      TEXT,
    form_title_en   TEXT,
    is_created_with_ai INTEGER DEFAULT 0,
    version         TEXT,               -- datetime
    created_at      TEXT,               -- datetime
    -- fetch state
    slug_seeded_at  TEXT DEFAULT (datetime('now')),
    detail_fetched  INTEGER DEFAULT 0,
    detail_fetched_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_model_slug ON model(slug);
CREATE INDEX IF NOT EXISTS idx_model_category ON model(category_slug);
CREATE INDEX IF NOT EXISTS idx_model_detail_fetched ON model(detail_fetched);

-- ── Tags ──
CREATE TABLE IF NOT EXISTS tag (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    title   TEXT NOT NULL UNIQUE,
    multiple INTEGER DEFAULT 1
);

-- ── Model <-> Tag M:N ──
CREATE TABLE IF NOT EXISTS model_tag (
    model_id INTEGER NOT NULL REFERENCES model(id) ON DELETE CASCADE,
    tag_id   INTEGER NOT NULL REFERENCES tag(id) ON DELETE CASCADE,
    PRIMARY KEY (model_id, tag_id)
);
CREATE INDEX IF NOT EXISTS idx_model_tag_tag ON model_tag(tag_id);

-- ── Model images (lightweight refs, images stay local) ──
CREATE TABLE IF NOT EXISTS model_image (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    model_id    INTEGER NOT NULL REFERENCES model(id) ON DELETE CASCADE,
    web_path    TEXT NOT NULL,
    sort        INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_model_image_model ON model_image(model_id);

-- ── Materials (denormalized list per model) ──
CREATE TABLE IF NOT EXISTS model_material (
    model_id    INTEGER NOT NULL REFERENCES model(id) ON DELETE CASCADE,
    material    TEXT,
    material_en TEXT
);
CREATE INDEX IF NOT EXISTS idx_model_material_model ON model_material(model_id);

-- ── Colors (denormalized per model) ──
CREATE TABLE IF NOT EXISTS model_color (
    model_id    INTEGER NOT NULL REFERENCES model(id) ON DELETE CASCADE,
    hex         TEXT,
    title       TEXT,
    title_en    TEXT
);
CREATE INDEX IF NOT EXISTS idx_model_color_model ON model_color(model_id);

-- ── File formats (denormalized per model) ──
CREATE TABLE IF NOT EXISTS model_format (
    model_id INTEGER NOT NULL REFERENCES model(id) ON DELETE CASCADE,
    title    TEXT
);
CREATE INDEX IF NOT EXISTS idx_model_format_model ON model_format(model_id);

-- ── Scrape errors ──
CREATE TABLE IF NOT EXISTS scrape_errors (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    slug       TEXT NOT NULL,
    endpoint   TEXT,
    error      TEXT,
    created_at TEXT DEFAULT (datetime('now'))
);

-- ── Scrape metadata ──
CREATE TABLE IF NOT EXISTS scrape_meta (
    key   TEXT PRIMARY KEY,
    value TEXT
);
