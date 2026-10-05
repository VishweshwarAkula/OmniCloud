from datetime import date

import pytest

from app.understand import LocalParser

TODAY = date(2026, 10, 3)
P = LocalParser()
PEOPLE = ["Rahul", "Priya Sharma"]
PLACES = ["Goa", "Mumbai", "India"]


def parse(q):
    return P.parse(q, TODAY, PEOPLE, PLACES)


@pytest.mark.parametrize(
    "q,frm,to",
    [
        ("photos from march 2024", "2024-03-01", "2024-03-31"),
        ("last summer", "2026-06-01", "2026-08-31"),
        ("summer 2023", "2023-06-01", "2023-08-31"),
        ("christmas eve 2023", "2023-12-24", "2023-12-24"),
        ("yesterday", "2026-10-02", "2026-10-02"),
        ("last month", "2026-09-01", "2026-09-30"),
        ("in 2022", "2022-01-01", "2022-12-31"),
        ("two years ago", "2024-01-01", "2024-12-31"),
        ("last winter", "2025-12-01", "2026-02-28"),
        ("summer", "2026-06-01", "2026-08-31"),
    ],
)
def test_dates(q, frm, to):
    u = parse(q)
    assert (u.date_from, u.date_to) == (frm, to), q


def test_people_places_and_visual_rest():
    u = parse("Rahul at the beach in Goa last summer")
    assert u.people == ["Rahul"] and u.places == ["Goa"]
    assert u.date_from == "2026-06-01"
    assert u.visual_query == "beach"


def test_kinds_and_filler_words():
    u = parse("show me all my screenshots of code from last week")
    assert u.kinds == ["screenshot"] and u.visual_query == "code"
    assert parse("receipts").kinds == ["receipt"]


def test_multiword_names_and_possessive():
    u = parse("priya sharma's birthday cake")
    assert u.people == ["Priya Sharma"] and u.visual_query == "birthday cake"


def test_may_as_verb_is_not_a_date():
    u = parse("dogs that may be sleeping")
    assert u.date_from is None and "may" in u.visual_query


def test_pure_filter_query_has_no_visual_part():
    u = parse("photos of Rahul in Mumbai")
    assert u.visual_query is None and u.people == ["Rahul"] and u.places == ["Mumbai"]


def test_holiday_without_year_matches_every_year():
    u = parse("christmas eve")
    assert u.date_from is None and u.visual_query == "christmas eve"


def test_bare_month_means_any_year():
    assert parse("pixel photos from december").months == [12]
    assert parse("in may").months == [5] and parse("in may").date_from is None
    assert parse("december 2024").date_from == "2024-12-01"


def test_strip_names_from_visual_query():
    from app.understand import _strip_names

    assert _strip_names("Leo playing football", ["Leo", "Mumbai"]) == "playing football"
    assert _strip_names("Lena's hat in Goa", ["Lena", "Goa"]) == "hat"
    assert _strip_names("Leo", ["Leo"]) is None
    assert _strip_names("photos", []) is None
    assert _strip_names("pictures of sunsets", []) == "sunsets"


def test_document_words_are_a_kind_filter():
    u = parse("pdfs about databases")
    assert u.kinds == ["document"] and u.visual_query == "about databases"


# ---------------------------------------------------------------- rules + local LLM
class FakeLLM:
    def __init__(self, out=None, fail=False):
        self.out, self.fail, self.calls = out or {}, fail, 0

    def extract(self, query, people, places):
        self.calls += 1
        if self.fail:
            raise RuntimeError("model crashed")
        return {"visual_query": None, "people": [], "places": [], "kinds": [], **self.out}


def understand_with(llm, q):
    from app.understand import Understander

    return Understander("llm", None, "", llm).parse(q, TODAY, PEOPLE, PLACES)


def test_llm_fixes_typos_and_translates_while_rules_keep_dates():
    llm = FakeLLM({"visual_query": "dogs on the beach in goa last summer", "people": ["Rahul"], "places": ["Goa"]})
    u = understand_with(llm, "perros de rahl en la playa de goa last summer")
    assert u.source == "llm"
    assert u.people == ["Rahul"] and u.places == ["Goa"]
    assert (u.date_from, u.date_to) == ("2026-06-01", "2026-08-31")  # from the rules, never the model
    assert u.visual_query == "dogs on the beach"


def test_llm_cannot_invent_people_or_kinds():
    # "Priya Sharma" is known but not in the query; "selfie" is not a kind.
    u = understand_with(
        FakeLLM({"visual_query": "temple", "people": ["Priya Sharma", "Mom"], "kinds": ["selfie"]}), "mom at the temple"
    )
    assert u.people == [] and u.kinds == []
    assert u.visual_query == "temple"


def test_kind_words_and_generic_nouns_leave_the_visual_part():
    u = understand_with(
        FakeLLM({"visual_query": "receipts photos from december", "kinds": ["receipt"]}), "receipts from december"
    )
    assert u.kinds == ["receipt"] and u.months == [12]
    assert u.visual_query is None


def test_single_words_and_failures_use_rules_only():
    llm = FakeLLM({"visual_query": "nonsense"})
    assert understand_with(llm, "sunset").source == "local" and llm.calls == 0
    u = understand_with(FakeLLM(fail=True), "rahul at the beach")
    assert u.source == "local" and u.people == ["Rahul"] and u.visual_query == "beach"
