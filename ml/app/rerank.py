"""Second-stage re-ranking of the top search results.

API: Gemini looks at the candidate thumbnails and scores how well each matches the query (0-10).
Local: re-score with a SigLIP prompt ensemble, blend with the first-stage score, then apply MMR so
near-duplicate shots don't crowd out everything else.
"""

import base64
import logging

import numpy as np
from pydantic import BaseModel

log = logging.getLogger(__name__)
PROMPTS = ("{}", "a photo of {}.", "a picture showing {}.")


def local_rerank(
    model, vectors: dict[str, list[float]], query: str, candidates: list[tuple[str, float]], diversity: float = 0.2
) -> list[tuple[str, float]]:
    have = [(h, s) for h, s in candidates if h in vectors]
    if len(have) < 2:
        return candidates
    q = np.mean([np.asarray(model.text(p.format(query))) for p in PROMPTS], axis=0)
    q /= np.linalg.norm(q) or 1.0
    V = np.asarray([vectors[h] for h, _ in have], dtype=np.float32)
    V /= np.linalg.norm(V, axis=1, keepdims=True)
    probs = np.asarray([model.prob(float(c)) for c in V @ q])
    first = np.asarray([s for _, s in have])
    rel = 0.6 * (probs / (probs.max() or 1)) + 0.4 * (first / (first.max() or 1))

    # Maximal marginal relevance: trade a little relevance for not showing five copies of one shot.
    chosen, left = [], list(range(len(have)))
    while left:
        if chosen:
            sim = (V[left] @ V[chosen].T).max(axis=1)
            mmr = (1 - diversity) * rel[left] - diversity * np.clip(sim - 0.85, 0, None) * 5
        else:
            mmr = rel[left]
        i = left[int(np.argmax(mmr))]
        chosen.append(i)
        left.remove(i)
    ranked = [(have[i][0], round(float(rel[i]), 4)) for i in chosen]
    missing = [(h, s) for h, s in candidates if h not in vectors]
    return ranked + missing


class _Scores(BaseModel):
    scores: list[int]


def gemini_rerank(client, model_name: str, query: str, images: list[tuple[str, bytes]]) -> dict[str, float]:
    from . import gemini as g

    if not g.available():
        raise RuntimeError("gemini paused after a rate limit")
    from google.genai import types

    parts = [
        f'Search query: "{query}". For each of the {len(images)} images below, in order, rate 0-10 how well it '
        "matches the query (10 = exactly what was asked for, 0 = unrelated). Return only the list of scores."
    ]
    for i, (_, data) in enumerate(images):
        parts += [f"Image {i + 1}:", types.Part.from_bytes(data=data, mime_type="image/jpeg")]
    resp = client.models.generate_content(
        model=model_name,
        contents=parts,
        config=types.GenerateContentConfig(
            temperature=0,
            response_mime_type="application/json",
            response_schema=_Scores,
            http_options=types.HttpOptions(timeout=12000),
        ),
    )
    s = resp.parsed if isinstance(resp.parsed, _Scores) else _Scores.model_validate_json(resp.text or "{}")
    if len(s.scores) != len(images):
        raise ValueError(f"expected {len(images)} scores, got {len(s.scores)}")
    return {h: max(0, min(10, v)) / 10 for (h, _), v in zip(images, s.scores, strict=True)}


def decode_images(images: dict[str, str] | None) -> list[tuple[str, bytes]]:
    out = []
    for h, b64 in (images or {}).items():
        try:
            out.append((h, base64.b64decode(b64)))
        except Exception:
            continue
    return out
