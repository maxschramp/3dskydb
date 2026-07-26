# 3dsky.org — Inferred Database Schema

> Reconstructed 2026-07-22 by intercepting API calls and reading page structure.
> Architecture: **PHP/Symfony microservices** behind subdomain router.

---

## Microservice Map

| Subdomain | Purpose | Key Endpoint |
|---|---|---|
| `3dsky.org` | Main SPA + listing API | `POST /api/models` |
| `models.3dsky.org` | Model detail, recommend, cart state | `POST /api/models/show`, `/recommend`, `/button` |
| `comments.3dsky.org` | Comments | `POST /api/comments/list` |
| `bookmarks.3dsky.org` | Bookmarks / favorites | `POST /api/bookmark/model/count` |
| `likes.3dsky.org` | Votes / likes | `POST /api/vote/model/like-users` |
| `tags.3dsky.org` | Tags | `POST /api/tags/list` |
| `labels.3dsky.org` | Labels (collections?) | `POST /api/labels/list` |
| `users.3dsky.org` | User profiles | `POST /api/users` |
| `notifier.3dsky.org` | Notifications | `POST /api/notifier/list` |

All APIs return: `{"success":bool, "status":int, "message":str, "data":..., "errors":[]}`

---

## Entity Schemas

### `model` (core)

| Column | Type | Source | Notes |
|---|---|---|---|
| `id` | bigint | (inferred PK) | Not exposed via API |
| `slug` | varchar(255) UNIQUE | `slug` | URL-safe, e.g. `bathroom-accessories-48-1` |
| `title` | varchar(512) | `title` | Russian |
| `title_en` | varchar(512) | `titleEn` / `title_en` | English (nullable) |
| `description` | text | `description` | Russian, Markdown-like |
| `description_en` | text | `descriptionEn` | English (nullable) |
| `type` | tinyint | `type` | 2 = PRO (maybe 1 = Free?) |
| `type_text` | varchar(16) | `typeText` | `pro`, `free`? |
| `style` | varchar(64) | `style` | Russian |
| `style_en` | varchar(64) | `style_en` | English |
| `price` | int | `price` | Internal currency (RUB?) |
| `price_usd` | decimal(8,2) | `price_usd` | USD price, e.g. `7` |
| `polygons` | int | `polygons` | e.g. 412118 |
| `size_kb` | int | `size_kb` | File size in KB |
| `length_cm` | decimal(8,2) | `length` | cm (nullable) |
| `width_cm` | decimal(8,2) | `width` | cm (nullable) |
| `height_cm` | decimal(8,2) | `height` | cm (nullable) |
| `is_created_with_ai` | bool | `is_created_with_ai` | |
| `is_first` | bool | `is_first` | First-time listing? (listing API only) |
| `data_file_size` | bigint | `data_file_size` | Bytes (listing API) |
| `version` | datetime | `version` | Last update timestamp |
| `created_at` | datetime | `created` | Publish timestamp |
| `user_id` | bigint FK | `user` | → `user.id` |
| `category_id` | int FK | `category` | → `category.id` |
| `subcategory_id` | int FK | `subcategory` | → `subcategory.id` |
| `platform_id` | int FK | `platform` | → `platform.id` |
| `render_id` | int FK | `render` | → `render.id` (nullable?) |
| `form_id` | int FK | `form` | → `form.id` (nullable) |
| `search_hash` | varchar(32) | (listing meta) | For cursor/stable pagination |

### `user`

| Column | Type | Source | Notes |
|---|---|---|---|
| `id` | bigint | (inferred) | |
| `slug` | varchar(128) UNIQUE | `slug` | e.g. `mojganrasouli` |
| `username` | varchar(128) | `username` | |
| `fio` | varchar(256) | `fio` | Full name (nullable) |
| `email` | varchar(256) | (inferred) | Not exposed |
| `password_hash` | varchar(256) | (inferred) | |
| `avatar` | varchar(255) | `avatar` | Filename on disk |
| `gender` | tinyint | `gender` | 1 = female? |
| `birthdate` | date | `birthdate` | (nullable) |
| `sign` | varchar(32) | `sign` | Zodiac? (nullable) |
| `occupation` | varchar(256) | `occupation` | (nullable) |
| `location` | varchar(256) | `location` | (nullable) |
| `site` | text | `site` | HTML link (nullable) |
| `portfolio` | text | `portfolio` | (nullable) |
| `karma` | int | `karma` | |
| `is_banned` | bool | `isBanned` | |
| `is_warned` | bool | `isWarned` | |
| `is_ro` | bool | `isRo` | Read-only? |
| `is_deleted` | bool | `isDeleted` | Soft delete |
| `is_enabled` | bool | `isEnabled` | |
| `created_at` | datetime | `createdAt` | |
| `subscribe_users_count` | int | `subscribeUsersCount` | Denormalized |

### `user_rating`

| Column | Type | Notes |
|---|---|---|
| `user_id` | bigint FK | → `user.id` |
| `title` | varchar(64) | Russian, e.g. "Бронза" |
| `title_en` | varchar(64) | e.g. "Bronze" |
| `icon` | varchar(64) | e.g. `bronze.png` |
| `sells` | int | Sales threshold for this tier |
| `percent` | int | Progress % to next tier |

### `category`

| Column | Type | Source |
|---|---|---|
| `id` | int | (inferred) |
| `slug` | varchar(64) UNIQUE | `category.slug` |
| `title` | varchar(128) | Russian |
| `title_en` | varchar(128) | English |
| `link` | varchar(256) | URL path |

**Known categories:** architecture, bathroom, childroom, decoration, furniture, kitchen, lighting, materials, other-models, plants, scripts, technology, textures, transport

### `subcategory`

| Column | Type | Source |
|---|---|---|
| `id` | int | (inferred) |
| `slug` | varchar(64) UNIQUE | `subcategory.slug` |
| `title` | varchar(128) | Russian |
| `title_en` | varchar(128) | English |
| `link` | varchar(256) | URL path |
| `category_id` | int FK | → `category.id` |

**Known Bathroom subcategories:** bathroom-accessories, bathroom-furniture, bathtubs, faucets, showers, toilet-and-bidet, towel-rails, wash-basins

### `model_image`

| Column | Type | Source |
|---|---|---|
| `id` | bigint | `images[].id` (listing API) |
| `model_id` | bigint FK | → `model.id` |
| `file_name` | varchar(128) | `images[].file_name` |
| `web_path` | varchar(512) | `images[].web_path` or `webPath` |
| `sort` | int | `images[].sort` (0-based) |

### `platform`

| Column | Type | Source |
|---|---|---|
| `id` | int | (inferred) |
| `title` | varchar(256) | e.g. `3dsMax 2017 + obj` |
| `title_en` | varchar(256) | |

### `render`

| Column | Type | Source |
|---|---|---|
| `id` | int | (inferred) |
| `title` | varchar(128) | e.g. `Vray+Corona`, `Corona`, `V-Ray` |

**Known renders:** Vray, Corona, Standard

### `form_factor` (shape)

| Column | Type | Source |
|---|---|---|
| `id` | int | `form.id` |
| `form` | varchar(64) | Russian name |
| `form_en` | varchar(64) | English name |
| `html_svg` | text | Inline SVG markup |

**Known forms (10 total, based on page):**
ID 1–10 (10 image-based shape buttons on site). Known: id=4 → Rectangle (Прямоугольник)

### `format` (file format)

| Column | Type | Source |
|---|---|---|
| `id` | int | (inferred) |
| `title` | varchar(16) | e.g. `.obj`, `.fbx` |

### `material`

| Column | Type | Source |
|---|---|---|
| `id` | int | (inferred) |
| `title` | varchar(64) | Russian, e.g. "Дерево" |
| `title_en` | varchar(64) | English, e.g. "Wood" |

**Known:** Brick, Ceramics, Concrete, Fabric, Fur, Glass, Gypsum, Leather, Liquid, Metal, Organics, Paper, Plastic, Rattan, Stone, Wood

### `color`

| Column | Type | Source |
|---|---|---|
| `id` | int | (inferred) |
| `hex` | char(7) | `color` (e.g. `#783c00`) |
| `title` | varchar(64) | Russian |
| `title_en` | varchar(64) | English |

### `model_material` (M:N join)

| Column | Type |
|---|---|
| `model_id` | bigint FK |
| `material_id` | int FK |

### `model_color` (M:N join)

| Column | Type |
|---|---|
| `model_id` | bigint FK |
| `color_id` | int FK |

### `model_format` (M:N join)

| Column | Type |
|---|---|
| `model_id` | bigint FK |
| `format_id` | int FK |

### `comment`

| Column | Type | Source |
|---|---|---|
| `id` | bigint | `id` |
| `entity` | varchar(32) | `entity` (e.g. "model") — polymorphic |
| `entity_slug` | varchar(255) | `slug` from request |
| `user_slug` | varchar(128) | `user_slug` |
| `user_name` | varchar(128) | `user_name` |
| `user_avatar` | varchar(255) | `user_avatar` |
| `text` | text | `text` (Russian) |
| `text_en` | text | `text_en` |
| `is_deleted` | bool | |
| `is_author` | bool | Is the model author? |
| `is_buyer` | bool? | (nullable) |
| `likes` | int | |
| `dislikes` | int | |
| `has_responses` | bool | |
| `created_at` | datetime | `created` |

### `comment_response`

| Column | Type |
|---|---|
| `id` | bigint |
| `comment_id` | bigint FK |
| `user_slug` | varchar(128) |
| `text` | text |
| … (similar to comment) |

### `tag`

| Column | Type | Source |
|---|---|---|
| `id` | int | (inferred) |
| `title` | varchar(64) | |
| `multiple` | bool | Can appear on multiple models? (always 1) |

### `model_tag` (M:N)

| Column | Type |
|---|---|
| `model_id` | bigint FK |
| `tag_id` | int FK |

### `bookmark`

| Column | Type | Source |
|---|---|---|
| `user_id` | bigint FK | (inferred from auth) |
| `model_slug` | varchar(255) | `slug` |
| `created_at` | datetime | |

### `vote` (like)

| Column | Type | Source |
|---|---|---|
| `user_slug` | varchar(128) | `user_slug` |
| `model_slug` | varchar(255) | `slug` |
| `created_at` | datetime | |

### `label`

| Column | Type | Source |
|---|---|---|
| `id` | int | (inferred) |
| `title` | varchar(128) | |
| `slug` | varchar(64) | |

### `model_label` (M:N)

| Column | Type |
|---|---|
| `model_id` | bigint FK |
| `label_id` | int FK |

### `collection`

| Column | Type | Notes |
|---|---|---|
| `id` | bigint | |
| `user_id` | bigint FK | |
| `title` | varchar(256) | |
| `slug` | varchar(64) | Seen: `5501032` (numeric ID as slug) |
| `is_shared` | bool | |

### `collection_model` (M:N)

| Column | Type |
|---|---|
| `collection_id` | bigint FK |
| `model_id` | bigint FK |

### `notification`

| Column | Type |
|---|---|
| `id` | bigint |
| `user_id` | bigint FK |
| `locale` | char(2) |
| `type` | varchar(32) |
| `data` | json |
| `is_read` | bool |
| `created_at` | datetime |

---

## ER Diagram (conceptual)

```
┌──────────┐       ┌─────────────┐
│   user   │1────n│    model     │
└──────────┘       └─────────────┘
                         │
         ┌───────────────┼───────────────────────────────┐
         │               │                               │
    ┌────┴────┐    ┌─────┴──────┐                  ┌─────┴─────┐
    │ category│    │subcategory │                  │   form    │
    └─────────┘    └────────────┘                  └───────────┘
                         │
         ┌───────────────┼────────────────────────────┬──────────────┐
         │               │                            │              │
    ┌────┴────┐   ┌──────┴──────┐   ┌────────┐  ┌────┴────┐  ┌─────┴─────┐
    │platform │   │   render    │   │ format │  │material │  │   color   │
    └─────────┘   └─────────────┘   └────────┘  └─────────┘  └───────────┘
         │               │              │            │              │
         └───────────────┴──────────────┴────────────┴──────────────┘
                              (all M:1 to model)

┌──────────┐       ┌─────────────┐       ┌──────────┐
│  comment │n────1│    model     │1────n│ model_image│
└──────────┘       └─────────────┘       └──────────┘
                         │
         ┌───────────────┼────────────────┐
         │               │                │
    ┌────┴────┐   ┌──────┴──────┐   ┌─────┴─────┐
    │bookmark │   │    vote     │   │model_tag  │─── tag
    └─────────┘   └─────────────┘   └───────────┘
```

---

## API Contract Summary

### Listing: `POST https://3dsky.org/api/models`

**Request (empty = all models, default sort):**
```json
{}
```
**Request (filtered):**
```json
{"categories": ["bathroom-accessories", "bathroom-furniture", ...]}
```
Other filter keys (inferred): `styles`, `renders`, `formats`, `forms`, `materials`, `colors`, `tags`, `sort`, `page`, `per_page`

**Response:**
```json
{
  "status": 200,
  "message": "OK",
  "data": {
    "search_hash": "728f77650510",
    "total_value": 1211921,
    "page": 1,
    "per_page": 60,
    "models": [
      {
        "title": "...",
        "title_en": "...",
        "slug": "...",
        "votes_count": "12",
        "comments_count": "2",
        "data_file_size": "114518613",
        "is_first": true,
        "images": [
          {"file_name": "...", "id": "8988818", "web_path": "...", "sort": "0"}
        ]
      }
    ]
  }
}
```

### Detail: `POST https://models.3dsky.org/api/models/show`
```json
{"slug": "bathroom-accessories-48-1"}
```
Returns full model object with user, platform, render, images, materials, colors, formats, form, category, subcategory.

### Also available via GET: `GET https://3dsky.org/api/models/{slug}`
Returns subset of fields (entity wrapper).

---

## Key Observations

1. **1.2M models** as of 2026-07-22
2. **Dual-language**: Every text field has `_en` variant (Russian primary)
3. **PRO badge**: `type=2` / `typeText="pro"`. Non-PRO presumably `type=1` / `typeText="free"`
4. **Pricing**: `$7` per model (PRO), internal `price` in another currency (likely RUB)
5. **Polymorphic comments**: comment `entity` field = `"model"` — suggests comments can attach to other entities
6. **No IDs exposed**: The API uses `slug` as the primary external identifier, not numeric IDs
7. **Image paths**: `model_images/0000/0000/XXXX/XXXXXXX.hash.jpeg` — sharded by ID prefix
8. **search_hash**: Acts as a stable cursor for pagination — returned with each listing response

---

## Database Size Estimate

| Component | Rows | ~Bytes/row | Total |
|---|---|---|---|
| `model` (slugs only) | 1.2M | ~180 | ~210 MB |
| `model` (full detail) | 1.2M | ~600 | ~720 MB |
| `model_tag` (M:N, ~5 tags/model) | 6M | ~20 | ~120 MB |
| `model_image` (~7/model) | 8.4M | ~80 | ~670 MB |
| `model_material`, `model_color`, `model_format` | ~3.6M | ~40 | ~145 MB |
| Indices (all tables) | — | ~50% overhead | ~800 MB |
| **Total (full detail)** | | | **~2.5 GB** |
| **Total (slugs only, current)** | | | **~225 MB** |

---

## Detail Scraping (Step 3)

### Tool: `scrape_models.py`

Fetches model detail + tags for all slugs not yet marked `detail_fetched = 1`.

**Endpoints hit (2 per model):**
1. `POST models.3dsky.org/api/models/show` — ~4.5 KB (detail: polygons, materials, colors, formats, platform, render, category, etc.)
2. `POST tags.3dsky.org/api/tags/list` — ~0.5 KB

**Average payload:** ~5 KB per model (both endpoints combined).

**Usage:**
```bash
# Dry run (no requests)
python scrape_models.py --dry-run

# Test with 3 models
python scrape_models.py --limit 3

# Full run (single-threaded, 1 req / 3 sec)
python scrape_models.py

# With Bright Data proxy, 10 parallel workers
python scrape_models.py --proxy http://user:pass@proxy.brd.superproxy.io:22225 --workers 10 --delay 0.5
```

**Cost estimate (Bright Data residential @ $4/GB):**

| Metric | Value |
|---|---|
| Models to fetch | ~1.2M |
| Data per model | ~5 KB |
| Total download | ~5.85 GB |
| Upload (request bodies) | ~0.13 GB |
| **Total data** | **~6 GB** |
| **Estimated cost** | **~$24** |

**Time estimate:**

| Workers | Delay | Time |
|---|---|---|
| 1 | 3.0s | ~1,026 hours (43 days) |
| 10 | 0.5s | ~17 hours |
| 20 | 0.3s | ~5 hours |

**Resumability:** The script tracks `detail_fetched` and `detail_fetched_at` on each row. Killed/restarted runs pick up where they left off. Errors are logged to `scrape_errors` table.

**Progress reporting:** Every 30 seconds prints: fetched count, error count, rate (models/min), ETA, and GB downloaded.

SQLite handles this comfortably with WAL journal mode.

---

## Seeding Process

### Step 1: Sitemap extraction

3dsky.org publishes 24 gzipped sitemaps at:
```
https://3dsky.org/sitemaps/sitemap_index_en.xml
```

**Script:** `seed_from_sitemaps.py`

1. Fetch sitemap index → 24 `.xml.gz` URLs
2. Download each (rate-limited 1 req / 3 sec), gunzip, parse XML
3. Extract slugs from `<loc>` tags matching `/3dmodels/show/{slug}`
4. `INSERT OR IGNORE` into `model(slug)`
5. Compare count vs live total from `POST /api/models`

**Result (2026-07-22):** 1,154,444 slugs from sitemaps vs 1,211,924 live = **57,480 gap (4.7%)**

### Step 2: Paginated API crawl (fill gap)

The listing API (`POST /api/models`) supports pagination via `{"page": N}` **only when a `Referer` header is present**. Without it, the API rejects pagination params with HTTP 400.

**Script:** `fill_missing_slugs2.py`

1. Start at page 1 (newest models)
2. For each page, `INSERT OR IGNORE` any slugs not yet in DB
3. Stop after 20 consecutive pages with 0 new slugs
4. Rate limit: 1 req / 3 sec (20 pages/min = 1,200 slugs/min)

**Why this works:** The sitemaps are comprehensive but stale. New models added since the last sitemap generation appear on the earliest API pages (sorted newest-first). Once we hit pages where all 60 slugs are already in the DB, we've caught up.

**Time estimate:** ~57k missing models ÷ 1,200/min ≈ **48 minutes** worst case. In practice, often much faster because the gap concentrates in the first few hundred pages.

### Rate Limit

The API returns 400 if hit too fast. All scripts enforce `MIN_INTERVAL = 3.0` seconds between requests.

### DB Path

`seed_from_sitemaps.db` in the project root. WAL mode, `synchronous=NORMAL`.
