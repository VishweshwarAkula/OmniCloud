from app.ranking import fuse


def ident(c):
    return c


def test_margin_gate_drops_unrelated_results():
    out = fuse({"a": (0.30, 0.05), "b": (0.25, 0.02), "c": (0.20, 0.004), "d": (0.10, -0.03)}, {}, ident, k=10)
    assert [hit.file_hash for hit in out] == ["a", "b"]


def test_low_absolute_score_with_clear_margin_is_kept():
    # real photos: SigLIP prob can be tiny for a correct match; the margin is what matters
    out = fuse({"messi": (0.095, 0.027)}, {}, lambda c: 0.002, k=5)
    assert [hit.file_hash for hit in out] == ["messi"]


def test_strong_keyword_hit_survives_without_visual_match():
    out = fuse({"a": (0.5, 0.05)}, {"z": 8.0, "a": 1.0}, ident, k=10)
    assert {hit.file_hash for hit in out} == {"a", "z"}


def test_fusion_orders_by_combined_score():
    out = fuse({"a": (0.5, 0.05), "b": (0.45, 0.05)}, {"b": 5.0}, ident, k=10, alpha=0.5)
    assert out[0].file_hash == "b"


def test_respects_k_and_empty_inputs():
    assert fuse({}, {}, ident, k=5) == []
    assert len(fuse({str(i): (0.5, 0.05) for i in range(20)}, {}, ident, k=5)) == 5


def test_orders_of_magnitude_behind_best_is_dropped():
    # red circles share "circles" with the query (positive margin) but score ~2000x below blue ones
    out = fuse({"blue": (0.3, 0.075), "red": (0.1, 0.02)}, {}, lambda c: 0.84 if c == 0.3 else 0.0004, k=5)
    assert [hit.file_hash for hit in out] == ["blue"]


def test_match_labels_are_calibrated_not_relative():
    from app.ranking import match_from_api_score

    out = {
        h.file_hash: h.match
        for h in fuse({"a": (0.3, 0.07), "b": (0.28, 0.035), "c": (0.2, 0.02)}, {"z": 5.0}, ident, k=10)
    }
    assert out == {"a": "strong", "b": "good", "c": "possible", "z": "metadata"}
    # the best result is not automatically "strong": a single weak match stays weak
    assert fuse({"only": (0.1, 0.02)}, {}, lambda c: 0.002, k=5)[0].match == "possible"
    assert match_from_api_score(0.9) == "strong" and match_from_api_score(0.3) == "possible"


def test_doc_fusion_best_chunk_per_document_and_cutoff():
    from app.ranking import fuse_docs

    vec = [
        {"file_id": "notes", "page": 7, "text": "normalization", "cos": 0.88},
        {"file_id": "notes", "page": 2, "text": "intro", "cos": 0.83},
        {"file_id": "report", "page": 1, "text": "revenue", "cos": 0.83},
        {"file_id": "recipe", "page": 1, "text": "pasta", "cos": 0.74},  # below the floor
    ]
    kw = [{"file_id": "glossary", "page": 3, "text": "normalization defined", "bm25": 9.0}]
    hits = fuse_docs(vec, kw, k=10, query="normalization")
    by = {h.file_hash: h for h in hits}
    assert set(by) == {"notes", "report", "glossary"}
    assert by["notes"].page == 7 and by["notes"].match == "strong"
    assert by["glossary"].match == "keyword"
    assert hits[0].file_hash == "notes"


def test_keyword_only_doc_hit_needs_most_query_words():
    from app.ranking import fuse_docs, term_coverage

    kw = [{"file_id": "notes", "page": 10, "text": "Lecture 10: NoSQL databases", "bm25": 5.0}]
    assert fuse_docs([], kw, k=5, query="quantum physics lecture") == []
    assert fuse_docs([], kw, k=5, query="nosql lecture")[0].match == "keyword"
    assert term_coverage("the cache", "cache invalidation") == 1.0
