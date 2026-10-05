"""Weaviate access: one long-lived client, one tenant per user, hybrid (vector + BM25) retrieval."""

import logging
import re
import threading
import uuid
from urllib.parse import urlparse

import weaviate
from weaviate.classes.config import Configure, DataType, Property, Tokenization, VectorDistances
from weaviate.classes.init import Auth
from weaviate.classes.query import Filter, MetadataQuery
from weaviate.classes.tenants import Tenant
from weaviate.util import generate_uuid5

log = logging.getLogger(__name__)


def connect(url: str, api_key: str, grpc_port: int):
    parsed = urlparse(url)
    auth = Auth.api_key(api_key) if api_key else None
    if parsed.hostname and parsed.hostname.endswith(("weaviate.cloud", "weaviate.network")):
        return weaviate.connect_to_weaviate_cloud(cluster_url=url, auth_credentials=auth)
    secure = parsed.scheme == "https"
    return weaviate.connect_to_custom(
        http_host=parsed.hostname,
        http_port=parsed.port or (443 if secure else 8080),
        http_secure=secure,
        grpc_host=parsed.hostname,
        grpc_port=grpc_port,
        grpc_secure=secure,
        auth_credentials=auth,
    )


def collection_for(model_name: str) -> str:
    """One collection per embedding model: vectors from different models are not comparable."""
    return "Img_" + re.sub(r"[^A-Za-z0-9]+", "_", model_name).strip("_")


def ensure_collection(client, name: str) -> None:
    if client.collections.exists(name):
        return
    client.collections.create(
        name=name,
        vectorizer_config=Configure.Vectorizer.none(),  # vectors come from the vision model
        vector_index_config=Configure.VectorIndex.hnsw(distance_metric=VectorDistances.COSINE),
        multi_tenancy_config=Configure.multi_tenancy(enabled=True, auto_tenant_creation=True),
        inverted_index_config=Configure.inverted_index(bm25_b=0.75, bm25_k1=1.2),
        properties=[
            Property(
                name="file_id",
                data_type=DataType.TEXT,
                index_filterable=True,
                index_searchable=False,
                tokenization=Tokenization.FIELD,
            ),
            Property(name="search_text", data_type=DataType.TEXT, tokenization=Tokenization.WORD),
            Property(name="tags", data_type=DataType.TEXT_ARRAY, tokenization=Tokenization.WORD),
            Property(name="kind", data_type=DataType.TEXT, tokenization=Tokenization.FIELD),
            Property(name="taken_at", data_type=DataType.DATE),
        ],
    )
    log.info("created collection %s", name)


class VectorStore:
    def __init__(self, url: str, api_key: str, grpc_port: int, collection: str):
        self.client = connect(url, api_key, grpc_port)
        self.collection_name = collection
        ensure_collection(self.client, collection)
        self.collection = self.client.collections.get(collection)
        self._tenants: set[str] = set()

    def close(self) -> None:
        self.client.close()

    def ready(self) -> bool:
        try:
            return self.client.is_ready()
        except Exception:
            return False

    def _tenant(self, user_id: str, create: bool):
        if create and user_id not in self._tenants:
            try:
                self.collection.tenants.create([Tenant(name=user_id)])
            except Exception as exc:  # already exists (or auto-created)
                if "already exists" not in str(exc).lower():
                    log.debug("tenant create for %s: %s", user_id, exc)
            self._tenants.add(user_id)
        return self.collection.with_tenant(user_id)

    @staticmethod
    def object_id(user_id: str, file_hash: str) -> str:
        # Deterministic id → re-indexing the same file replaces instead of duplicating.
        return str(generate_uuid5(f"{user_id}:{file_hash}"))

    def exists(self, user_id: str, file_hash: str) -> str | None:
        oid = self.object_id(user_id, file_hash)
        try:
            return oid if self._tenant(user_id, create=False).data.exists(oid) else None
        except Exception:
            return None

    def upsert(self, user_id: str, file_hash: str, vector: list[float], props: dict) -> str:
        oid = self.object_id(user_id, file_hash)
        tenant = self._tenant(user_id, create=True)
        props = {"file_id": file_hash, **{k: v for k, v in props.items() if v is not None}}
        if tenant.data.exists(oid):
            tenant.data.replace(uuid=oid, properties=props, vector=vector)
        else:
            tenant.data.insert(properties=props, vector=vector, uuid=oid)
        return oid

    @staticmethod
    def _allow(allow):
        return Filter.by_property("file_id").contains_any(allow) if allow else None

    def vector_candidates(
        self, user_id: str, vector: list[float], limit: int, allow=None
    ) -> dict[str, tuple[float, list[float]]]:
        """file_hash -> (cosine similarity, stored image vector), optionally restricted to an allow-list."""
        try:
            res = self._tenant(user_id, create=False).query.near_vector(
                vector,
                limit=limit,
                filters=self._allow(allow),
                include_vector=True,  # same round trip; used for the per-image relevance baseline
                return_properties=["file_id"],
                return_metadata=MetadataQuery(distance=True),
            )
        except Exception as exc:  # unknown tenant = nothing indexed yet
            log.debug("vector search for %s failed: %s", user_id, exc)
            return {}
        out = {}
        for o in res.objects or []:
            fid = o.properties.get("file_id")
            vec = o.vector.get("default") if isinstance(o.vector, dict) else o.vector
            if fid and fid not in out and o.metadata.distance is not None and vec is not None:
                out[fid] = (1.0 - o.metadata.distance, vec)
        return out

    def keyword_candidates(self, user_id: str, query: str, limit: int, allow=None) -> dict[str, float]:
        """file_hash -> BM25 score over tags (boosted) and the metadata text."""
        try:
            res = self._tenant(user_id, create=False).query.bm25(
                query,
                query_properties=["tags^2", "search_text"],
                limit=limit,
                filters=self._allow(allow),
                return_properties=["file_id"],
                return_metadata=MetadataQuery(score=True),
            )
        except Exception as exc:
            log.debug("keyword search for %s failed: %s", user_id, exc)
            return {}
        return {
            o.properties["file_id"]: float(o.metadata.score or 0)
            for o in res.objects or []
            if o.properties.get("file_id")
        }

    def vectors(self, user_id: str, hashes: list[str]) -> dict[str, list[float]]:
        """Stored image vectors for re-ranking."""
        if not hashes:
            return {}
        try:
            res = self._tenant(user_id, create=False).query.fetch_objects(
                filters=self._allow(hashes), limit=len(hashes), include_vector=True, return_properties=["file_id"]
            )
        except Exception as exc:
            log.debug("vector fetch failed: %s", exc)
            return {}
        out = {}
        for o in res.objects or []:
            v = o.vector.get("default") if isinstance(o.vector, dict) else o.vector
            if v is not None:
                out[o.properties["file_id"]] = v
        return out

    def delete(self, user_id: str, file_hash: str) -> None:
        try:
            self._tenant(user_id, create=False).data.delete_by_id(self.object_id(user_id, file_hash))
        except Exception as exc:
            log.debug("delete %s/%s: %s", user_id, file_hash, exc)


FACE_COLLECTION = "Face_SFace"


class FaceStore:
    """Face embeddings (one tenant per user) used for incremental clustering into people."""

    def __init__(self, client, threshold: float):
        self.threshold = threshold
        if not client.collections.exists(FACE_COLLECTION):
            client.collections.create(
                name=FACE_COLLECTION,
                vectorizer_config=Configure.Vectorizer.none(),
                vector_index_config=Configure.VectorIndex.hnsw(distance_metric=VectorDistances.COSINE),
                multi_tenancy_config=Configure.multi_tenancy(enabled=True, auto_tenant_creation=True),
                properties=[
                    Property(
                        name=n,
                        data_type=DataType.TEXT,
                        index_filterable=True,
                        index_searchable=False,
                        tokenization=Tokenization.FIELD,
                    )
                    for n in ("face_id", "person_id", "file_id")
                ],
            )
        self.collection = client.collections.get(FACE_COLLECTION)
        self._lock = threading.Lock()  # serialises assignment so two uploads can't race

    def _t(self, user_id):
        return self.collection.with_tenant(user_id)

    def assign(self, user_id: str, file_hash: str, faces: list[dict]) -> list[dict]:
        out = []
        with self._lock:
            t = self._t(user_id)
            try:  # idempotent on retries: drop this file's faces first
                t.data.delete_many(where=Filter.by_property("file_id").equal(file_hash))
            except Exception:
                pass
            used = set()
            for i, f in enumerate(faces):
                person = None
                try:
                    res = t.query.near_vector(
                        f["embedding"],
                        limit=5,
                        return_properties=["person_id", "file_id"],
                        return_metadata=MetadataQuery(distance=True),
                    )
                    for o in res.objects or []:
                        sim = 1.0 - (o.metadata.distance or 1.0)
                        pid = o.properties.get("person_id")
                        # two faces in one photo are never the same person
                        if sim >= self.threshold and pid and pid not in used:
                            person = pid
                            break
                except Exception:
                    pass
                person = person or str(uuid.uuid4())
                used.add(person)
                face_id = str(generate_uuid5(f"{user_id}:{file_hash}:{i}"))
                t.data.insert(
                    properties={"face_id": face_id, "person_id": person, "file_id": file_hash},
                    vector=f["embedding"],
                    uuid=face_id,
                )
                out.append({"face_id": face_id, "person_id": person, "bbox": f["bbox"], "score": f["score"]})
        return out

    def merge(self, user_id: str, sources: list[str], target: str) -> int:
        """Re-point every face of the source people at the target person."""
        t = self._t(user_id)
        n = 0
        with self._lock:
            for src in sources:
                res = t.query.fetch_objects(
                    filters=Filter.by_property("person_id").equal(src), limit=10000, return_properties=["person_id"]
                )
                for o in res.objects or []:
                    t.data.update(uuid=o.uuid, properties={"person_id": target})
                    n += 1
        return n

    def delete_file(self, user_id: str, file_hash: str) -> None:
        try:
            self._t(user_id).data.delete_many(where=Filter.by_property("file_id").equal(file_hash))
        except Exception as exc:
            log.debug("face delete failed: %s", exc)


def doc_collection_for(model_name: str) -> str:
    return "Doc_" + re.sub(r"[^A-Za-z0-9]+", "_", model_name).strip("_")


class DocStore:
    """Document chunks (one object per chunk), one tenant per user, hybrid vector + BM25 search."""

    def __init__(self, client, name: str):
        if not client.collections.exists(name):
            client.collections.create(
                name=name,
                vectorizer_config=Configure.Vectorizer.none(),
                vector_index_config=Configure.VectorIndex.hnsw(distance_metric=VectorDistances.COSINE),
                multi_tenancy_config=Configure.multi_tenancy(enabled=True, auto_tenant_creation=True),
                properties=[
                    Property(
                        name="file_id",
                        data_type=DataType.TEXT,
                        index_filterable=True,
                        index_searchable=False,
                        tokenization=Tokenization.FIELD,
                    ),
                    Property(name="page", data_type=DataType.INT),
                    Property(name="chunk", data_type=DataType.INT),
                    Property(name="title", data_type=DataType.TEXT, tokenization=Tokenization.WORD),
                    Property(name="text", data_type=DataType.TEXT, tokenization=Tokenization.WORD),
                ],
            )
            log.info("created collection %s", name)
        self.collection = client.collections.get(name)

    def _t(self, user_id: str):
        return self.collection.with_tenant(user_id)

    def replace_document(self, user_id: str, file_hash: str, title: str, chunks, vectors) -> int:
        """Idempotent and never leaves the document half-indexed: chunk ids are deterministic, so the
        new chunks overwrite the old ones in place first, and only then are leftover chunks (an
        older, longer version) deleted. If the insert fails, the previous index stays intact."""
        from weaviate.classes.data import DataObject

        t = self._t(user_id)
        objs = [
            DataObject(
                uuid=str(generate_uuid5(f"{user_id}:{file_hash}:{c.index}")),
                properties={
                    "file_id": file_hash,
                    "page": c.page or 0,
                    "chunk": c.index,
                    "title": title,
                    "text": c.text,
                },
                vector=v,
            )
            for c, v in zip(chunks, vectors, strict=True)
        ]
        for start in range(0, len(objs), 200):
            res = t.data.insert_many(objs[start : start + 200])
            if res.has_errors:
                raise RuntimeError(f"weaviate insert failed: {list(res.errors.values())[:1]}")
        t.data.delete_many(
            where=Filter.by_property("file_id").equal(file_hash)
            & Filter.by_property("chunk").greater_or_equal(len(objs))
        )
        return len(objs)

    def vector_hits(self, user_id: str, vector: list[float], limit: int, allow=None) -> list[dict]:
        try:
            res = self._t(user_id).query.near_vector(
                vector,
                limit=limit,
                filters=VectorStore._allow(allow),
                return_properties=["file_id", "page", "text"],
                return_metadata=MetadataQuery(distance=True),
            )
        except Exception as exc:
            log.debug("doc vector search failed: %s", exc)
            return []
        return [{**o.properties, "cos": 1.0 - (o.metadata.distance or 1.0)} for o in res.objects or []]

    def keyword_hits(self, user_id: str, query: str, limit: int, allow=None) -> list[dict]:
        try:
            res = self._t(user_id).query.bm25(
                query,
                query_properties=["title^2", "text"],
                limit=limit,
                filters=VectorStore._allow(allow),
                return_properties=["file_id", "page", "text"],
                return_metadata=MetadataQuery(score=True),
            )
        except Exception as exc:
            log.debug("doc keyword search failed: %s", exc)
            return []
        return [{**o.properties, "bm25": float(o.metadata.score or 0)} for o in res.objects or []]

    def delete_file(self, user_id: str, file_hash: str) -> None:
        try:
            self._t(user_id).data.delete_many(where=Filter.by_property("file_id").equal(file_hash))
        except Exception as exc:
            log.debug("doc delete failed: %s", exc)
