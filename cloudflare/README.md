# 3dskydb → Cloudflare Setup

## 1. One-time: Create D1 database

```bash
cd cloudflare/worker
npm install
npx wrangler d1 create 3dskydb
```

Copy the `database_id` from the output into `wrangler.toml`.

## 2. Push the schema

```bash
npx wrangler d1 execute 3dskydb --file=../schema.sql
```

## 3. Set secrets

```bash
npx wrangler secret put API_KEY
# Enter a random string, e.g.: openssl rand -hex 32

npx wrangler secret put ADMIN_API_KEY
# Enter another random string (or reuse API_KEY)
```

## 4. Deploy the Worker

```bash
npx wrangler deploy
```

Note the URL (e.g. `https://3dskydb-api.YOURSUB.workers.dev`).

## 5. Seed initial data (from your local machine)

```powershell
$env:CF_WORKER_URL = "https://3dskydb-api.YOURSUB.workers.dev"
$env:CF_API_KEY = "your-secret-from-step-3"

# Dump existing slugs from local SQLite:
python -c "
import sqlite3
conn = sqlite3.connect('seed_from_sitemaps.db')
slugs = [r[0] for r in conn.execute('SELECT slug FROM model').fetchall()]
with open('slugs.txt', 'w') as f:
    for s in slugs: f.write(s + '\n')
print(f'{len(slugs)} slugs dumped')
"

# Push to D1:
python cloudflare/client.py seed slugs.txt
```

## 6. Set up GitHub Actions

Add these secrets in GitHub repo → Settings → Secrets and variables → Actions:

| Secret | Value |
|--------|-------|
| `CF_WORKER_URL` | `https://3dskydb-api.YOURSUB.workers.dev` |
| `CF_API_KEY` | Same as API_KEY from step 3 |
| `BRD_PROXY_URL` | Bright Data proxy URL (optional) |

The workflow runs every 6 hours automatically.

## Re-seed from sitemaps (manual)

```powershell
$env:CF_WORKER_URL = "..."
$env:CF_API_KEY = "..."

python -c "
from cloudflare.client import CloudflareClient
from seed_from_sitemaps import *
import os

client = CloudflareClient(os.environ['CF_WORKER_URL'], os.environ['CF_API_KEY'])
index = rate_limited_fetch(SITEMAP_INDEX)
urls = parse_sitemap_index(index)
slugs = []
for u in urls:
    slugs += extract_model_slugs_from_sitemap_gz(rate_limited_fetch(u))
unique = list(dict.fromkeys(slugs))
print(f'{len(unique)} slugs')
client.seed_slugs(unique)
"
```

## Local dev

```bash
cd cloudflare/worker
npx wrangler dev
# Worker runs at http://localhost:8787

# Test from another terminal:
curl -H "Authorization: Bearer your-secret" http://localhost:8787/api/stats
```
