"""Vision-language model wrapper (open_clip): image/text embeddings, calibrated relevance, zero-shot tags.

Default is Google's SigLIP 2. Unlike CLIP's softmax, SigLIP is trained with a sigmoid loss, so
sigmoid(scale * cos + bias) is a calibrated, per-pair match probability. That lets us threshold
search results and tags in absolute terms instead of always returning the top-k.
"""

import io
import math
import os
import threading

from PIL import Image, ImageOps

from .labels import KINDS, TAGS

try:  # HEIC/HEIF from phones
    from pillow_heif import register_heif_opener

    register_heif_opener()
except ImportError:  # pragma: no cover
    pass

TEMPLATES = ("a photo of {}.", "an image of {}.")


class VisionModel:
    def __init__(
        self, model_name: str, pretrained: str, threads: int = 0, tag_min_prob: float = 0.08, max_tags: int = 8
    ):
        import open_clip
        import torch

        self.torch = torch
        torch.set_num_threads(threads or os.cpu_count() or 1)
        self.name = f"{model_name}/{pretrained}"
        self.device = "cuda" if torch.cuda.is_available() else "cpu"
        self.model, _, self.preprocess = open_clip.create_model_and_transforms(
            model_name, pretrained=pretrained, device=self.device
        )
        self.model.eval()
        self.tokenizer = open_clip.get_tokenizer(model_name)
        self.scale = float(self.model.logit_scale.exp())
        bias = getattr(self.model, "logit_bias", None)
        self.bias = float(bias) if bias is not None else None
        self.tag_min_prob = tag_min_prob
        self.max_tags = max_tags
        self._lock = threading.Lock()  # CPU torch inference isn't re-entrant across threads
        self._kind_names, self._kind_vecs = self._label_matrix(KINDS)
        self._tag_names, self._tag_vecs = self._label_matrix(TAGS)
        self.dim = int(self._tag_vecs.shape[1])

    # ---- encoding -------------------------------------------------------------------------
    def _encode_text(self, texts):
        tokens = self.tokenizer(texts).to(self.device)
        with self._lock, self.torch.inference_mode():
            x = self.model.encode_text(tokens).float()
        return x / x.norm(dim=-1, keepdim=True)

    def _label_matrix(self, labels: dict):
        names = list(labels)
        prompts = [t.format(labels[n]) for n in names for t in TEMPLATES]
        vecs = self._encode_text(prompts).reshape(len(names), len(TEMPLATES), -1).mean(dim=1)
        return names, vecs / vecs.norm(dim=-1, keepdim=True)

    @staticmethod
    def open_image(data: bytes):
        """Returns (original, rgb): original keeps EXIF for metadata, rgb is orientation-corrected."""
        original = Image.open(io.BytesIO(data))
        return original, ImageOps.exif_transpose(original).convert("RGB")

    def image_vector(self, rgb: Image.Image):
        tensor = self.preprocess(rgb).unsqueeze(0).to(self.device)
        with self._lock, self.torch.inference_mode():
            x = self.model.encode_image(tensor).float()
        return (x / x.norm(dim=-1, keepdim=True)).squeeze(0)

    def text(self, query: str) -> list[float]:
        return self._encode_text([query]).squeeze(0).cpu().tolist()

    # ---- scoring --------------------------------------------------------------------------
    def baseline_vector(self) -> list[float]:
        """Embedding of a content-free caption: the per-image baseline for relevance margins."""
        if not hasattr(self, "_baseline"):
            self._baseline = self.text("a photo.")
        return self._baseline

    def prob(self, cos: float) -> float:
        """Calibrated match probability for SigLIP; a squashed cosine for softmax-trained CLIP."""
        if self.bias is not None:
            z = self.scale * cos + self.bias
            return 1 / (1 + math.exp(-z)) if z > -50 else 0.0
        return max(0.0, min(1.0, (cos - 0.15) / 0.2))

    def classify(self, vec) -> tuple[str, list[tuple[str, float]], dict[str, float]]:
        kind_cos = (self._kind_vecs @ vec).tolist()
        kind = self._kind_names[max(range(len(kind_cos)), key=kind_cos.__getitem__)]
        kind_probs = {n: self.prob(c) for n, c in zip(self._kind_names, kind_cos, strict=True)}
        tag_cos = (self._tag_vecs @ vec).tolist()
        scored = sorted(((n, self.prob(c)) for n, c in zip(self._tag_names, tag_cos, strict=True)), key=lambda t: -t[1])
        tags = [(n, round(p, 3)) for n, p in scored[: self.max_tags] if p >= self.tag_min_prob]
        return kind, tags, kind_probs
