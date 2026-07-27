"""
3dsky.org — Production scraper: fetch model detail + tags for all slugs.

Usage:
  python scrape_models.py                                    # default proxy, 50 workers
  python scrape_models.py --workers 100                      # more parallelism
  python scrape_models.py --limit 10 --workers 50            # test run
  python scrape_models.py --dry-run                          # estimate only

Endpoints hit per model (2 calls):
  1. POST models.3dsky.org/api/models/show  →  model_detail (~4.5 KB)
  2. POST tags.3dsky.org/api/tags/list      →  tags (~0.5 KB)

Stores in SQLite. Resumable — tracks detail_fetched flag.
Uses Bright Data datacenter proxy.
"""
import sqlite3
import json
import time
import sys
import os
import argparse
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor, as_completed
from threading import Lock
from urllib.request import Request, urlopen, ProxyHandler, build_opener, install_opener
from urllib.error import HTTPError, URLError

DB_PATH = Path(__file__).parent / "seed_from_sitemaps.db"
UA = "Mozilla/5.0 (compatible; 3dskydb-scraper/1.0)"

# ── CLI ─────────────────────────────────────────────────────────────
parser = argparse.ArgumentParser(description="Scrape 3dsky.org model details")
parser.add_argument("--proxy", type=str,
                    default=os.environ.get("BRD_PROXY_URL", ""),
                    help="Proxy URL (set BRD_PROXY_URL env var or pass --proxy)")
parser.add_argument("--no-proxy", action="store_true",
                    help="Disable proxy, connect directly")
parser.add_argument("--workers", type=int, default=20,
                    help="Number of parallel workers (default: 20 direct, 50 with proxy)")
parser.add_argument("--delay", type=float, default=0.0,
                    help="Per-worker delay between requests (default: 0)")
parser.add_argument("--limit", type=int, default=0,
                    help="Limit number of models to scrape (0 = all)")
parser.add_argument("--batch-size", type=int, default=200,
                    help="DB commit every N models (default: 200)")
parser.add_argument("--dry-run", action="store_true",
                    help="Print what would be done without making requests")
args = parser.parse_args()

# ── Proxy setup ──────────────────────────────────────────────────────
if args.no_proxy or not args.proxy:
    print("Proxy: NONE (direct connection)")
else:
    proxy_display = args.proxy
    if "@" in proxy_display:
        parts = proxy_display.split("@")
        auth_part = parts[0].split("://")[-1] if "://" in parts[0] else parts[0]
        if ":" in auth_part:
            user = auth_part.split(":")[0]
            proxy_display = proxy_display.replace(auth_part, f"{user}:***")
    proxy_handler = ProxyHandler({"http": args.proxy, "https": args.proxy})
    opener = build_opener(proxy_handler)
    install_opener(opener)
    print(f"Proxy: {proxy_display}")

# ── DB setup (per-thread connections for SQLite thread safety) ────────
import threading

def _get_db_conn():
    """Return a thread-local SQLite connection."""
    tid = threading.get_ident()
    if not hasattr(_get_db_conn, "_conns"):
        _get_db_conn._conns = {}
    if tid not in _get_db_conn._conns:
        c = sqlite3.connect(str(DB_PATH))
        c.execute("PRAGMA journal_mode=WAL")
        c.execute("PRAGMA synchronous=NORMAL")
        c.execute("PRAGMA busy_timeout=30000")
        _get_db_conn._conns[tid] = c
    return _get_db_conn._conns[tid]

def _close_all_conns():
    for c in getattr(_get_db_conn, "_conns", {}).values():
        try:
            c.close()
        except Exception:
            pass
    _get_db_conn._conns = {}

# Main-thread connection for initial queries
conn = _get_db_conn()
db_lock = Lock()
write_semaphore = threading.Semaphore(3)  # max concurrent SQLite writers

# Ensure detail columns exist (safe to run multiple times)
conn.executescript("""
    CREATE TABLE IF NOT EXISTS scrape_errors (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        slug TEXT NOT NULL,
        endpoint TEXT,
        error TEXT,
        created_at TEXT DEFAULT (datetime('now'))
    );
""")
conn.commit()

# ── Stats ────────────────────────────────────────────────────────────
total_slugs = conn.execute(
    "SELECT COUNT(*) FROM model WHERE detail_fetched = 0"
).fetchone()[0]

already_fetched = conn.execute(
    "SELECT COUNT(*) FROM model WHERE detail_fetched = 1"
).fetchone()[0]

print(f"Total slugs in DB:    {total_slugs + already_fetched:,}")
print(f"Already fetched:      {already_fetched:,}")
print(f"Remaining to fetch:   {total_slugs:,}")
print(f"Workers:              {args.workers}")
print(f"Delay:                {args.delay}s")
print()

if args.limit > 0:
    total_slugs = min(total_slugs, args.limit)
    print(f"Limited to:           {total_slugs:,}")
    print()

if total_slugs == 0:
    print("Nothing to fetch. Done!")
    conn.close()
    sys.exit(0)

# Cost estimate
avg_bytes_per_model = 5107  # from test
est_total_gb = (avg_bytes_per_model * total_slugs) / (1024**3)
est_cost = est_total_gb * 4  # $4/GB
print(f"Est. data:            {est_total_gb:.2f} GB")
print(f"Est. proxy cost:      ${est_cost:.2f} (@ $4/GB)")
print(f"Est. time (1 worker): {total_slugs * args.delay / 3600:,.0f} hours")
if args.workers > 1:
    print(f"Est. time ({args.workers} workers): {total_slugs * args.delay / 3600 / args.workers:,.0f} hours")
print()

if args.dry_run:
    print("Dry run — exiting.")
    conn.close()
    sys.exit(0)

# ── Fetch functions ──────────────────────────────────────────────────
_stats_lock = Lock()
stats = {"fetched": 0, "errors": 0, "bytes": 0, "http_429": 0, "start_time": time.monotonic()}


def fetch_endpoint(url: str, data: dict, slug: str, ep_name: str) -> tuple[dict | None, int]:
    """Returns (parsed_json_or_None, response_bytes). Retries on 429."""
    body = json.dumps(data).encode("utf-8")
    req = Request(url, data=body, headers={
        "User-Agent": UA,
        "Content-Type": "application/json",
        "Referer": f"https://3dsky.org/3dmodels/show/{slug}",
    })
    last_exc = None
    for attempt in range(3):
        try:
            resp = urlopen(req, timeout=30)
            raw = resp.read()
            return json.loads(raw.decode("utf-8")), len(raw)
        except HTTPError as e:
            if e.code == 429:
                with _stats_lock:
                    stats["http_429"] += 1
                time.sleep(2 * (attempt + 1))  # 2s, 4s, 6s backoff
                last_exc = e
                continue
            raise
        except Exception as e:
            last_exc = e
            if attempt < 2:
                time.sleep(1)
                continue
            raise
    raise last_exc


def scrape_model(slug: str) -> bool:
    """Fetch detail + tags for one model. Returns True on success."""
    try:
        # 1. Model detail
        detail_data, detail_bytes = fetch_endpoint(
            "https://models.3dsky.org/api/models/show",
            {"slug": slug},
            slug, "model_detail"
        )
        if not detail_data or not detail_data.get("success"):
            raise Exception(f"model_detail API returned success=false or empty")

        d = detail_data["data"]

        # 2. Tags
        tags_data, tags_bytes = fetch_endpoint(
            "https://tags.3dsky.org/api/tags/list",
            {"entity": "model", "slug": slug, "locale": "en"},
            slug, "tags"
        )
        tags_list = tags_data.get("data", []) if tags_data and tags_data.get("success") else []

        total_bytes = detail_bytes + tags_bytes

        # 3. Write to DB (throttled via semaphore to avoid SQLITE_BUSY)
        with write_semaphore:
            _store_model(slug, d, tags_list)

        # Update stats
        with _stats_lock:
            stats["fetched"] += 1
            stats["bytes"] += total_bytes

        return True

    except Exception as e:
        with write_semaphore:
            c = _get_db_conn()
            c.execute(
                "INSERT INTO scrape_errors (slug, endpoint, error) VALUES (?, ?, ?)",
                (slug, "scrape", str(e)[:500]),
            )
            c.commit()
        with _stats_lock:
            stats["errors"] += 1
        return False


def _store_model(slug: str, d: dict, tags_list: list):
    """Insert/update model detail and tags using thread-local connection.
    Wraps in a single transaction with retry for 'database is locked'."""
    c = _get_db_conn()
    max_retries = 5
    for attempt in range(max_retries):
        try:
            c.execute("BEGIN IMMEDIATE")
            user = d.get("user", {}) or {}
            platform = d.get("platform", {}) or {}
            render = d.get("render", {}) or {}
            form = d.get("form", {}) or {}
            category = d.get("category", {}) or {}
            subcategory = d.get("subcategory", {}) or {}

            c.execute("""
                UPDATE model SET
                    title = ?, title_en = ?, description = ?, description_en = ?,
                    type = ?, type_text = ?, style = ?, style_en = ?,
                    price = ?, price_usd = ?, polygons = ?, size_kb = ?,
                    length_cm = ?, width_cm = ?, height_cm = ?,
                    platform = ?, platform_en = ?, render = ?,
                    category_slug = ?, category_title = ?, category_title_en = ?,
                    subcategory_slug = ?, subcategory_title = ?, subcategory_title_en = ?,
                    form_id = ?, form_title = ?, form_title_en = ?,
                    is_created_with_ai = ?, version = ?, created_at = ?,
                    detail_fetched = 1, detail_fetched_at = datetime('now')
                WHERE slug = ?
            """, (
                d.get("title"), d.get("titleEn"), d.get("description"), d.get("descriptionEn"),
                d.get("type"), d.get("typeText"), d.get("style"), d.get("style_en"),
                int(d["price"]) if d.get("price") else None,
                float(d["price_usd"]) if d.get("price_usd") else None,
                d.get("polygons"), d.get("size_kb"),
                float(d["length"]) if d.get("length") else None,
                float(d["width"]) if d.get("width") else None,
                float(d["height"]) if d.get("height") else None,
                platform.get("title"), platform.get("titleEn"), render.get("title"),
                category.get("slug"), category.get("title"), category.get("title_en"),
                subcategory.get("slug"), subcategory.get("title"), subcategory.get("title_en"),
                form.get("id"), form.get("form"), form.get("formEn"),
                1 if d.get("is_created_with_ai") else 0,
                d.get("version"), d.get("created"), slug,
            ))

            model_id = c.execute("SELECT id FROM model WHERE slug = ?", (slug,)).fetchone()
            if model_id:
                mid = model_id[0]
                c.execute("DELETE FROM model_image WHERE model_id = ?", (mid,))
                for img in d.get("images", []):
                    c.execute("INSERT INTO model_image (model_id, web_path, sort) VALUES (?,?,?)",
                              (mid, img.get("webPath", img.get("web_path", "")), img.get("sort", 0)))

                c.execute("DELETE FROM model_material WHERE model_id = ?", (mid,))
                for mat in d.get("materials", []):
                    c.execute("INSERT INTO model_material (model_id, material, material_en) VALUES (?,?,?)",
                              (mid, mat.get("material"), mat.get("materialEn")))

                c.execute("DELETE FROM model_color WHERE model_id = ?", (mid,))
                for col in d.get("colors", []):
                    c.execute("INSERT INTO model_color (model_id, hex, title, title_en) VALUES (?,?,?,?)",
                              (mid, col.get("color"), col.get("title"), col.get("titleEn")))

                c.execute("DELETE FROM model_format WHERE model_id = ?", (mid,))
                for fmt in d.get("formats", []):
                    c.execute("INSERT INTO model_format (model_id, title) VALUES (?,?)",
                              (mid, fmt.get("title")))

                c.execute("DELETE FROM model_tag WHERE model_id = ?", (mid,))
                for tag in tags_list:
                    tag_title = tag.get("title", "")
                    if not tag_title:
                        continue
                    c.execute("INSERT OR IGNORE INTO tag (title, multiple) VALUES (?,?)",
                              (tag_title, tag.get("multiple", 1)))
                    tag_id = c.execute("SELECT id FROM tag WHERE title = ?", (tag_title,)).fetchone()[0]
                    c.execute("INSERT OR IGNORE INTO model_tag (model_id, tag_id) VALUES (?,?)", (mid, tag_id))

            c.commit()
            return  # success

        except sqlite3.OperationalError as e:
            if "locked" in str(e).lower() and attempt < max_retries - 1:
                c.execute("ROLLBACK")
                time.sleep(0.1 * (attempt + 1))  # exponential backoff
                continue
            try:
                c.execute("ROLLBACK")
            except Exception:
                pass
            raise
        except Exception:
            try:
                c.execute("ROLLBACK")
            except Exception:
                pass
            raise


def progress_reporter(total: int):
    """Periodically print progress (runs in daemon thread)."""
    while True:
        time.sleep(15)
        with _stats_lock:
            fetched = stats["fetched"]
            errors = stats["errors"]
            bytes_total = stats["bytes"]
            elapsed = time.monotonic() - stats["start_time"]

        if fetched == 0:
            continue

        rate = fetched / elapsed * 60 if elapsed > 0 else 0
        remaining = total - fetched - errors
        eta_min = remaining / rate if rate > 0 else 0
        gb_downloaded = bytes_total / (1024**3)

        print(f"\n[{time.strftime('%H:%M:%S')}] "
              f"{fetched:,}/{total:,} | {errors} err | 429s: {stats.get('http_429', 0)} | "
              f"{rate:.0f}/min | ETA {eta_min:.0f}m | "
              f"{gb_downloaded:.2f} GB")

        if fetched + errors >= total:
            break


# ── Main ─────────────────────────────────────────────────────────────
def main():
    print("Starting scrape...")
    print()

    # Get slugs to fetch
    slugs = [
        row[0] for row in
        conn.execute("SELECT slug FROM model WHERE detail_fetched = 0 ORDER BY id")
    ]
    total = len(slugs)
    if args.limit > 0:
        slugs = slugs[:args.limit]
        total = len(slugs)

    # Recalc cost estimate
    avg_bytes = 5107
    est_gb = avg_bytes * total / (1024**3)
    print(f"Queued:    {total:,} slugs")
    print(f"Workers:   {args.workers}")
    print(f"Batch:     {args.batch_size}")
    print(f"Est data:  {est_gb:.2f} GB (~${est_gb*4:.2f})")
    print()

    if args.dry_run:
        _close_all_conns()
        return

    # Progress reporter thread
    import threading
    reporter = threading.Thread(target=progress_reporter, args=(total,), daemon=True)
    reporter.start()

    # Track completion count for batch commits
    completed = [0]  # mutable counter for thread-safe use
    completed_lock = Lock()

    def worker(slug: str) -> bool:
        return scrape_model(slug)

    with ThreadPoolExecutor(max_workers=args.workers) as executor:
        futures = {executor.submit(worker, slug): slug for slug in slugs}
        for future in as_completed(futures):
            try:
                future.result()
            except Exception as e:
                slug = futures[future]
                with _stats_lock:
                    stats["errors"] += 1
                with write_semaphore:
                    c = _get_db_conn()
                    c.execute(
                        "INSERT INTO scrape_errors (slug, endpoint, error) VALUES (?, ?, ?)",
                        (slug, "worker", str(e)[:500]),
                    )
                    c.commit()
                with db_lock:
                    conn.execute(
                        "INSERT INTO scrape_errors (slug, endpoint, error) VALUES (?, ?, ?)",
                        (slug, "worker", str(e)[:500]),
                    )

    conn.commit()

    # Final report
    with _stats_lock:
        fetched = stats["fetched"]
        errors = stats["errors"]
        bytes_total = stats["bytes"]
        elapsed = time.monotonic() - stats["start_time"]

    gb_total = bytes_total / (1024**3)
    rate = fetched / elapsed * 60 if elapsed > 0 else 0
    print(f"\n{'='*60}")
    print(f"DONE")
    print(f"  Fetched:  {fetched:,}")
    print(f"  Errors:   {errors}")
    print(f"  Data:     {gb_total:.2f} GB (~${gb_total*4:.2f})")
    print(f"  Time:     {elapsed/60:.0f} min ({elapsed/3600:.1f}h)")
    print(f"  Rate:     {rate:.0f} models/min")

    conn.execute(
        "INSERT OR REPLACE INTO scrape_meta (key, value) VALUES (?, ?)",
        ("detail_fetched_count", str(fetched)),
    )
    conn.execute(
        "INSERT OR REPLACE INTO scrape_meta (key, value) VALUES (?, ?)",
        ("detail_errors", str(errors)),
    )
    conn.commit()
    _close_all_conns()


if __name__ == "__main__":
    main()
