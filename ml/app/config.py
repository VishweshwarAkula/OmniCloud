import os
from dataclasses import dataclass, field


@dataclass(frozen=True)
class Settings:
    weaviate_url: str = field(default_factory=lambda: os.getenv("WEAVIATE_URL", "http://weaviate:8080"))
    weaviate_api_key: str = field(default_factory=lambda: os.getenv("WEAVIATE_API_KEY", ""))
    weaviate_grpc_port: int = field(default_factory=lambda: int(os.getenv("WEAVIATE_GRPC_PORT", "50051")))
    # Empty → derived from the model name, so switching models never mixes incompatible vectors.
    collection: str = field(default_factory=lambda: os.getenv("WEAVIATE_COLLECTION", ""))

    clip_model: str = field(default_factory=lambda: os.getenv("EMBED_MODEL_NAME", "ViT-B-16-SigLIP2-256"))
    clip_pretrained: str = field(default_factory=lambda: os.getenv("EMBED_MODEL_PRETRAIN", "webli"))
    # Documents: local multilingual text embedder + relevance thresholds (e5 cosine, calibrated on test docs).
    text_model: str = field(default_factory=lambda: os.getenv("TEXT_EMBED_MODEL", "intfloat/multilingual-e5-small"))
    doc_min_cos: float = field(default_factory=lambda: float(os.getenv("DOC_MIN_COS", "0.82")))
    tag_min_prob: float = field(default_factory=lambda: float(os.getenv("TAG_MIN_PROB", "0.08")))

    # Hybrid search knobs (see ranking.fuse).
    search_alpha: float = field(default_factory=lambda: float(os.getenv("SEARCH_ALPHA", "0.75")))
    # Minimum similarity margin over a generic caption (see ranking.fuse).
    search_min_margin: float = field(default_factory=lambda: float(os.getenv("SEARCH_MIN_MARGIN", "0.015")))
    torch_threads: int = field(default_factory=lambda: int(os.getenv("TORCH_THREADS", "0")))

    google_api_key: str = field(default_factory=lambda: os.getenv("GOOGLE_API_KEY", ""))
    # Lighter, faster model with its own quota for the per-search calls.
    understand_model: str = field(default_factory=lambda: os.getenv("UNDERSTAND_MODEL", "gemini-2.5-flash-lite"))
    rerank_model: str = field(default_factory=lambda: os.getenv("RERANK_MODEL", "gemini-2.5-flash-lite"))

    # auto = API when configured, else local | api | local. API failures always fall back to local.
    geocoder_mode: str = field(default_factory=lambda: os.getenv("GEOCODER_MODE", "auto"))
    nominatim_url: str = field(default_factory=lambda: os.getenv("NOMINATIM_URL", ""))
    # llm (= auto): rules + local Qwen3-0.6B | rules | api (Gemini). Stays on this machine by default.
    understand_mode: str = field(default_factory=lambda: os.getenv("UNDERSTAND_MODE", "llm"))
    llm_model: str = field(default_factory=lambda: os.getenv("LLM_MODEL", "Qwen3-0.6B-Q4_K_M.gguf"))
    # local (default, offline) | api (Gemini vision; sends the top thumbnails to Google) | auto (api if a key is set)
    rerank_mode: str = field(default_factory=lambda: os.getenv("RERANK_MODE", "local"))
    faces_mode: str = field(default_factory=lambda: os.getenv("FACES_MODE", "local"))  # local | off
    face_min_size: int = field(default_factory=lambda: int(os.getenv("FACE_MIN_SIZE", "24")))  # pixels
    face_match_threshold: float = field(default_factory=lambda: float(os.getenv("FACE_MATCH_THRESHOLD", "0.42")))
    data_dir: str = field(default_factory=lambda: os.getenv("ML_DATA_DIR", "/models"))

    service_token: str = field(default_factory=lambda: os.getenv("ML_SERVICE_TOKEN", ""))
    topk_default: int = field(default_factory=lambda: int(os.getenv("TOPK_DEFAULT", "24")))
