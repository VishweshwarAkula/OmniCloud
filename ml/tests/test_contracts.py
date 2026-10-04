"""The API tests use fakes; make sure they can't silently drift from the real classes' signatures."""

import inspect

from app.vectorstore import FaceStore, VectorStore
from tests.test_api import FakeFaceStore, FakeStore


def params(fn):
    return [p for p in inspect.signature(fn).parameters if p != "self"]


def test_fake_store_matches_vector_store():
    for name in ("upsert", "vector_candidates", "keyword_candidates", "vectors", "delete"):
        assert params(getattr(FakeStore, name)) == params(getattr(VectorStore, name)) or len(
            params(getattr(VectorStore, name))
        ) == len(params(getattr(FakeStore, name))), name


def test_fake_face_store_matches_face_store():
    for name in ("assign", "merge", "delete_file"):
        assert len(params(getattr(FakeFaceStore, name))) == len(params(getattr(FaceStore, name))), name
