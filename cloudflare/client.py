"""
3dskydb Cloudflare Client
-------------------------
Drop-in HTTP client that mirrors the SQLite operations from scrape_models.py
and seed_from_sitemaps.py, but sends data to the Cloudflare Worker API instead.

Usage:
    from cloudflare_client import CloudflareClient

    client = CloudflareClient(
        base_url="https://3dskydb-api.YOURSUBDOMAIN.workers.dev",
        api_key="your-secret-key"
    )

    # Seed slugs (replaces seed_from_sitemaps.py DB writes)
    result = client.seed_slugs(["slug1", "slug2", ...])

    # Get next batch to fetch (replaces: SELECT slug FROM model WHERE detail_fetched=0)
    slugs = client.next_unfetched(limit=500)

    # Store model detail (replaces _store_model() in scrape_models.py)
    client.store_detail(slug, detail_data, tags_list)

    # Get stats
    stats = client.stats()
"""

import json
import time
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError


class CloudflareClient:
    def __init__(self, base_url: str, api_key: str, timeout: int = 30):
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.timeout = timeout

    def _post(self, path: str, data: dict) -> dict:
        """Send a POST request to the Worker API. Returns parsed JSON."""
        url = f"{self.base_url}{path}"
        body = json.dumps(data).encode("utf-8")
        req = Request(url, data=body, headers={
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
            "User-Agent": "3dskydb-client/1.0",
            "Accept": "application/json",
        })
        last_exc = None
        for attempt in range(3):
            try:
                resp = urlopen(req, timeout=self.timeout)
                return json.loads(resp.read().decode("utf-8"))
            except HTTPError as e:
                if e.code == 429:
                    time.sleep(2 * (attempt + 1))
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

    # ── Seed slugs (replaces seed_from_sitemaps.py) ──────────────────

    def seed_slugs(self, slugs: list[str], chunk_size: int = 500) -> dict:
        """
        Insert slugs in chunks. Returns aggregated result.
        Replace: conn.execute("INSERT OR IGNORE INTO model (slug) VALUES (?)", (slug,))
        """
        total_inserted = 0
        for i in range(0, len(slugs), chunk_size):
            chunk = slugs[i:i + chunk_size]
            result = self._post("/api/models/seed", {"slugs": chunk})
            if result.get("success"):
                total_inserted += result.get("inserted", 0)
            else:
                print(f"  WARN: seed chunk failed: {result.get('error')}")
        return {"success": True, "total_inserted": total_inserted}

    # ── Get next unfetched slugs ─────────────────────────────────────

    def next_unfetched(self, limit: int = 500) -> list[str]:
        """
        Get the next batch of slugs that need detail fetching.
        Replace: SELECT slug FROM model WHERE detail_fetched = 0 ORDER BY id LIMIT ?
        """
        result = self._post("/api/models/next", {"limit": limit})
        if result.get("success"):
            return result.get("slugs", [])
        else:
            print(f"  ERROR fetching next slugs: {result.get('error')}")
            return []

    # ── Store model detail (replaces _store_model()) ──────────────────

    def store_detail(self, slug: str, detail_data: dict, tags_list: list) -> bool:
        """
        Upsert full model detail + children (images, materials, colors, formats, tags).
        Replace: _store_model() in scrape_models.py

        Args:
            slug: Model slug
            detail_data: The 'data' dict from models.3dsky.org/api/models/show response
            tags_list: The 'data' list from tags.3dsky.org/api/tags/list response

        Returns True on success.
        """
        user = detail_data.get("user", {}) or {}
        platform = detail_data.get("platform", {}) or {}
        render = detail_data.get("render", {}) or {}
        form = detail_data.get("form", {}) or {}
        category = detail_data.get("category", {}) or {}
        subcategory = detail_data.get("subcategory", {}) or {}

        payload = {
            "slug": slug,
            "title": detail_data.get("title"),
            "title_en": detail_data.get("titleEn"),
            "description": detail_data.get("description"),
            "description_en": detail_data.get("descriptionEn"),
            "type": detail_data.get("type"),
            "type_text": detail_data.get("typeText"),
            "style": detail_data.get("style"),
            "style_en": detail_data.get("style_en"),
            "price": int(detail_data["price"]) if detail_data.get("price") else None,
            "price_usd": float(detail_data["price_usd"]) if detail_data.get("price_usd") else None,
            "polygons": detail_data.get("polygons"),
            "size_kb": detail_data.get("size_kb"),
            "length_cm": float(detail_data["length"]) if detail_data.get("length") else None,
            "width_cm": float(detail_data["width"]) if detail_data.get("width") else None,
            "height_cm": float(detail_data["height"]) if detail_data.get("height") else None,
            "platform": platform.get("title"),
            "platform_en": platform.get("titleEn"),
            "render": render.get("title"),
            "category_slug": category.get("slug"),
            "category_title": category.get("title"),
            "category_title_en": category.get("title_en"),
            "subcategory_slug": subcategory.get("slug"),
            "subcategory_title": subcategory.get("title"),
            "subcategory_title_en": subcategory.get("title_en"),
            "form_id": form.get("id"),
            "form_title": form.get("form"),
            "form_title_en": form.get("formEn"),
            "is_created_with_ai": bool(detail_data.get("is_created_with_ai")),
            "version": detail_data.get("version"),
            "created_at": detail_data.get("created"),
            # Child tables
            "images": [
                {"web_path": img.get("webPath", img.get("web_path", "")), "sort": img.get("sort", 0)}
                for img in detail_data.get("images", [])
            ],
            "materials": [
                {"material": mat.get("material"), "material_en": mat.get("materialEn")}
                for mat in detail_data.get("materials", [])
            ],
            "colors": [
                {"hex": col.get("color"), "title": col.get("title"), "title_en": col.get("titleEn")}
                for col in detail_data.get("colors", [])
            ],
            "formats": [
                {"title": fmt.get("title")}
                for fmt in detail_data.get("formats", [])
            ],
            "tags": [
                {"title": tag.get("title", ""), "multiple": tag.get("multiple", 1)}
                for tag in tags_list
                if tag.get("title")
            ],
        }

        result = self._post("/api/models/detail", payload)
        return result.get("success", False)

    # ── Check which slugs exist ──────────────────────────────────────

    def check_exists(self, slugs: list[str]) -> set[str]:
        """Return the subset of slugs that already exist in D1."""
        if not slugs:
            return set()
        result = self._post("/api/models/exists", {"slugs": slugs})
        if result.get("success"):
            return set(result.get("existing", []))
        print(f"  WARN: exists check failed: {result.get('error')}")
        return set()

    # ── Stats ────────────────────────────────────────────────────────

    def stats(self) -> dict:
        """Get database stats. Replace: SELECT COUNT(*) queries."""
        url = f"{self.base_url}/api/stats"
        req = Request(url, headers={
            "Authorization": f"Bearer {self.api_key}",
            "User-Agent": "3dskydb-client/1.0",
            "Accept": "application/json",
        })
        try:
            resp = urlopen(req, timeout=self.timeout)
            return json.loads(resp.read().decode("utf-8"))
        except Exception as e:
            return {"success": False, "error": str(e)}


# ── Quick test ──────────────────────────────────────────────────────
if __name__ == "__main__":
    import os
    import sys

    base_url = os.environ.get("CF_WORKER_URL", "")
    api_key = os.environ.get("CF_API_KEY", "")

    if not base_url or not api_key:
        print("Set CF_WORKER_URL and CF_API_KEY environment variables to test.")
        print("Usage:")
        print("  $env:CF_WORKER_URL='https://3dskydb-api.YOURSUB.workers.dev'")
        print("  $env:CF_API_KEY='your-secret'")
        print("  python cloudflare/client.py seed slugs.txt")
        sys.exit(1)

    client = CloudflareClient(base_url, api_key)

    if len(sys.argv) > 1:
        cmd = sys.argv[1]

        if cmd == "seed" and len(sys.argv) > 2:
            with open(sys.argv[2]) as f:
                slugs = [line.strip() for line in f if line.strip()]
            result = client.seed_slugs(slugs)
            print(json.dumps(result, indent=2))

        elif cmd == "next":
            slugs = client.next_unfetched(limit=10)
            print(f"Next {len(slugs)} unfetched slugs:")
            for s in slugs:
                print(f"  {s}")

        elif cmd == "stats":
            stats = client.stats()
            print(json.dumps(stats, indent=2))

        else:
            print(f"Unknown command: {cmd}")
    else:
        # Default: show stats
        stats = client.stats()
        print(json.dumps(stats, indent=2))
