"""
3dskydb — Backfill D1 from local SQLite DB (streaming version).

Reads models with detail_fetched=1 from local DB in batches and pushes
to D1 via /api/models/bulk. Loads child data on demand per batch.

Usage:
  python backfill_to_d1.py                    # full run
  python backfill_to_d1.py --limit 1000       # test run
  python backfill_to_d1.py --workers 20       # more parallelism
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
from urllib.request import Request, urlopen
from urllib.error import HTTPError

DB_PATH = Path(__file__).parent / "seed_from_sitemaps.db"
UA = "3dskydb-backfill/1.0"

parser = argparse.ArgumentParser(description="Backfill D1 from local SQLite")
parser.add_argument("--worker-url", type=str,
                    default=os.environ.get("CF_WORKER_URL", "https://3dskydb-api.maxschramp.workers.dev"))
parser.add_argument("--api-key", type=str,
                    default=os.environ.get("CF_API_KEY", ""))
parser.add_argument("--workers", type=int, default=15,
                    help="Parallel workers (default: 15)")
parser.add_argument("--batch-size", type=int, default=25,
                    help="Models per bulk API call (default: 25)")
parser.add_argument("--limit", type=int, default=0,
                    help="Max models to backfill (0 = all)")
parser.add_argument("--dry-run", action="store_true",
                    help="Estimate only, no API calls")
args = parser.parse_args()

if not args.api_key:
    print("Set CF_API_KEY environment variable or pass --api-key")
    sys.exit(1)

# ── Read model IDs we need ───────────────────────────────────────────

conn = sqlite3.connect(str(DB_PATH))

total = conn.execute(
    "SELECT COUNT(*) FROM model WHERE detail_fetched = 1"
).fetchone()[0]

if args.limit > 0:
    total = min(total, args.limit)

print(f"Models to backfill: {total:,}")
print(f"Batch size:         {args.batch_size}")
print(f"Workers:            {args.workers}")
print()

if args.dry_run:
    est_batches = (total + args.batch_size - 1) // args.batch_size
    print(f"Estimated batches:  {est_batches:,}")
    print("Dry run — exiting.")
    sys.exit(0)

# Get model IDs, limited
rows = conn.execute(
    "SELECT id FROM model WHERE detail_fetched = 1 ORDER BY id"
).fetchall()
model_ids = [r[0] for r in rows]
if args.limit > 0:
    model_ids = model_ids[:args.limit]


# ── Helper: load child data for a set of model IDs ───────────────────

def load_children(conn_local: sqlite3.Connection, mids: list[int]):
    """Load child data for a batch of model IDs."""
    if not mids:
        return {}, {}, {}, {}, {}

    ph = ",".join("?" * len(mids))

    images = {}
    for row in conn_local.execute(
        f"SELECT model_id, web_path, sort FROM model_image WHERE model_id IN ({ph}) ORDER BY model_id, sort",
        mids,
    ):
        images.setdefault(row[0], []).append({"web_path": row[1], "sort": row[2]})

    materials = {}
    for row in conn_local.execute(
        f"SELECT model_id, material, material_en FROM model_material WHERE model_id IN ({ph}) ORDER BY model_id",
        mids,
    ):
        materials.setdefault(row[0], []).append({"material": row[1], "material_en": row[2]})

    colors = {}
    for row in conn_local.execute(
        f"SELECT model_id, hex, title, title_en FROM model_color WHERE model_id IN ({ph}) ORDER BY model_id",
        mids,
    ):
        colors.setdefault(row[0], []).append({"hex": row[1], "title": row[2], "title_en": row[3]})

    formats = {}
    for row in conn_local.execute(
        f"SELECT model_id, title FROM model_format WHERE model_id IN ({ph}) ORDER BY model_id",
        mids,
    ):
        formats.setdefault(row[0], []).append({"title": row[1]})

    tags = {}
    for row in conn_local.execute(
        f"""SELECT mt.model_id, t.title, t.multiple
            FROM model_tag mt JOIN tag t ON t.id = mt.tag_id
            WHERE mt.model_id IN ({ph})
            ORDER BY mt.model_id""",
        mids,
    ):
        tags.setdefault(row[0], []).append({"title": row[1], "multiple": row[2]})

    return images, materials, colors, formats, tags


# ── Build payloads ───────────────────────────────────────────────────

def build_payloads(conn_local: sqlite3.Connection, mids: list[int]) -> list[dict]:
    """Fetch model rows + children for a batch, return API payloads."""
    ph = ",".join("?" * len(mids))
    rows = conn_local.execute(
        f"SELECT * FROM model WHERE id IN ({ph}) ORDER BY id",
        mids,
    ).fetchall()

    images, materials, colors, formats, tags = load_children(conn_local, mids)

    payloads = []
    for row in rows:
        mid = row[0]
        # Column order: id(0), slug(1), title(2), title_en(3), description(4),
        # description_en(5), type(6), type_text(7), style(8), style_en(9),
        # price(10), price_usd(11), polygons(12), vertices(13), size_kb(14),
        # length_cm(15), width_cm(16), height_cm(17), platform(18), platform_en(19),
        # render(20), category_slug(21), category_title(22), category_title_en(23),
        # subcategory_slug(24), subcategory_title(25), subcategory_title_en(26),
        # form_id(27), form_title(28), form_title_en(29), is_created_with_ai(30),
        # version(31), created_at(32), slug_seeded_at(33), detail_fetched(34),
        # detail_fetched_at(35)
        payloads.append({
            "slug": row[1],
            "title": row[2], "title_en": row[3],
            "description": row[4], "description_en": row[5],
            "type": row[6], "type_text": row[7],
            "style": row[8], "style_en": row[9],
            "price": row[10], "price_usd": row[11],
            "polygons": row[12], "size_kb": row[14],
            "length_cm": row[15], "width_cm": row[16], "height_cm": row[17],
            "platform": row[18], "platform_en": row[19],
            "render": row[20],
            "category_slug": row[21], "category_title": row[22], "category_title_en": row[23],
            "subcategory_slug": row[24], "subcategory_title": row[25], "subcategory_title_en": row[26],
            "form_id": row[27], "form_title": row[28], "form_title_en": row[29],
            "is_created_with_ai": bool(row[30]),
            "version": row[31], "created_at": row[32],
            "images": images.get(mid, []),
            "materials": materials.get(mid, []),
            "colors": colors.get(mid, []),
            "formats": formats.get(mid, []),
            "tags": tags.get(mid, []),
        })
    return payloads


# ── API client ───────────────────────────────────────────────────────

stats_lock = Lock()
stats = {"sent": 0, "succeeded": 0, "failed": 0, "start": time.monotonic()}


def post_bulk(models: list[dict]) -> dict:
    body = json.dumps({"models": models}).encode("utf-8")
    req = Request(
        f"{args.worker_url}/api/models/bulk",
        data=body,
        headers={
            "Authorization": f"Bearer {args.api_key}",
            "Content-Type": "application/json",
            "User-Agent": UA,
            "Accept": "application/json",
        },
    )
    for attempt in range(3):
        try:
            resp = urlopen(req, timeout=120)
            return json.loads(resp.read().decode("utf-8"))
        except HTTPError as e:
            if e.code == 429:
                time.sleep(2 * (attempt + 1))
                continue
            raise
        except Exception:
            if attempt < 2:
                time.sleep(2)
                continue
            raise
    return {"success": False, "error": "max retries"}


def backfill_batch(batch_mids: list[int]) -> tuple[int, int]:
    conn_local = sqlite3.connect(str(DB_PATH))
    try:
        payloads = build_payloads(conn_local, batch_mids)
        result = post_bulk(payloads)

        sent = len(payloads)
        succeeded = result.get("succeeded", 0)
        failed = result.get("failed", 0)

        with stats_lock:
            stats["sent"] += sent
            stats["succeeded"] += succeeded
            stats["failed"] += failed

        if result.get("errors"):
            for err in result["errors"][:3]:
                print(f"  ERR: {err}")

        return succeeded, failed
    finally:
        conn_local.close()


# ── Main ─────────────────────────────────────────────────────────────

print(f"Backfilling {total:,} models...")
print()

batches = [
    model_ids[i:i + args.batch_size]
    for i in range(0, len(model_ids), args.batch_size)
]

with ThreadPoolExecutor(max_workers=args.workers) as pool:
    futures = {pool.submit(backfill_batch, b): i for i, b in enumerate(batches)}

    for future in as_completed(futures):
        batch_idx = futures[future]
        try:
            future.result()
        except Exception as e:
            print(f"  Batch {batch_idx} crashed: {e}")

        if (batch_idx + 1) % 100 == 0:
            with stats_lock:
                elapsed = time.monotonic() - stats["start"]
                rate = stats["succeeded"] / (elapsed / 60) if elapsed > 0 else 0
                pct = stats["succeeded"] / total * 100 if total > 0 else 0
                print(f"  [{stats['succeeded']:,}/{total:,} {pct:.1f}%] "
                      f"{rate:.0f}/min, {stats['failed']} failed")

elapsed = time.monotonic() - stats["start"]
print()
print(f"{'='*60}")
print(f"Done in {elapsed:.0f}s ({elapsed/60:.1f} min)")
print(f"  Sent:      {stats['sent']:,}")
print(f"  Succeeded: {stats['succeeded']:,}")
print(f"  Failed:    {stats['failed']:,}")
print(f"  Rate:      {stats['succeeded'] / (elapsed / 60):.0f} models/min")
conn.close()
