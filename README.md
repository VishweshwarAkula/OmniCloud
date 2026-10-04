# OmniCloud

One library for your images: stored on this machine, in Google Drive, or in Dropbox. Find any image by describing it, skip duplicate uploads, and have receipts totalled automatically.

Everything runs locally with Docker: Postgres, Redis, Weaviate, the API, an autoscaled worker pool and the ML service. Nothing depends on a hosted database.

## Architecture

```
browser ──► web (nginx: SPA + /api proxy)
              │
              ▼
            api (Express) ──► postgres (users, files, receipts, tokens)
              │   │
              │   └─────────► redis (sessions, bloom filter, token cache, queues)
              │ BullMQ flow per upload
              ▼
   ┌──────────────── worker × N (competing consumers) ────────────────┐
   │  omni-upload ──┐                                                 │
   │  omni-embed  ──┼──► omni-finalize  (DB rows, bloom, cleanup)     │
   │  omni-ocr    ──┘                                                 │
   └──────────────────────────────────────────────────────────────────┘
              │ embed / ocr (client-side load balanced)
              ▼
            ml × M (FastAPI: SigLIP 2 + Gemini) ──► weaviate (vectors + BM25 metadata, tenant per user)

   autoscaler ──► docker-proxy (/containers only) ──► adds/removes worker & ml replicas
```

### Upload pipeline: staged competing consumers

Each upload becomes a BullMQ **flow**: three child jobs and one parent.

| Stage | Bound by | Per-replica default | Failure policy |
|---|---|---|---|
| `upload`: save to local disk, Drive or Dropbox | provider I/O | 6 concurrent | 5 tries, exponential backoff; fails the flow |
| `embed`: SigLIP 2 vector, zero-shot tags, EXIF metadata into Weaviate | ML CPU | 2 concurrent | 4 tries; fails the flow |
| `faces`: detect + cluster faces | ML CPU | 2 concurrent | 3 tries; optional |
| `ocr`: Gemini receipt read (only when `GOOGLE_API_KEY` is set) | external rate limit | 4 concurrent, 60/min | 3 tries; optional (the flow continues without it) |
| `finalize`: DB rows, receipt, bloom, temp cleanup | Postgres | 8 concurrent | runs after all children finish |

The three children run **in parallel**, and any replica can take any job. Every stage is idempotent, so retries and crash recovery (BullMQ stalled-job detection) are safe.

- **Fair share:** a job's priority is the number of files that user already has queued. A user uploading 500 files interleaves with everyone else instead of blocking them.
- **Dedup:** a per-user content hash is checked against the Bloom filter, then confirmed in Postgres. The flow id is `user_hash`, so concurrent duplicate uploads collapse into one flow. A hash only enters the Bloom filter after a successful finalize, so failed uploads stay retryable.
- **Backpressure:** the API returns `503` with `Retry-After` above `MAX_QUEUE_BACKLOG` queued jobs, and the web client retries automatically.

### Vision model and search

Images are indexed with **SigLIP 2** (`ViT-B-16-SigLIP2-256`, Google 2025). It's a large step up from the original CLIP ViT-B/32: about 79% vs 63% zero-shot ImageNet accuracy, multilingual, and its scores are **calibrated probabilities** (sigmoid loss), not just rankings.

For each image the ML service stores:

- **Visual embedding:** a 768-d vector.
- **Zero-shot classification:** a `kind` (photo, screenshot, document, receipt, illustration, chart, meme) and multi-label **tags** from ~130 concepts (`ml/app/labels.py`), kept only above a calibrated confidence (`TAG_MIN_PROB`).
- **Metadata:** EXIF capture time, camera, GPS and dimensions; a capture date taken from the filename (`IMG_20240316_…`); and words from the filename. Metadata also corrects the classifier: camera EXIF means `photo`, a screenshot filename or software tag means `screenshot`.
- **Searchable text:** kind, tags, filename words, date words (year, month, weekday, season, weekend, time of day, fixed holidays), camera and orientation, indexed for BM25.

Search is **hybrid**: a SigLIP 2 vector query and a BM25 query over tags and metadata run in parallel and are fused (`SEARCH_ALPHA`). Results are kept only if visually relevant in absolute terms (`SEARCH_MIN_PROB`, relative to the best match) or a strong keyword hit. "march 2024", "christmas eve", "canon" or "goa trip" work through metadata, and "a dog" in a library with no dogs returns **no matches** instead of the nearest wrong images.

| Model (CPU, 12 cores) | Per image | Notes |
|---|---|---|
| `ViT-B-16-SigLIP2-256` (default) | ~0.6 s | ~1.3 img/s across 3 replicas in the 400-image burst |
| `ViT-L-16-SigLIP2-256` | ~2.5 s | higher accuracy, ~3.5 GB RAM per replica |

To change model, set `EMBED_MODEL_NAME` in `.env`, run `make up` (which rebuilds the ml image with the weights baked in), then `make reindex`. Each model gets its own Weaviate collection, so vectors from different models never mix.

### Places, faces, query understanding, re-ranking

Each feature runs through an API when one is configured and falls back to a local implementation automatically (on any error, timeout, or when the API isn't configured). Settings → Processing → *Intelligence* shows which is active.

| Feature | API | Local fallback | Setting |
|---|---|---|---|
| **Places** (GPS → "Calangute, Goa, India") | OpenStreetMap Nominatim, opt-in because it sends photo GPS to a third party | GeoNames: 34k cities, offline, population-aware ("Dharavi, Mumbai") | `GEOCODER_MODE`, `NOMINATIM_URL` |
| **Faces** (detect, cluster, name, merge) | none, by design: face embeddings are biometric data and stay on this machine | OpenCV YuNet + SFace with incremental clustering | `FACES_MODE`, `FACE_MATCH_THRESHOLD`, `FACE_MIN_SIZE` |
| **Query understanding** | Gemini structured output | Rules: relative dates, seasons, months in any year, holidays, your named people and known places, kinds | `UNDERSTAND_MODE` |
| **Re-ranking** of the top N | Gemini vision scores the thumbnails | SigLIP prompt ensemble + first-stage score + MMR diversity | `RERANK_MODE`, `RERANK_TOP_N` |

**Search pipeline:**

1. **Understand** "Priya at the beach in Goa last summer" → people=[Priya], places=[Goa], dates=Jun–Aug, visual="beach".
2. **Filter:** Postgres turns the structured part into an allow-list of files.
3. **Retrieve:** hybrid SigLIP + BM25 inside the allow-list. The relevance cutoff is a per-image margin over a generic caption, because SigLIP's absolute scores on real photos are tiny even for correct matches.
4. **Re-rank** the top results.

A query that is only filters ("photos of Priya in 2023") skips the vector search entirely. Holidays and months without a year ("christmas", "december") match every year.

### Autoscaling

`autoscaler` runs a reconcile loop every 5 s:

```
replicas = clamp(ceil(queued jobs / TARGET), MIN, MAX)
```

- **worker** scales on the backlog across all four queues; **ml** scales on the `embed` backlog.
- **Scale up:** fast, up to +2 replicas per 15 s.
- **Scale down:** slow, one replica after the backlog has stayed low for 90 s.
- **Graceful drain:** removed workers get SIGTERM, stop taking jobs and finish in-flight ones within a 2-minute stop grace period.
- **Safety:** the autoscaler only removes replicas it created, so the compose baseline stays.
- **Docker access:** only through `docker-proxy`, which exposes the `/containers` API only, on the internal network.

You can watch it live in **Settings → Processing**, or with `make scale`.

### Security

- **Sessions:** server-side, stored in Redis as a hash of an httpOnly `SameSite=Lax` cookie. State-changing requests also require a CSRF header.
- **Sign-in:** Google OIDC with PKCE, plus an optional local email login (`DEV_LOGIN=true`, for local use only).
- **Provider tokens:** encrypted with AES-256-GCM. OAuth `state` is single-use and bound to the user.
- **Images:** served through HMAC-signed, expiring URLs with private caching.
- **Internal services:** the ML service is reachable only internally and requires a service token. Postgres and Redis are not published in the production compose.

## Quick start

```bash
make env     # creates .env with fresh secrets (Postgres password included)
# Either add GOOGLE_CLIENT_ID/SECRET, or set DEV_LOGIN=true to sign in with just an email
make up      # → http://localhost:8080
make ps      # migrate exits 0; everything else is healthy (ml takes ~1 min the first time)
```

Optional integrations:

- **Google sign-in and Drive:** create an OAuth client with redirect URIs `${PUBLIC_URL}/api/auth/google/callback` and `${PUBLIC_URL}/api/oauth/gdrive/callback`, and enable the Drive API.
- **Dropbox:** redirect URI `${PUBLIC_URL}/api/oauth/dropbox/callback`, with scopes `files.content.read/write` and `account_info.read`.
- **Receipt OCR:** set `GOOGLE_API_KEY` (Gemini).

Useful targets: `make dev` (hot reload on :5173), `make logs`, `make scale`, `make reindex`, `make psql`, `make redis-cli`, `make down`, `make reset` (**deletes all local data**).

Run without autoscaling: remove `autoscale` from `COMPOSE_PROFILES`. You get one worker and one ML replica, or a fixed number with `docker compose up -d --scale worker=4`.

## Layout

| Path | What it is |
|---|---|
| `web/` | React 19, Vite, Tailwind v4, TanStack Query, Motion |
| `api/src/server.js` | HTTP API |
| `api/src/worker.js` | Pipeline worker (`WORKER_QUEUES` selects stages) |
| `api/src/autoscaler.js` | Queue-driven replica autoscaler |
| `api/src/queues/` | Flow topology, fair-share priority, job status, backpressure |
| `api/migrations/` | SQL migrations, applied by the one-shot `migrate` service |
| `ml/` | Internal FastAPI service: `/embed` (vector, tags, metadata, place), `/faces`, `/understand`, `/search` (hybrid), `/rerank`, `/ocr`, `/index` |
| `api/src/reindex.js` | Re-embeds stored files after a model change |

## Tests and lint

```bash
make test   # vitest (api, web) + pytest (ml)
make lint   # eslint + ruff
```
