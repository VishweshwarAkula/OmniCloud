import pytest

from app.parsing import parse_total_to_number


@pytest.mark.parametrize(
    "raw,expected",
    [
        ("Rs. 39,750.18", 39750.18),
        ("₹1,250", 1250.0),
        ("$12.50", 12.5),
        ("12,50 €", 12.5),
        ("1.234,56", 1234.56),
        ("USD 1,000,000", 1000000.0),
        (42, 42.0),
        ("", None),
        (None, None),
        ("n/a", None),
    ],
)
def test_parse_total(raw, expected):
    assert parse_total_to_number(raw) == expected
