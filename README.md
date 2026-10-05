# OmniCloud

**One private, searchable library over all your free cloud storage.**

Upload photos and documents once. OmniCloud stores them in your own Google Drive, Dropbox, Koofr or pCloud account, indexes them on your machine, and lets you find anything by describing it:

- *"rahul at the beach in goa last summer"*
- *"screenshots of whatsapp chats"*
- *"TCP congestion control"*: jumps to page 668 of the right PDF

Everything runs locally in Docker. No account and no hosted database, and no AI APIs by default: the models run on your CPU.

## Use case

You have several free cloud tiers (15 GB Drive, 10 GB Koofr, 10 GB pCloud, 2 GB Dropbox) and a laptop that's running out of space. With OmniCloud you can:

1. **Free up space.** Drop files or whole folders into OmniCloud. They land in the cloud you pick, with their real names and folder structure (`OmniCloud/Trips/Goa 2024/IMG_1.jpg`). After that you can delete the local originals: the cloud copy stays usable on its own, even without OmniCloud.
2. **Find things again** across every cloud from one gallery, by meaning rather than by file name:
   - **Photos** by content, people, place and date.
   - **Documents** by what they say, opening at the right page.
3. **Keep it private.** It's single-user and reachable only from `127.0.0.1`. Faces, search and indexing never leave the machine.

## Features

- **Photo search:** SigLIP 2 image embeddings plus zero-shot tags, EXIF (date, camera, GPS → offline place names), and hybrid vector + keyword ranking that answers *"no matches"* instead of guessing.
- **Document search:** PDF, DOCX, TXT and Markdown are split into passages, embedded with multilingual e5, and searched by meaning. Results show the matching page and a snippet.
- **People:** on-device face detection and clustering. You can name, merge or hide people.
- **Query understanding:** rules turn dates like *"last summer"* into ranges. A local **Qwen3-0.6B** model (llama.cpp) handles typos, other languages and paraphrases.
- **Uploads:** files or whole folders, with deduplication by content hash and live progress.
  - **Cancel** one upload or a whole batch at any stage. Everything is undone, including a copy that had already reached the cloud.
- **Delete** a file or a whole folder. You choose *Remove from OmniCloud* (the cloud copy stays) or *Delete from cloud too*.
- **Scales with the queue:** a queue-driven autoscaler adds worker and ML replicas while there's a backlog.

## Quick start

**Prerequisites:**
- Docker with Compose v2.
- About 10 GB of free disk; the ML image is about 5 GB with its models built in.
- 8 GB of RAM.

```bash
git clone https://github.com/VishweshwarAkula/OmniCloud.git && cd OmniCloud
make up          # creates .env with fresh secrets, builds, starts everything
```

Open **http://localhost:8080** (or your `WEB_PORT`), go to **Settings** and connect a cloud:

| Cloud | Free tier | Setup |
|---|---|---|
| **Koofr** | 10 GB | Nothing to configure. Click *Connect Koofr* and paste an app password (Koofr → Preferences → Password → App passwords). |
| **Google Drive** | 15 GB | Create an OAuth client (Web), enable the Drive API, set the redirect URI to `${PUBLIC_URL}/api/oauth/gdrive/callback`, then put `GOOGLE_CLIENT_ID`/`SECRET` in `.env`. |
| **Dropbox** | 2 GB | Create an app (scopes `files.content.read/write`, `account_info.read`), set the redirect URI to `${PUBLIC_URL}/api/oauth/dropbox/callback`, then put `DROPBOX_CLIENT_ID`/`SECRET` in `.env`. |
| **pCloud** | 10 GB | Request an app at docs.pcloud.com, set the redirect URI to `${PUBLIC_URL}/api/oauth/pcloud/callback`, then put `PCLOUD_CLIENT_ID`/`SECRET` in `.env`. |

After editing `.env`, run `docker compose up -d` so the containers pick it up.

## Architecture

```
browser ─► web (nginx: React SPA + /api proxy, 127.0.0.1 only)
             │
             ▼
           api (Express) ─────► postgres   files, people, faces, encrypted cloud tokens
             │                ► redis      BullMQ queues, locks, caches, dedup bloom filter
             │ one BullMQ flow per upload
             ▼
   worker × N ──► upload ──┐
                  embed  ──┼──► finalize        (images)
                  faces  ──┘
                  upload ──┬──► finalize        (documents)
                  docindex ┘
             │
             ▼
           ml × M (FastAPI) ─► weaviate   image / passage / face vectors + BM25, tenant per user
             SigLIP 2 · e5-small · Qwen3-0.6B · YuNet + SFace · GeoNames

   autoscaler ─► docker-proxy (containers API only) ─► scales worker and ml replicas
   clouds: Google Drive · Dropbox · Koofr (WebDAV) · pCloud
```

| Service | Role |
|---|---|
| `web` | React UI (Vite, Tailwind, Motion) served by nginx, which proxies `/api`. |
| `api` | REST API: upload staging, search, people, providers, signed media URLs. No login; it rejects any request that isn't addressed to localhost. |
| `worker` | Pipeline stages as competing BullMQ consumers. Any replica can take any job. |
| `ml` | Embeddings, tagging, faces, places, document parsing, query understanding, hybrid search and re-ranking. Runs offline: models are built into the image. |
| `postgres` | Source of truth for files, people and faces. Migrations run before the API starts. |
| `redis` | Queues, distributed locks, caches and a Bloom filter for fast "is this new?" checks. |
| `weaviate` | Vector and BM25 index: one collection per model, one tenant per user. |
| `autoscaler` | `replicas = clamp(ceil(backlog / target), min, max)` for workers and ML. |

## How it works

**Upload:**
1. The browser streams each file to the API, which hashes it (SHA-256).
   - **Duplicates:** checked against the Bloom filter, then Postgres.
   - **New files:** staged on disk, then a flow (a parent job with child stages) is enqueued with id `user_hash`.
2. `upload` puts the file in the chosen cloud under its real name and folder. `embed` (or `docindex` for documents) and `faces` run in parallel.
3. `finalize` writes metadata, faces and people, adds the hash to the Bloom filter and deletes the staged copy.
   - **Gallery:** shows the result right away. Thumbnails and files stream from the cloud through short-lived signed URLs.

**Search:**
1. **Understand:** rules plus Qwen3 turn the query into a visual description plus filters (dates, people, places, kinds).
2. **Filter:** Postgres turns those filters into a list of allowed files.
3. **Retrieve:** a hybrid vector + BM25 search inside that list, for photos and document passages.
4. **Gate:** a calibrated relevance threshold decides what counts as a match.
5. **Re-rank:** a local re-ranking pass orders the top results.

The UI shows results immediately, then swaps in the re-ranked order.

**Consistency.** A cloud, a vector index and Postgres can't share a transaction, so every multi-system step is ordered, idempotent and safe to retry:
- **Upload:** the cloud file id is saved on the job the moment the upload succeeds. A retry never uploads a second copy, and failure or cancel handlers can still find the copy and remove it.
- **Delete:** cloud first, then the index, then the database row and people counts in one transaction. Every step tolerates "already gone".
- **Cancel:** a per-upload flag that workers check before and after each stage. Cleanup can run more than once; the pending-count release happens once per upload.
- **Cross-process locks (Redis):** for Drive folder find-or-create, face clustering and merges, and duplicate enqueues.
- **People counts:** recounted under row locks.
- **Document re-index:** new passages overwrite the old ones first, then leftovers are trimmed.
- **Koofr:** uploads are create-only (`If-None-Match: *`).
- **Folder removal:** a cloud folder is removed only if nothing tracked or in flight lives in it. Drive folders go to the trash.

## Configuration

`make env` creates `.env` from `.env.example`. The settings that matter most:

| Variable | Default | Purpose |
|---|---|---|
| `WEB_PORT`, `PUBLIC_URL` | `8080`, `http://localhost:8080` | Where the app is served. OAuth redirect URIs are built from `PUBLIC_URL`. |
| `DATA_DIR` | `./.data` | Bind mounts for Postgres, Redis, Weaviate and staged uploads. |
| `OWNER_EMAIL` | (empty) | Which library to show (single user). |
| `UNDERSTAND_MODE` | `llm` | `llm` (rules + Qwen3) · `rules` · `api` (Gemini, needs `GOOGLE_API_KEY`). |
| `RERANK_MODE` | `local` | `local` (SigLIP + MMR) · `api` (Gemini vision). |
| `EMBED_MODEL_NAME` | `ViT-B-16-SigLIP2-256` | Vision model. After changing it, run `make up && make reindex`. |
| `WORKER_MIN/MAX`, `ML_MIN/MAX` | `1/8`, `1/3` | Autoscaler bounds. |
| `MAX_UPLOAD_MB`, `MAX_DOC_MB` | `25`, `50` | Per-file limits for images and documents. |

## Development

```bash
make dev       # hot reload; UI on http://localhost:5173 (set PUBLIC_URL to match)
make test      # API (vitest) + web (vitest) + ML (pytest, inside the ml image)
make lint      # eslint + ruff
make logs | make ps | make scale | make psql | make redis-cli
make reindex   # re-embed after a model change, and index documents whose indexing failed
```

The API and web tests need `npm ci` in `api/` and `web/` first.

```
api/   Express API, BullMQ worker and autoscaler, cloud providers, SQL migrations
ml/    FastAPI ML service: models, Weaviate store, ranking, documents, local LLM
web/   React app and nginx config
site/  privacy policy page for the Google OAuth consent screen (GitHub Pages)
```

## Limits

- **Scanned PDFs** have no text layer and are found by title only (there's no OCR).
- **Google Drive:** the app uses the narrow `drive.file` permission, so it only sees files it uploaded itself. A cloud folder can still hold other files; that's why Drive folders are moved to the trash rather than deleted.
- **Hardware:** CPU-only. A new search takes about 1.5 s (most of it the local LLM), and repeated searches are cached. A 900-page PDF takes a few minutes to index.
