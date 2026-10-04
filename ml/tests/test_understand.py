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
