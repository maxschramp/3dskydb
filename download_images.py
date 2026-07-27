"""
3dsky.org — Bulk image downloader.

Downloads all model preview images from the CDN via Bright Data proxy.
URL pattern: https://b4.3dsky.org/media/cache/models-list-webp/{web_path}

Usage:
  python download_images.py                  # default proxy, 50 workers
  python download_images.py --workers 100    # more parallelism
  python download_images.py --limit 100      # test run
  python download_images.py --dry-run        # estimate only

Resumable — tracks downloaded flag in model_image table.
"""
import sqlite3
import time
import sys
import os
import argparse
import threading
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor, as_completed
from threading import Lock
from urllib.request import Request, urlopen, ProxyHandler, build_opener, install_opener
from urllib.error import HTTPError

DB_PATH = Path(__file__).parent / "seed_from_sitemaps.db"
BASE_DIR = Path(__file__).parent / "model_images"
CDN_BASE = "https://b4.3dsky.org/media/cache/models-list-webp/"
UA = "Mozilla/5.0 (compatible; 3dskydb-scraper/1.0)"

# ── CLI ─────────────────────────────────────────────────────────────
parser = argparse.ArgumentParser(description="Download 3dsky model preview images")
parser.add_argument("--proxy", type=str,
                    default=os.environ.get("BRD_PROXY_URL", ""),
                    help="Proxy URL (set BRD_PROXY_URL env var or pass --proxy), or comma-separated for round-robin")
parser.add_argument("--no-proxy", action="store_true",
                    help="Connect directly (no proxy)")
parser.add_argument("--workers", type=int, default=50,
                    help="Initial parallel workers (default: 50, auto-tunes if --auto-tune)")
parser.add_argument("--auto-tune", action="store_true",
                    help="Auto-adjust workers to maximize throughput")
parser.add_argument("--limit", type=int, default=0,
                    help="Limit number of images (0 = all)")
parser.add_argument("--dry-run", action="store_true",
                    help="Estimate only, no downloads")
args = parser.parse_args()

# ── Proxy ───────────────────────────────────────────────────────────
PROXIES = []
if args.no_proxy:
    print("Proxy: NONE (direct connection)")
else:
    proxy_urls = [p.strip() for p in args.proxy.split(",") if p.strip()]
    PROXIES = proxy_urls
    for i, p in enumerate(proxy_urls):
        pd = p
        if "@" in pd:
            parts = pd.split("@")
            ap = parts[0].split("://")[-1] if "://" in parts[0] else parts[0]
            if ":" in ap:
                pd = pd.replace(ap, f"{ap.split(':')[0]}:***")
        print(f"Proxy {i+1}: {pd}")
    # Don't set global opener — each worker picks its own proxy

# ── DB ───────────────────────────────────────────────────────────────
def _get_db_conn():
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
        try: c.close()
        except: pass
    _get_db_conn._conns = {}

conn = _get_db_conn()

# Add downloaded column if it doesn't exist
try:
    conn.execute("ALTER TABLE model_image ADD COLUMN downloaded INTEGER DEFAULT 0")
except sqlite3.OperationalError:
    pass  # column already exists
conn.commit()

# ── Stats ────────────────────────────────────────────────────────────
total_images = conn.execute(
    "SELECT COUNT(*) FROM model_image WHERE downloaded = 0 AND web_path IS NOT NULL AND web_path != ''"
).fetchone()[0]
already = conn.execute(
    "SELECT COUNT(*) FROM model_image WHERE downloaded = 1"
).fetchone()[0]

print(f"Total images in DB:     {total_images + already:,}")
print(f"Already downloaded:     {already:,}")
print(f"Remaining:              {total_images:,}")
print(f"Workers:                {args.workers}")
print()

if args.limit > 0:
    total_images = min(total_images, args.limit)
    print(f"Limited to:             {total_images:,}")
    print()

if total_images == 0:
    print("Nothing to download. Done!")
    _close_all_conns()
    sys.exit(0)

# Cost/size estimate
AVG_IMAGE_KB = 10
PRICE_PER_GB = 0.60  # shared datacenter proxy
est_gb = total_images * AVG_IMAGE_KB / (1024 * 1024)
est_cost = est_gb * PRICE_PER_GB if not args.no_proxy else 0
print(f"Est. total size:        {est_gb:.1f} GB")
if not args.no_proxy:
    print(f"Est. proxy cost:        ${est_cost:.2f} (@ ${PRICE_PER_GB}/GB)")
print()

if args.dry_run:
    print("Dry run — exiting.")
    _close_all_conns()
    sys.exit(0)

# ── Download logic ───────────────────────────────────────────────────
_stats_lock = Lock()
stats = {"downloaded": 0, "errors": 0, "bytes": 0, "start_time": time.monotonic()}
# Lock-free batch DB updates via a dedicated flush thread
import queue
_update_queue = queue.Queue()
_flush_stop = threading.Event()


# Round-robin proxy index
_proxy_idx = [0]
_proxy_lock = threading.Lock()

def _get_opener():
    """Return an opener for the next proxy in rotation."""
    if args.no_proxy or not PROXIES:
        return build_opener()
    with _proxy_lock:
        proxy = PROXIES[_proxy_idx[0] % len(PROXIES)]
        _proxy_idx[0] += 1
    return build_opener(ProxyHandler({"http": proxy, "https": proxy}))


def download_image(row_id: int, web_path: str) -> bool:
    """Download one image. Returns True on success."""
    url = CDN_BASE + web_path
    local_path = BASE_DIR / web_path
    local_path.parent.mkdir(parents=True, exist_ok=True)

    # Skip if already on disk
    if local_path.exists() and local_path.stat().st_size > 0:
        _update_queue.put(row_id)
        with _stats_lock:
            stats["downloaded"] += 1
        return True

    opener = _get_opener()
    for attempt in range(3):
        try:
            req = Request(url, headers={"User-Agent": UA})
            resp = opener.open(req, timeout=30)
            data = resp.read()
            local_path.write_bytes(data)

            _update_queue.put(row_id)

            with _stats_lock:
                stats["downloaded"] += 1
                stats["bytes"] += len(data)
            return True

        except HTTPError as e:
            if e.code == 429:
                time.sleep(2 * (attempt + 1))
                continue
            if e.code == 404:
                _update_queue.put(row_id)
                with _stats_lock:
                    stats["errors"] += 1
                return False
            raise
        except Exception as e:
            if attempt < 2:
                time.sleep(1)
                continue
            raise

    with _stats_lock:
        stats["errors"] += 1
    return False


def _flush_thread():
    """Dedicated thread: drain the update queue and batch-write to DB."""
    batch = []
    while not _flush_stop.is_set():
        try:
            # Wait up to 0.5s for an item, then flush whatever we have
            row_id = _update_queue.get(timeout=0.5)
            batch.append(row_id)
        except queue.Empty:
            pass
        # Flush if we have enough or timed out
        if len(batch) >= 200 or (batch and _flush_stop.is_set()):
            _do_flush(batch)
            batch = []
    # Final flush
    if batch:
        _do_flush(batch)


def _do_flush(ids: list):
    """Batch UPDATE model_image SET downloaded=1."""
    c = _get_db_conn()
    placeholders = ",".join("?" * len(ids))
    c.execute(f"UPDATE model_image SET downloaded = 1 WHERE id IN ({placeholders})", ids)
    c.commit()


# ── Progress reporter ────────────────────────────────────────────────
def progress_reporter(total: int, worker_count):
    while True:
        time.sleep(15)
        with _stats_lock:
            d = stats["downloaded"]
            e = stats["errors"]
            b = stats["bytes"]
            elapsed = time.monotonic() - stats["start_time"]
        if d == 0:
            continue
        rate = d / elapsed * 60 if elapsed > 0 else 0
        remaining = total - d - e
        eta_min = remaining / rate if rate > 0 else 0
        eta_d = int(eta_min // (24 * 60))
        eta_h = int((eta_min % (24 * 60)) // 60)
        eta_m = int(eta_min % 60)
        eta_str = f"{eta_d}d:{eta_h}h:{eta_m}m" if eta_d > 0 else f"{eta_h}h:{eta_m}m" if eta_h > 0 else f"{eta_m}m"
        gb = b / (1024**3)
        w = worker_count[0]
        print(f"\n[{time.strftime('%H:%M:%S')}] "
              f"{d:,}/{total:,} | {e} err | {rate:.0f}/min | ETA {eta_str} | {gb:.2f} GB | {w}w")
        if d + e >= total:
            break


# ── Main ─────────────────────────────────────────────────────────────
def main():
    print("Starting download...")
    print()

    # Get images to download
    rows = conn.execute(
        "SELECT id, web_path FROM model_image WHERE downloaded = 0 AND web_path IS NOT NULL AND web_path != '' ORDER BY id"
    ).fetchall()
    if args.limit > 0:
        rows = rows[:args.limit]

    total = len(rows)
    print(f"Queued: {total:,} images")
    print()

    # ── Auto-tuner state ────────────────────────────────────────────
    current_workers = [args.workers]  # mutable for cross-thread access
    workers_lock = threading.Lock()

    # Start dedicated DB flush thread
    flusher = threading.Thread(target=_flush_thread, daemon=True)
    flusher.start()

    # Progress reporter
    reporter = threading.Thread(target=progress_reporter, args=(total, current_workers), daemon=True)
    reporter.start()

    def worker(row):
        row_id, web_path = row
        return download_image(row_id, web_path)

    # ── Auto-tuner logic ─────────────────────────────────────────────
    rate_history = []  # (timestamp, images_downloaded) samples
    TUNE_INTERVAL = 90  # seconds between tuning decisions

    def auto_tuner():
        last_tune = time.monotonic()
        while True:
            time.sleep(TUNE_INTERVAL)
            with _stats_lock:
                now_d = stats["downloaded"]
                now_ts = time.monotonic()
            # Record rate sample
            rate_history.append((now_ts, now_d))
            # Keep only last 4 samples
            if len(rate_history) > 4:
                rate_history.pop(0)
            if len(rate_history) < 2:
                continue

            # Compute rate over last two windows
            t0, d0 = rate_history[-2]
            t1, d1 = rate_history[-1]
            current_rate = (d1 - d0) / ((t1 - t0) / 60) if t1 > t0 else 0

            # Compare to previous window's rate
            if len(rate_history) >= 3:
                t_prev, d_prev = rate_history[-3]
                prev_rate = (d0 - d_prev) / ((t0 - t_prev) / 60) if t0 > t_prev else 0
            else:
                prev_rate = current_rate

            # Decide adjustment
            with workers_lock:
                old = current_workers[0]
                change = 0
                if current_rate > 0 and prev_rate > 0:
                    change = (current_rate - prev_rate) / prev_rate
                    if change < -0.15:
                        current_workers[0] = max(10, int(current_workers[0] * 0.7))
                    elif change < -0.05:
                        current_workers[0] = max(10, current_workers[0] - 10)
                    elif change > 0.10:
                        current_workers[0] = min(300, current_workers[0] + 15)

                if current_workers[0] != old:
                    print(f"\n  [tune] workers {old} → {current_workers[0]} (rate {current_rate:.0f}/min, change {change*100:.0f}%)")

    if args.auto_tune:
        print(f"Auto-tune: ON (starting at {current_workers[0]} workers, tuning every {TUNE_INTERVAL}s)")
        tuner = threading.Thread(target=auto_tuner, daemon=True)
        tuner.start()
    print()

    # ── Main download loop with dynamic worker resizing ─────────────
    idx = 0
    total_rows = len(rows)

    while idx < total_rows:
        w = current_workers[0]  # snapshot
        batch_size = min(w * 50, total_rows - idx)
        batch = rows[idx:idx + batch_size]

        completed_in_batch = 0
        batch_errors = 0

        with ThreadPoolExecutor(max_workers=w) as executor:
            futures = {executor.submit(worker, r): r for r in batch}
            for future in as_completed(futures):
                try:
                    future.result()
                    completed_in_batch += 1
                except Exception:
                    batch_errors += 1
                # Early exit if worker count changed
                if current_workers[0] != w:
                    for f in futures:
                        f.cancel()
                    break

        idx += len(batch)
        # If we broke early due to worker change, already-submitted but
        # not-yet-processed items will be re-queued in the next batch.
        # To avoid duplicates, only advance idx by completed count.
        if current_workers[0] != w:
            idx = idx - len(batch) + completed_in_batch + batch_errors

    # Stop flush thread and drain remaining
    _flush_stop.set()
    flusher.join(timeout=5)
    # Drain any stragglers
    remaining = []
    while True:
        try:
            remaining.append(_update_queue.get_nowait())
        except queue.Empty:
            break
    if remaining:
        _do_flush(remaining)

    # Final report
    with _stats_lock:
        d = stats["downloaded"]
        e = stats["errors"]
        b = stats["bytes"]
        elapsed = time.monotonic() - stats["start_time"]

    gb = b / (1024**3)
    rate = d / elapsed * 60 if elapsed > 0 else 0
    print(f"\n{'='*60}")
    print(f"DONE")
    print(f"  Downloaded: {d:,}")
    print(f"  Errors:     {e}")
    print(f"  Data:       {gb:.2f} GB")
    print(f"  Time:       {elapsed/60:.0f} min ({elapsed/3600:.1f}h)")
    print(f"  Rate:       {rate:.0f} images/min")

    if not args.no_proxy:
        print(f"  Est. cost:  ${gb * PRICE_PER_GB:.2f} (@ ${PRICE_PER_GB}/GB)")

    _close_all_conns()


if __name__ == "__main__":
    main()
