"""Hybrid ranking: fuse visual relevance with BM25 over tags/metadata, with a calibrated cutoff."""

from collections.abc import Callable
from typing import NamedTuple


class Hit(NamedTuple):
    file_hash: str
    score: float  # ranking score: only meaningful relative to the other results of the same query
    prob: float  # SigLIP probability (tiny on real photos; for diagnostics)
    margin: float  # similarity over a generic caption; the calibrated relevance signal
    match: str  # strong | good | possible | metadata — what the UI shows instead of a fake percentage


# Margins measured on real photos: correct matches +0.023..+0.075, unrelated images <= +0.004.
STRONG_MARGIN = 0.05
GOOD_MARGIN = 0.03


def match_label(margin: float, keyword: float, min_margin: float) -> str:
    if margin >= STRONG_MARGIN:
        return "strong"
    if margin >= GOOD_MARGIN:
        return "good"
    if margin >= min_margin:
        return "possible"
    return "metadata" if keyword > 0 else "possible"


def match_from_api_score(score: float) -> str:
    """Gemini re-rank scores are 0..1 (from a 0-10 rating)."""
    return "strong" if score >= 0.8 else "good" if score >= 0.5 else "possible"


def fuse(
    vector: dict[str, tuple[float, float]],
    keyword: dict[str, float],
    prob: Callable[[float], float],
    k: int,
    alpha: float = 0.75,
    min_margin: float = 0.015,
    strong_keyword: float = 0.6,
    relative_floor: float = 0.01,
) -> list[Hit]:
    """vector: file_hash → (cosine, margin). Returns hits best first.

    `margin` is the query's similarity minus the image's similarity to a generic caption ("a photo.").
    SigLIP's absolute probabilities on real photos are small (a correct "football" match can be p≈0.002),
    but the margin cleanly separates matches (> +0.02) from unrelated images (≤ 0), per image. A result
    is kept when its margin clears `min_margin` (and it isn't orders of magnitude behind the best match),
    or when it is a strong keyword hit (dates, places, tags). That's what lets search answer "nothing
    matches" instead of padding with the nearest wrong images.

    `score` blends visual relevance *relative to the best result* with keyword strength, so it orders
    results well but is not a confidence: the top visual match always scores `alpha`. Show `match` instead.
    """
    probs = {h: prob(c) for h, (c, _) in vector.items()}
    best_p = max(probs.values(), default=0.0)
    best_kw = max(keyword.values(), default=0.0)

    out = []
    for h in set(vector) | set(keyword):
        p = probs.get(h, 0.0)
        margin = vector[h][1] if h in vector else -1.0
        kw = keyword.get(h, 0.0) / best_kw if best_kw > 0 else 0.0
        # Also within two orders of magnitude of the best visual match: "blue circles" shouldn't return
        # red circles (shared shape → positive margin) when real blue ones score 1000x higher.
        visual_ok = margin >= min_margin and p >= best_p * relative_floor
        if not (visual_ok or kw >= strong_keyword):
            continue
        p_rel = p / best_p if best_p > 0 else 0.0
        label = match_label(margin if visual_ok else -1.0, kw, min_margin)
        out.append(Hit(h, round(alpha * p_rel + (1 - alpha) * kw, 4), round(p, 4), round(margin, 4), label))
    out.sort(key=lambda t: (-t.score, -t.prob))
    return out[:k]


_STOP = {
    "the",
    "and",
    "for",
    "with",
    "about",
    "from",
    "that",
    "this",
    "what",
    "how",
    "are",
    "was",
    "pdf",
    "pdfs",
    "doc",
    "docs",
}


def term_coverage(query: str, text: str) -> float:
    """Share of the query's meaningful words that occur in the text (1.0 when the query has none)."""
    import re

    terms = {t for t in re.findall(r"\w+", query.lower()) if len(t) > 2 and t not in _STOP}
    if not terms:
        return 1.0
    words = set(re.findall(r"\w+", text.lower()))
    return sum(1 for t in terms if t in words) / len(terms)


class DocHit(NamedTuple):
    file_hash: str
    page: int | None
    text: str
    score: float
    cos: float
    match: str


def fuse_docs(
    vector: list[dict],
    keyword: list[dict],
    k: int,
    min_cos: float = 0.82,
    good_cos: float = 0.84,
    strong_cos: float = 0.87,
    window: float = 0.06,
    strong_keyword: float = 0.6,
    alpha: float = 0.7,
    query: str = "",
    min_coverage: float = 0.6,
) -> list[DocHit]:
    """Best chunk per document from vector (e5 cosine) + BM25 chunk hits.

    e5 cosines live in a narrow band (unrelated text still scores ~0.7), so a chunk counts as relevant
    when it clears an absolute floor AND sits within `window` of the best chunk; strong
    keyword hits (exact terms, titles) are kept regardless.

    Calibrated on test documents with multilingual-e5-small: correct top matches scored 0.844-0.896
    (including a Spanish query against English notes); unrelated queries topped out at 0.791.
    """
    best_cos = max((h["cos"] for h in vector), default=0.0)
    best_kw = max((h["bm25"] for h in keyword), default=0.0)
    chunks: dict[tuple[str, int, str], dict] = {}
    for h in vector:
        chunks.setdefault((h["file_id"], h.get("page") or 0, h["text"]), {}).update(cos=h["cos"])
    for h in keyword:
        chunks.setdefault((h["file_id"], h.get("page") or 0, h["text"]), {}).update(bm25=h["bm25"])

    best: dict[str, DocHit] = {}
    for (fid, page, text), s in chunks.items():
        cos = s.get("cos", 0.0)
        kw = s.get("bm25", 0.0) / best_kw if best_kw > 0 else 0.0
        text_ok = cos >= min_cos and cos >= best_cos - window
        # A keyword-only hit must contain most of the query's words: "quantum physics lecture" must not
        # match lecture notes on databases just because they say "lecture".
        keyword_ok = kw >= strong_keyword and term_coverage(query, text) >= min_coverage
        if not (text_ok or keyword_ok):
            continue
        rel = (cos - min_cos) / max(best_cos - min_cos, 1e-6) if text_ok else 0.0
        score = round(alpha * max(0.0, min(1.0, rel)) + (1 - alpha) * kw, 4)
        if not text_ok:
            match = "keyword"
        else:
            match = "strong" if cos >= strong_cos else "good" if cos >= good_cos else "possible"
        hit = DocHit(fid, page or None, text, score, round(cos, 4), match)
        if fid not in best or hit.score > best[fid].score:
            best[fid] = hit
    return sorted(best.values(), key=lambda h: -h.score)[:k]
