"""
3dsky.org Scraper — Step 1: SQLite schema + sitemap seed.

Creates the database, downloads all 24 sitemaps, extracts model slugs,
inserts them, and reports the gap vs the total on the live site.

Rate limit: 1 req / 3 sec.
"""
import sqlite3
import re
import gzip
import io
import time
import sys
import os
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError

DB_PATH = Path(__file__).with_suffix(".db")
SITEMAP_INDEX = "https://3dsky.org/sitemaps/sitemap_index_en.xml"
UA = "Mozilla/5.0 (compatible; 3dskydb-scraper/1.0)"

# ── Rate-limited fetch ──────────────────────────────────────────────
_last_fetch = 0.0
MIN_INTERVAL = 3.0  # seconds between requests

def rate_limited_fetch(url: str, timeout: int = 60) -> bytes:
    global _last_fetch
    elapsed = time.monotonic() - _last_fetch
    if elapsed < MIN_INTERVAL:
        time.sleep(MIN_INTERVAL - elapsed)
    req = Request(url, headers={"User-Agent": UA})
    resp = urlopen(req, timeout=timeout)
    _last_fetch = time.monotonic()
    return resp.read()


# ── DB Schema ───────────────────────────────────────────────────────
def create_schema(conn: sqlite3.Connection):
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.execute("PRAGMA foreign_keys=ON")

    conn.executescript("""
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
        multiple INTEGER DEFAULT 1          -- always 1 in observed API
    );

    -- ── Model <-> Tag M:N ──
    CREATE TABLE IF NOT EXISTS model_tag (
        model_id INTEGER NOT NULL REFERENCES model(id) ON DELETE CASCADE,
        tag_id   INTEGER NOT NULL REFERENCES tag(id) ON DELETE CASCADE,
        PRIMARY KEY (model_id, tag_id)
    );
    CREATE INDEX IF NOT EXISTS idx_model_tag_tag ON model_tag(tag_id);

    -- ── Model images (lightweight refs) ──
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

    -- ── Scrape metadata ──
    CREATE TABLE IF NOT EXISTS scrape_meta (
        key   TEXT PRIMARY KEY,
        value TEXT
    );
    """)
    conn.commit()


# ── Sitemap parsing ─────────────────────────────────────────────────
def extract_model_slugs_from_sitemap_gz(data: bytes) -> list[str]:
    """Parse gzipped sitemap XML, return list of model slugs."""
    buf = io.BytesIO(data)
    with gzip.GzipFile(fileobj=buf) as f:
        content = f.read().decode("utf-8", errors="replace")

    urls = re.findall(r"<loc>\s*(.*?)\s*</loc>", content)
    slugs = []
    for url in urls:
        # Match /3dmodels/show/{slug}
        m = re.search(r"/3dmodels/show/([^/?#]+)", url)
        if m:
            slugs.append(m.group(1))
    return slugs


def parse_sitemap_index(data: bytes) -> list[str]:
    """Extract sitemap .gz URLs from the index XML."""
    content = data.decode("utf-8", errors="replace")
    return re.findall(r"<loc>\s*(.*?\.xml\.gz)\s*</loc>", content)


# ── Main ────────────────────────────────────────────────────────────
def main():
    print("=" * 60)
    print("3dsky.org — Sitemap Seeder")
    print("=" * 60)

    # 1. Create DB
    print(f"\n[1/4] Creating database: {DB_PATH}")
    conn = sqlite3.connect(str(DB_PATH))
    create_schema(conn)

    # 2. Fetch sitemap index
    print(f"\n[2/4] Fetching sitemap index: {SITEMAP_INDEX}")
    index_data = rate_limited_fetch(SITEMAP_INDEX)
    sitemap_urls = parse_sitemap_index(index_data)
    print(f"  Found {len(sitemap_urls)} sitemap files")

    # 3. Download all sitemaps and extract slugs
    print(f"\n[3/4] Downloading sitemaps (rate-limited to 1/{MIN_INTERVAL}s)...")
    all_slugs = []
    for i, sitemap_url in enumerate(sitemap_urls, 1):
        print(f"  [{i}/{len(sitemap_urls)}] {sitemap_url.split('/')[-1]} ...", end=" ", flush=True)
        try:
            data = rate_limited_fetch(sitemap_url)
            slugs = extract_model_slugs_from_sitemap_gz(data)
            all_slugs.extend(slugs)
            print(f"{len(slugs):,} slugs")
        except Exception as e:
            print(f"ERROR: {e}")

    print(f"\n  Total slugs extracted: {len(all_slugs):,}")
    unique_slugs = list(dict.fromkeys(all_slugs))  # dedupe preserving order
    dupes = len(all_slugs) - len(unique_slugs)
    if dupes:
        print(f"  Duplicates removed: {dupes:,}")
        print(f"  Unique slugs: {len(unique_slugs):,}")

    # 4. Insert into DB
    print(f"\n[4/4] Inserting {len(unique_slugs):,} slugs into database...")
    conn.execute("BEGIN")
    inserted = 0
    for slug in unique_slugs:
        try:
            conn.execute(
                "INSERT OR IGNORE INTO model (slug) VALUES (?)",
                (slug,),
            )
            inserted += 1
        except Exception as e:
            print(f"  WARN: {slug}: {e}")
    conn.execute("COMMIT")
    print(f"  Inserted: {inserted:,} new rows")

    # 5. Fetch live total
    print(f"\n[Extra] Fetching live total from API...")
    time.sleep(MIN_INTERVAL)  # ensure rate limit
    try:
        import json
        api_data = rate_limited_fetch("https://3dsky.org/api/models")
        # The API needs a POST, let's do it properly
    except Exception as e:
        print(f"  GET failed: {e}, trying POST...")

    # Use a proper POST via urllib
    try:
        import json
        req = Request(
            "https://3dsky.org/api/models",
            data=b"{}",
            headers={"User-Agent": UA, "Content-Type": "application/json"},
        )
        resp = urlopen(req, timeout=30)
        body = json.loads(resp.read().decode("utf-8"))
        live_total = body["data"]["total_value"]
        print(f"  Live total on 3dsky.org: {live_total:,} models")
    except Exception as e:
        print(f"  Failed to get live total: {e}")
        live_total = None

    # 6. Report
    print(f"\n{'='*60}")
    print("SUMMARY")
    print(f"{'='*60}")
    print(f"  Slugs in sitemaps (unique):  {len(unique_slugs):>12,}")
    if live_total:
        print(f"  Live total from API:         {live_total:>12,}")
        gap = live_total - len(unique_slugs)
        print(f"  Gap (missing from sitemap):  {gap:>12,} ({gap/live_total*100:.1f}%)")
    print(f"  Database: {DB_PATH}")
    print(f"  DB file size: {os.path.getsize(DB_PATH):,} bytes")

    conn.execute(
        "INSERT OR REPLACE INTO scrape_meta (key, value) VALUES (?, ?)",
        ("sitemaps_processed", str(len(sitemap_urls))),
    )
    conn.execute(
        "INSERT OR REPLACE INTO scrape_meta (key, value) VALUES (?, ?)",
        ("slugs_from_sitemaps", str(len(unique_slugs))),
    )
    if live_total:
        conn.execute(
            "INSERT OR REPLACE INTO scrape_meta (key, value) VALUES (?, ?)",
            ("live_total", str(live_total)),
        )
    conn.commit()
    conn.close()

    print("\nDone.")


if __name__ == "__main__":
    main()
