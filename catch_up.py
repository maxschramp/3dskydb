"""
3dskydb Catch-Up Script
-----------------------
Pages through 3dsky.org listing API (via Worker proxy), fetches details
for any new models, stops after 20 consecutive existing models.
"""
import os
import sys
import json
import time
from urllib.request import Request, urlopen
from urllib.error import HTTPError

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cloudflare.client import CloudflareClient

client = CloudflareClient(os.environ["CF_WORKER_URL"], os.environ["CF_API_KEY"])
UA = "Mozilla/5.0 (compatible; 3dskydb-scraper/1.0)"
DELAY = 3.0  # seconds between 3dsky API calls
WORKER = os.environ["CF_WORKER_URL"]
API_KEY = os.environ["CF_API_KEY"]

last_req = 0.0


def throttle():
    global last_req
    elapsed = time.monotonic() - last_req
    if elapsed < DELAY:
        time.sleep(DELAY - elapsed)
    last_req = time.monotonic()


def fetch_json(url, data=None, extra_headers=None):
    """Fetch JSON from 3dsky API via Worker proxy."""
    headers = {}
    if extra_headers:
        headers.update(extra_headers)
    proxy_body = {
        "url": url,
        "method": "POST" if data else "GET",
        "headers": headers,
        "body": data,
    }
    body = json.dumps(proxy_body).encode()
    for attempt in range(3):
        try:
            throttle()
            req = Request(
                f"{WORKER}/api/proxy",
                data=body,
                headers={
                    "Authorization": f"Bearer {API_KEY}",
                    "Content-Type": "application/json",
                    "User-Agent": UA,
                },
            )
            resp = urlopen(req, timeout=30)
            result = json.loads(resp.read().decode())
            if result.get("success"):
                return json.loads(result["body"])
            else:
                print(f'  Proxy error: {result.get("error", "unknown")}')
                if attempt < 2:
                    time.sleep(2)
                    continue
                return None
        except HTTPError as e:
            if e.code == 429:
                wait = 5 * (attempt + 1)
                print(f"  429, waiting {wait}s...")
                time.sleep(wait)
                continue
            raise
        except Exception as ex:
            if attempt < 2:
                time.sleep(2)
                continue
            print(f"  Proxy request failed: {ex}")
            return None
    return None


def main():
    fetched = 0
    errors = 0
    pages_checked = 0
    consecutive_existing = 0
    MAX_CONSECUTIVE = 20
    MAX_PAGES = 200
    start = time.monotonic()

    print("Catching up on new models from listing API...")

    for page in range(1, MAX_PAGES + 1):
        listing = fetch_json("https://3dsky.org/api/models", {"page": page})
        if not listing:
            print(f"  Listing API failed on page {page}")
            break
        models = listing.get("data", {}).get("models")
        if models is None:
            print(f"  Listing API returned no models on page {page}")
            break
        if not models:
            print(f"  Page {page}: empty, stopping.")
            break

        pages_checked += 1
        slugs = [m["slug"] for m in models if m.get("slug")]
        existing = client.check_exists(slugs)
        new_slugs = [s for s in slugs if s not in existing]

        if not new_slugs:
            consecutive_existing += len(slugs)
            print(f"  Page {page}: all {len(slugs)} exist ({consecutive_existing} consecutive)")
            if consecutive_existing >= MAX_CONSECUTIVE:
                print(f"  Stopping: {consecutive_existing} consecutive existing models.")
                break
            continue

        consecutive_existing = 0
        print(f"  Page {page}: {len(new_slugs)} new of {len(slugs)}")

        for slug in new_slugs:
            try:
                detail = fetch_json(
                    "https://models.3dsky.org/api/models/show",
                    {"slug": slug},
                    {"Referer": f"https://3dsky.org/3dmodels/show/{slug}"},
                )
                if not detail or not detail.get("data"):
                    raise Exception("detail API failed")

                tags = fetch_json(
                    "https://tags.3dsky.org/api/tags/list",
                    {"entity": "model", "slug": slug, "locale": "en"},
                    {"Referer": f"https://3dsky.org/3dmodels/show/{slug}"},
                )
                tags_list = tags.get("data", []) if tags else []

                ok = client.store_detail(slug, detail["data"], tags_list)
                if not ok:
                    raise Exception("store_detail failed")

                fetched += 1
            except Exception as e:
                errors += 1
                print(f"    ERROR {slug}: {e}")

        if pages_checked % 5 == 0:
            elapsed = time.monotonic() - start
            print(f"  [{pages_checked} pages] {fetched} new, {errors} errors, {elapsed:.0f}s")

    elapsed = time.monotonic() - start
    print(f"Done: {pages_checked} pages, {fetched} new models, {errors} errors in {elapsed:.0f}s")


if __name__ == "__main__":
    main()
