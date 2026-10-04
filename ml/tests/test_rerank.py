import numpy as np

from app.rerank import local_rerank


class M:
    def text(self, q):
        return [1.0, 0.0, 0.0]

    def prob(self, c):
        return max(0.0, c)


def test_local_rerank_promotes_visual_match_and_demotes_duplicates():
    vectors = {
        "dup1": [0.9, 0.43, 0.0],
        "dup2": [0.9, 0.43, 0.001],  # near-identical shot of dup1
        "other": [0.8, 0.0, 0.6],
        "weak": [0.1, 0.99, 0.0],
    }
    cands = [("weak", 1.0), ("dup1", 0.9), ("dup2", 0.9), ("other", 0.85)]
    order = [h for h, _ in local_rerank(M(), vectors, "q", cands)]
    assert order[0] == "dup1"
    assert order.index("other") < order.index("dup2")  # diversity: a different image beats the duplicate
    assert order[-1] == "weak"


def test_local_rerank_keeps_candidates_without_vectors():
    out = local_rerank(M(), {"a": list(np.eye(3)[0])}, "q", [("a", 1.0), ("b", 0.5)])
    assert [h for h, _ in out] == ["a", "b"]
