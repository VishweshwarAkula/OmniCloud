"""Internal ML service.

  /embed       SigLIP 2 vector + zero-shot tags + EXIF metadata + place names → Weaviate
  /faces       local face detection/recognition + incremental clustering into people
  /ocr         Gemini receipt reading
  /understand  query → structured filters        (Gemini, local rules fallback)
  /search      hybrid vector + BM25, optional allow-list
  /rerank      second-stage ordering             (Gemini vision, local SigLIP/MMR fallback)

Stateless with respect to the app database — the API workers own all Postgres writes.
"""

import asyncio
import hmac
import logging
from contextlib import asynccontextmanager
from dataclasses import dataclass
from datetime import date
from typing import Any

from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, UploadFile
from pydantic import BaseModel, Field

from . import metadata as md
from .config import Settings
from .ocr import Receipt
from .ranking import fuse
from .rerank import decode_images, gemini_rerank, local_rerank
from .understand import Understanding

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("ml")

MAX_IMAGE_BYTES = 40 * 1024 * 1024


@dataclass
class Services:
    model: Any
    store: Any
    reader: Any
    geocoder: Any = None
    faces: Any = None
    face_store: Any = None
    understander: Any = None
    gemini: Any = None
    rerank_mode: str = "local"


def build_services(settings: Settings) -> Services:
    from . import gemini
    from .embeddings import VisionModel
    from .ocr import ReceiptReader
    from .places import Geocoder
    from .understand import Understander
    from .vectorstore import FaceStore, VectorStore, collection_for

    g = gemini.client(settings.google_api_key)
    log.info("loading %s/%s", settings.clip_model, settings.clip_pretrained)
    model = VisionModel(settings.clip_model, settings.clip_pretrained, settings.torch_threads, settings.tag_min_prob)
    collection = settings.collection or collection_for(settings.clip_model)
    store = VectorStore(settings.weaviate_url, settings.weaviate_api_key, settings.weaviate_grpc_port, collection)

    faces = face_store = None
    if settings.faces_mode != "off":
        try:
            from .faces import FaceEngine

            faces = FaceEngine(f"{settings.data_dir}/faces", min_size=settings.face_min_size)
            face_store = FaceStore(store.client, settings.face_match_threshold)
        except Exception as exc:
            log.warning("face engine unavailable: %s", exc)

    s = Services(
        model=model,
        store=store,
        reader=ReceiptReader(g, settings.gemini_model),
        geocoder=Geocoder(settings.geocoder_mode, f"{settings.data_dir}/geonames", settings.nominatim_url),
        faces=faces,
        face_store=face_store,
        understander=Understander(settings.understand_mode, g, settings.gemini_model),
        gemini=g,
        rerank_mode="api" if (g and settings.rerank_mode in ("auto", "api")) else "local",
    )
    log.info("ready: model=%s dim=%s collection=%s capabilities=%s", model.name, model.dim, collection, capabilities(s))
    return s


def capabilities(s: Services) -> dict:
    return {
        "places": getattr(s.geocoder, "mode", None) if s.geocoder else None,
        "faces": "local" if s.faces else None,
        "understand": getattr(s.understander, "mode", None) if s.understander else None,
        "rerank": s.rerank_mode,
        "ocr": "api" if getattr(s.reader, "client", None) else None,
    }


class SearchReq(BaseModel):
    user_id: str = Field(min_length=1, max_length=128)
    query: str = Field(default="", max_length=300)
    keyword_query: str | None = Field(default=None, max_length=300)
    k: int | None = Field(default=None, ge=1, le=200)
    allow: list[str] | None = Field(default=None, max_length=5000)


class SearchHit(BaseModel):
    file_hash: str
    score: float
    prob: float


class SearchResp(BaseModel):
    results: list[SearchHit]


class Tag(BaseModel):
    label: str
    score: float


class Place(BaseModel):
    name: str
    area: str | None = None
    city: str | None = None
    region: str | None = None
    country: str | None = None
    source: str


class ImageMeta(BaseModel):
    taken_at: str | None = None
    width: int | None = None
    height: int | None = None
    camera: str | None = None
    lat: float | None = None
    lon: float | None = None
    place: Place | None = None
    kind: str
    tags: list[Tag]


class EmbedResp(BaseModel):
    weaviate_id: str
    model: str
    metadata: ImageMeta


class Face(BaseModel):
    face_id: str
    person_id: str
    bbox: list[float]
    score: float


class FacesResp(BaseModel):
    faces: list[Face]
    engine: str | None


class MergeReq(BaseModel):
    user_id: str
    sources: list[str] = Field(min_length=1, max_length=50)
    target: str


class UnderstandReq(BaseModel):
    query: str = Field(min_length=1, max_length=300)
    today: date | None = None
    people: list[str] = Field(default_factory=list, max_length=500)
    places: list[str] = Field(default_factory=list, max_length=2000)


class RerankCandidate(BaseModel):
    file_hash: str
    score: float


class RerankReq(BaseModel):
    user_id: str
    query: str = Field(min_length=1, max_length=300)
    candidates: list[RerankCandidate] = Field(max_length=100)
    images: dict[str, str] | None = None  # file_hash → base64 JPEG thumbnail (API mode)


class RerankResp(BaseModel):
    results: list[RerankCandidate]
    source: str


def create_app(settings: Settings | None = None, services: Services | None = None) -> FastAPI:
    settings = settings or Settings()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        app.state.services = services or await asyncio.to_thread(build_services, settings)
        yield
        if services is None:
            app.state.services.store.close()

    app = FastAPI(title="OmniCloud ML", version="4.0.0", lifespan=lifespan)

    def require_token(x_service_token: str = Header(default="")):
        if settings.service_token and not hmac.compare_digest(x_service_token, settings.service_token):
            raise HTTPException(401, "invalid service token")

    def svc() -> Services:
        return app.state.services

    async def read_image(image: UploadFile) -> bytes:
        raw = await image.read()
        if not raw:
            raise HTTPException(400, "empty image")
        if len(raw) > MAX_IMAGE_BYTES:
            raise HTTPException(413, "image too large")
        return raw

    @app.get("/healthz")
    def healthz():
        s: Services = app.state.services
        if not s.store.ready():
            raise HTTPException(503, "vector store unavailable")
        return {
            "ok": True,
            "model": s.model.name,
            "dim": s.model.dim,
            "capabilities": capabilities(s),
            "ocr": bool(getattr(s.reader, "client", None)),
        }

    def _index(s: Services, raw: bytes, user_id: str, file_hash: str, filename: str) -> EmbedResp:
        try:
            original, rgb = s.model.open_image(raw)
            meta = md.extract(original, filename)
        except Exception as exc:
            raise HTTPException(422, f"could not decode image: {exc}") from exc
        place = s.geocoder.reverse(meta.get("lat"), meta.get("lon")) if s.geocoder else None
        vec = s.model.image_vector(rgb)
        kind, tags, kind_probs = s.model.classify(vec)
        kind = md.refine_kind(kind, kind_probs, meta, filename)
        labels = [t for t, _ in tags]
        props = {
            "search_text": md.search_text(meta, kind, labels, place),
            "tags": labels,
            "kind": kind,
            "taken_at": f"{meta['taken_at']}Z" if meta["taken_at"] else None,
        }
        oid = s.store.upsert(user_id, file_hash, vec.cpu().tolist() if hasattr(vec, "cpu") else list(vec), props)
        return EmbedResp(
            weaviate_id=oid,
            model=s.model.name,
            metadata=ImageMeta(
                **{k: meta[k] for k in ("taken_at", "width", "height", "camera", "lat", "lon")},
                place=Place(**place) if place else None,
                kind=kind,
                tags=[Tag(label=t, score=p) for t, p in tags],
            ),
        )

    @app.post("/embed", response_model=EmbedResp, dependencies=[Depends(require_token)])
    async def embed(
        image: UploadFile = File(...),
        user_id: str = Form(..., min_length=1, max_length=128),
        file_hash: str = Form(..., pattern=r"^[0-9a-f]{64}$"),
        filename: str = Form(default="", max_length=512),
        s: Services = Depends(svc),
    ):
        raw = await read_image(image)
        return await asyncio.to_thread(_index, s, raw, user_id, file_hash, filename or image.filename or "")

    def _faces(s: Services, raw: bytes, user_id: str, file_hash: str) -> FacesResp:
        if not s.faces:
            return FacesResp(faces=[], engine=None)
        try:
            _, rgb = s.model.open_image(raw)
        except Exception as exc:
            raise HTTPException(422, f"could not decode image: {exc}") from exc
        found = s.faces.detect(rgb)
        assigned = s.face_store.assign(user_id, file_hash, found) if found else []
        return FacesResp(faces=[Face(**f) for f in assigned], engine=s.faces.name)

    @app.post("/faces", response_model=FacesResp, dependencies=[Depends(require_token)])
    async def faces(
        image: UploadFile = File(...),
        user_id: str = Form(..., min_length=1, max_length=128),
        file_hash: str = Form(..., pattern=r"^[0-9a-f]{64}$"),
        s: Services = Depends(svc),
    ):
        raw = await read_image(image)
        return await asyncio.to_thread(_faces, s, raw, user_id, file_hash)

    @app.post("/faces/merge", dependencies=[Depends(require_token)])
    async def merge_faces(req: MergeReq, s: Services = Depends(svc)):
        if not s.face_store:
            raise HTTPException(503, "faces disabled")
        n = await asyncio.to_thread(
            s.face_store.merge, req.user_id, [x for x in req.sources if x != req.target], req.target
        )
        return {"updated": n}

    @app.post("/ocr", response_model=Receipt, dependencies=[Depends(require_token)])
    async def ocr(image: UploadFile = File(...), s: Services = Depends(svc)):
        raw = await read_image(image)
        return await asyncio.to_thread(s.reader.read, raw, image.content_type or "image/jpeg")

    @app.post("/understand", response_model=Understanding, dependencies=[Depends(require_token)])
    async def understand(req: UnderstandReq, s: Services = Depends(svc)):
        return await asyncio.to_thread(
            s.understander.parse, req.query, req.today or date.today(), req.people, req.places
        )

    @app.post("/search", response_model=SearchResp, dependencies=[Depends(require_token)])
    async def search(req: SearchReq, s: Services = Depends(svc)):
        k = req.k or settings.topk_default
        visual = req.query.strip()
        keywords = (req.keyword_query if req.keyword_query is not None else visual).strip().lower()
        limit = max(k * 3, 30)
        vector = await asyncio.to_thread(s.model.text, visual) if visual else None
        vec_hits, kw_hits = await asyncio.gather(
            asyncio.to_thread(s.store.vector_candidates, req.user_id, vector, limit, req.allow) if vector else _empty(),
            asyncio.to_thread(s.store.keyword_candidates, req.user_id, keywords, limit, req.allow)
            if keywords
            else _empty(),
        )
        # Per-image baseline: similarity to a generic caption. margin = cos(query) - cos(baseline).
        base = s.model.baseline_vector()
        scored = {
            h: (cos, cos - sum(a * b for a, b in zip(base, vec, strict=False))) for h, (cos, vec) in vec_hits.items()
        }
        ranked = fuse(scored, kw_hits, s.model.prob, k, settings.search_alpha, settings.search_min_margin)
        return SearchResp(results=[SearchHit(file_hash=h, score=sc, prob=p) for h, sc, p in ranked])

    def _rerank(s: Services, req: RerankReq) -> RerankResp:
        cands = [(c.file_hash, c.score) for c in req.candidates]
        images = decode_images(req.images)
        if s.rerank_mode == "api" and s.gemini and images:
            try:
                scores = gemini_rerank(s.gemini, settings.gemini_model, req.query, images)
                first = dict(cands)
                ordered = sorted(scores, key=lambda h: (-scores[h], -first.get(h, 0)))
                rest = [(h, sc) for h, sc in cands if h not in scores]
                return RerankResp(
                    results=[RerankCandidate(file_hash=h, score=scores[h]) for h in ordered]
                    + [RerankCandidate(file_hash=h, score=sc) for h, sc in rest],
                    source="gemini",
                )
            except Exception as exc:
                log.warning("gemini rerank failed (%s); using local rerank", exc)
        vectors = s.store.vectors(req.user_id, [h for h, _ in cands])
        ranked = local_rerank(s.model, vectors, req.query, cands)
        return RerankResp(results=[RerankCandidate(file_hash=h, score=sc) for h, sc in ranked], source="local")

    @app.post("/rerank", response_model=RerankResp, dependencies=[Depends(require_token)])
    async def rerank(req: RerankReq, s: Services = Depends(svc)):
        return await asyncio.to_thread(_rerank, s, req)

    @app.delete("/index/{user_id}/{file_hash}", dependencies=[Depends(require_token)])
    async def delete(user_id: str, file_hash: str, s: Services = Depends(svc)):
        await asyncio.to_thread(s.store.delete, user_id, file_hash)
        if s.face_store:
            await asyncio.to_thread(s.face_store.delete_file, user_id, file_hash)
        return {"ok": True}

    return app


async def _empty():
    return {}


app = create_app()
