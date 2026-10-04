import re

_CURRENCY = re.compile(r"(?i)(rs\.?|inr|usd|eur|gbp|cad|aud|¥|₹|\$|€|£)\s*")


def parse_total_to_number(total: object) -> float | None:
    """Parse a human-written amount like "Rs. 39,750.18" or "1.234,50 €" into a float."""
    if isinstance(total, (int, float)):
        return float(total)
    if not total or not isinstance(total, str):
        return None
    s = _CURRENCY.sub("", total.strip())
    s = re.sub(r"[^0-9,.\-]", "", s)
    if "," in s and "." in s:
        # Whichever separator comes last is the decimal point.
        if s.rfind(",") > s.rfind("."):
            s = s.replace(".", "").replace(",", ".")
        else:
            s = s.replace(",", "")
    elif "," in s:
        # "12,50" is a decimal comma; "1,250" / "1,250,000" are thousands separators.
        head, _, tail = s.rpartition(",")
        s = f"{head.replace(',', '')}.{tail}" if len(tail) in (1, 2) else s.replace(",", "")
    try:
        return float(s)
    except ValueError:
        return None
