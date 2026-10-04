import hashlib
import io

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app.config import Settings
from app.embeddings import VisionModel
from app.main import Services, create_app
from app.ocr import Receipt
from app.understand import Understander


def jpeg(color=(200, 30, 30)) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (64, 48), color).save(buf, "JPEG")
    return buf.getvalue()


class FakeModel:
    name = "fake/model"
    dim = 2
    bias = 0.0
    open_image = staticmethod(VisionModel.open_image)

    def image_vector(self, rgb):
        return [0.6, 0.8]

    def text(self, q):
        return [0.6, 0.8]

    def baseline_vector(self):
        return [0.0, 0.0]

    def classify(self, vec):
        return "screenshot", [("red", 0.91), ("shapes", 0.4)], {"screenshot": 0.4, "receipt": 0.01}

    def prob(self, cos):
        return cos


class FakeStore:
    def __init__(self):
        self.objects = {}

    def ready(self):
        return True

    def upsert(self, user, h, vec, props):
        self.objects[(user, h)] = props
        return f"id-{h[:6]}"

    def vector_candidates(self, user, vec, limit, allow=None):
        return {h: (0.9, [0.6, 0.8]) for (u, h) in self.objects if u == user and (allow is None or h in allow)}

    def keyword_candidates(self, user, query, limit, allow=None):
        return {
            h: 3.0
            for (u, h), p in self.objects.items()
            if u == user and query in p["search_text"] and (allow is None or h in allow)
        }

    def vectors(self, user, hashes):
        return {h: [0.6, 0.8] for (u, h) in self.objects if u == user and h in hashes}

    def delete(self, user, h):
        self.objects.pop((user, h), None)

    def close(self):
        pass


class FakeFaces:
    name = "fake-faces"

    def detect(self, rgb):
        return [{"bbox": [0.1, 0.1, 0.2, 0.2], "score": 0.99, "embedding": [1.0, 0.0]}]


class FakeFaceStore:
    def __init__(self):
        self.merged = None

    def assign(self, user, h, faces):
        return [{"face_id": "f1", "person_id": "p1", "bbox": f["bbox"], "score": f["score"]} for f in faces]

    def merge(self, user, sources, target):
        self.merged = (sources, target)
        return 3

    def delete_file(self, user, h):
        pass


class FakeReader:
    client = None

    def read(self, data, mime):
        return Receipt(is_receipt=True, total=99.5, currency="INR", vendor="Cafe", confidence=0.9)


@pytest.fixture
def ctx():
    store = FakeStore()
    services = Services(
        model=FakeModel(),
        store=store,
        reader=FakeReader(),
        faces=FakeFaces(),
        face_store=FakeFaceStore(),
        understander=Understander("local", None, ""),
    )
    with TestClient(create_app(Settings(service_token="s3cret"), services)) as c:
        yield c, store


H = {"X-Service-Token": "s3cret"}
HASH = hashlib.sha256(b"img").hexdigest()


def test_health_reports_model(ctx):
    client, _ = ctx
    assert client.get("/healthz").json()["model"] == "fake/model"


def test_requires_service_token(ctx):
    client, _ = ctx
    assert client.post("/search", json={"user_id": "u", "query": "dog"}).status_code == 401


def test_embed_returns_tags_and_metadata(ctx):
    client, store = ctx
    files = {"image": ("IMG_20240316_183012.jpg", jpeg(), "image/jpeg")}
    r = client.post("/embed", headers=H, files=files, data={"user_id": "u1", "file_hash": HASH})
    assert r.status_code == 200, r.text
    meta = r.json()["metadata"]
    # no camera EXIF, no screenshot hint → the visual guess stands
    assert meta["kind"] == "screenshot" and meta["tags"][0] == {"label": "red", "score": 0.91}
    assert meta["width"] == 64 and meta["taken_at"].startswith("2024-03-16")
    text = store.objects[("u1", HASH)]["search_text"]
    assert "march" in text and "2024" in text and "red" in text and "weekend" in text


def test_hybrid_search_and_delete(ctx):
    client, _ = ctx
    files = {"image": ("beach-trip.jpg", jpeg(), "image/jpeg")}
    client.post("/embed", headers=H, files=files, data={"user_id": "u1", "file_hash": HASH})
    hits = client.post("/search", headers=H, json={"user_id": "u1", "query": "beach"}).json()["results"]
    assert hits[0]["file_hash"] == HASH and hits[0]["score"] == 1.0
    assert client.post("/search", headers=H, json={"user_id": "u2", "query": "beach"}).json()["results"] == []
    assert client.delete(f"/index/u1/{HASH}", headers=H).status_code == 200
    assert client.post("/search", headers=H, json={"user_id": "u1", "query": "beach"}).json()["results"] == []


def test_ocr(ctx):
    client, _ = ctx
    r = client.post("/ocr", headers=H, files={"image": ("r.jpg", jpeg(), "image/jpeg")}).json()
    assert r["total"] == 99.5 and r["currency"] == "INR"


def test_rejects_bad_input(ctx):
    client, _ = ctx
    bad_hash = client.post(
        "/embed", headers=H, files={"image": ("a.jpg", jpeg(), "image/jpeg")}, data={"user_id": "u", "file_hash": "x"}
    )
    assert bad_hash.status_code == 422
    not_image = client.post(
        "/embed", headers=H, files={"image": ("a.jpg", b"nope", "image/jpeg")}, data={"user_id": "u", "file_hash": HASH}
    )
    assert not_image.status_code == 422
    assert client.post("/ocr", headers=H, files={"image": ("a.jpg", b"", "image/jpeg")}).status_code == 400


def test_faces_and_merge(ctx):
    client, _ = ctx
    r = client.post(
        "/faces", headers=H, files={"image": ("a.jpg", jpeg(), "image/jpeg")}, data={"user_id": "u1", "file_hash": HASH}
    ).json()
    assert r["engine"] == "fake-faces" and r["faces"][0]["person_id"] == "p1"
    m = client.post("/faces/merge", headers=H, json={"user_id": "u1", "sources": ["p2", "p1"], "target": "p1"}).json()
    assert m["updated"] == 3


def test_understand_local(ctx):
    client, _ = ctx
    r = client.post(
        "/understand",
        headers=H,
        json={"query": "Rahul in Goa last summer", "today": "2026-10-03", "people": ["Rahul"], "places": ["Goa"]},
    ).json()
    assert r["people"] == ["Rahul"] and r["places"] == ["Goa"] and r["source"] == "local"


def test_search_allow_list_and_local_rerank(ctx):
    client, _ = ctx
    for h in (HASH, "b" * 64):
        client.post(
            "/embed",
            headers=H,
            files={"image": ("beach.jpg", jpeg(), "image/jpeg")},
            data={"user_id": "u1", "file_hash": h},
        )
    allowed = client.post("/search", headers=H, json={"user_id": "u1", "query": "beach", "allow": ["b" * 64]}).json()
    assert [x["file_hash"] for x in allowed["results"]] == ["b" * 64]
    rr = client.post(
        "/rerank",
        headers=H,
        json={
            "user_id": "u1",
            "query": "beach",
            "candidates": [{"file_hash": HASH, "score": 0.5}, {"file_hash": "b" * 64, "score": 0.9}],
        },
    ).json()
    assert rr["source"] == "local" and len(rr["results"]) == 2


def test_health_lists_capabilities(ctx):
    client, _ = ctx
    caps = client.get("/healthz").json()["capabilities"]
    assert caps["faces"] == "local" and caps["understand"] == "local" and caps["rerank"] == "local"
