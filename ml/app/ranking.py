"""Hybrid ranking: fuse visual relevance with BM25 over tags/metadata, with a calibrated cutoff."""

from collections.abc import Callable


def fuse(
    vector: dict[str, tuple[float, float]],
    keyword: dict[str, float],
    prob: Callable[[float], float],
    k: int,
    alpha: float = 0.75,
    min_margin: float = 0.015,
    strong_keyword: float = 0.6,
    relative_floor: float = 0.01,
) -> list[tuple[str, float, float]]:
    """vector: file_hash → (cosine, margin). Returns [(file_hash, score, visual_prob)] best first.

    `margin` is the query's similarity minus the image's similarity to a generic caption ("a photo.").
    SigLIP's absolute probabilities on real photos are small (a correct "football" match can be p≈0.002),
    but the margin cleanly separates matches (> +0.02) from unrelated images (≤ 0), per image. A result
    is kept when its margin clears `min_margin` (and it isn't orders of magnitude behind the best match),
    or when it is a strong keyword hit (dates, places, tags).
    That's what lets search answer "nothing matches" instead of padding with the nearest wrong images.
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
        out.append((h, round(alpha * p_rel + (1 - alpha) * kw, 4), round(p, 4)))
    out.sort(key=lambda t: (-t[1], -t[2]))
    return out[:k]
