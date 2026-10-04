from app.ranking import fuse


def ident(c):
    return c


def test_margin_gate_drops_unrelated_results():
    out = fuse({"a": (0.30, 0.05), "b": (0.25, 0.02), "c": (0.20, 0.004), "d": (0.10, -0.03)}, {}, ident, k=10)
    assert [h for h, *_ in out] == ["a", "b"]


def test_low_absolute_score_with_clear_margin_is_kept():
    # real photos: SigLIP prob can be tiny for a correct match; the margin is what matters
    out = fuse({"messi": (0.095, 0.027)}, {}, lambda c: 0.002, k=5)
    assert [h for h, *_ in out] == ["messi"]


def test_strong_keyword_hit_survives_without_visual_match():
    out = fuse({"a": (0.5, 0.05)}, {"z": 8.0, "a": 1.0}, ident, k=10)
    assert {h for h, *_ in out} == {"a", "z"}


def test_fusion_orders_by_combined_score():
    out = fuse({"a": (0.5, 0.05), "b": (0.45, 0.05)}, {"b": 5.0}, ident, k=10, alpha=0.5)
    assert out[0][0] == "b"


def test_respects_k_and_empty_inputs():
    assert fuse({}, {}, ident, k=5) == []
    assert len(fuse({str(i): (0.5, 0.05) for i in range(20)}, {}, ident, k=5)) == 5


def test_orders_of_magnitude_behind_best_is_dropped():
    # red circles share "circles" with the query (positive margin) but score ~2000x below blue ones
    out = fuse({"blue": (0.3, 0.075), "red": (0.1, 0.02)}, {}, lambda c: 0.84 if c == 0.3 else 0.0004, k=5)
    assert [h for h, *_ in out] == ["blue"]
