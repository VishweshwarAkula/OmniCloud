"""Query understanding: free text → structured filters + the visual part of the query.

  "rahul at the beach in goa last summer"
    → people=[rahul], places=[goa], date 2025-06-01..2025-08-31, visual_query="at the beach"

Default ("llm"): rules + a very small local LLM, nothing leaves the machine. Rules resolve dates
(small models can't do date math); the LLM reads typos, paraphrase and other languages, and its
people/places are kept only if they are known AND resemble a word in the query.
"rules": deterministic rules only. "api": Gemini with a JSON schema. Any failure → rules.
"""

import calendar
import difflib
import logging
import re
from datetime import date, timedelta

from pydantic import BaseModel, Field

log = logging.getLogger(__name__)

KINDS = ("photo", "screenshot", "document", "receipt", "illustration", "chart", "meme")


class Understanding(BaseModel):
    visual_query: str | None = Field(default=None, description="What should be visible, with filters removed")
    date_from: str | None = Field(default=None, description="YYYY-MM-DD inclusive")
    date_to: str | None = Field(default=None, description="YYYY-MM-DD inclusive")
    places: list[str] = Field(default_factory=list, description="Place names from the known list")
    people: list[str] = Field(default_factory=list, description="Person names from the known list")
    kinds: list[str] = Field(default_factory=list, description=f"Subset of {list(KINDS)}")
    months: list[int] = Field(default_factory=list, description="Months of the year (1-12) in any year")
    source: str = "local"


# ---------------------------------------------------------------- local rules
MONTHS = {m.lower(): i for i, m in enumerate(calendar.month_name) if m} | {
    m.lower(): i for i, m in enumerate(calendar.month_abbr) if m
}
MONTHS["sept"] = 9
_MONTH_RE = "|".join(sorted(MONTHS, key=len, reverse=True))
SEASONS = {"spring": (3, 5), "summer": (6, 8), "autumn": (9, 11), "fall": (9, 11), "winter": (12, 2)}
KIND_WORDS = {
    "screenshot": "screenshot",
    "screenshots": "screenshot",
    "screen shot": "screenshot",
    "screen shots": "screenshot",
    "receipt": "receipt",
    "receipts": "receipt",
    "bill": "receipt",
    "bills": "receipt",
    "invoice": "receipt",
    "invoices": "receipt",
    "document": "document",
    "documents": "document",
    "scan": "document",
    "scans": "document",
    "pdf": "document",
    "pdfs": "document",
    "doc": "document",
    "docs": "document",
    "illustration": "illustration",
    "illustrations": "illustration",
    "drawing": "illustration",
    "drawings": "illustration",
    "chart": "chart",
    "charts": "chart",
    "diagram": "chart",
    "diagrams": "chart",
    "meme": "meme",
    "memes": "meme",
}
FILLER = (
    r"\b(show me|find me|find|search for|search|look for|show|give me|get me|all( of)? my|all|my|our|some|any|the)\b"
)
GENERIC = r"\b(photos?|pictures?|pics?|images?|shots?|snaps?)\b"
PREP = r"(?:\b(?:in|at|from|during|on|of|with|near|around|taken)\s+)?"


def _clamp(d: date, today: date) -> date:
    return min(d, today)


def _month_range(y: int, m: int) -> tuple[date, date]:
    return date(y, m, 1), date(y, m, calendar.monthrange(y, m)[1])


def _season_range(season: str, year: int) -> tuple[date, date]:
    a, b = SEASONS[season]
    if a > b:  # winter spans the new year: Dec(year) .. Feb(year+1)
        return date(year, a, 1), _month_range(year + 1, b)[1]
    return date(year, a, 1), _month_range(year, b)[1]


class LocalParser:
    def parse(self, query: str, today: date, people: list[str], places: list[str]) -> Understanding:
        q = f" {query.strip().lower()} "
        u = Understanding(source="local")

        def take(pattern: str) -> re.Match | None:
            nonlocal q
            m = re.search(PREP + pattern, q)
            if m:
                q = q[: m.start()] + " " + q[m.end() :]
            return m

        for name in sorted({p for p in people if p}, key=len, reverse=True):
            if take(rf"\b{re.escape(name.lower())}(?:'s)?\b"):
                u.people.append(name)
        for place in sorted({p for p in places if p}, key=len, reverse=True):
            if take(rf"\b{re.escape(place.lower())}\b"):
                u.places.append(place)
        for word in sorted(KIND_WORDS, key=len, reverse=True):
            if take(rf"\b{re.escape(word)}\b") and KIND_WORDS[word] not in u.kinds:
                u.kinds.append(KIND_WORDS[word])

        rng = self._dates(take, today)
        if rng and rng[0] == "months":
            u.months = [rng[1]]
        elif rng:
            u.date_from, u.date_to = rng[0].isoformat(), rng[1].isoformat()

        rest = re.sub(FILLER, " ", q)
        rest = re.sub(GENERIC, " ", rest)
        rest = re.sub(r"\b(of|from|in|at|on|with|during|taken|and)\s*$", " ", rest.strip())
        rest = re.sub(r"^\s*(of|from|in|at|on|with|during|taken|and)\b", " ", rest)
        rest = re.sub(r"\s+", " ", rest).strip(" ,.-")
        u.visual_query = rest or None
        return u

    @staticmethod
    def _dates(take, today: date):
        y = today.year
        # Holidays only become a date filter with an explicit year ("christmas 2023"). Without one they
        # mean every year, so they stay in the query and match the indexed holiday words instead.
        if m := take(r"\b(christmas|xmas)( eve)?\s+(\d{4})\b"):
            yr = int(m.group(3))
            return (date(yr, 12, 24), date(yr, 12, 24)) if m.group(2) else (date(yr, 12, 24), date(yr, 12, 26))
        if m := take(r"\bnew year'?s?( eve)?\s+(\d{4})\b"):
            yr = int(m.group(2))
            return date(yr - 1, 12, 31), date(yr, 1, 1)
        if m := take(r"\bhalloween\s+(\d{4})\b"):
            yr = int(m.group(1))
            return date(yr, 10, 31), date(yr, 10, 31)
        if m := take(rf"\b({_MONTH_RE})\s+(\d{{4}})\b"):
            return _month_range(int(m.group(2)), MONTHS[m.group(1)])
        if m := take(r"\b(last|this|past)?\s*(spring|summer|autumn|fall|winter)(?:\s+(\d{4}))?\b"):
            season, rel, yr = m.group(2), m.group(1), m.group(3)
            if yr:
                return _season_range(season, int(yr))
            start, end = _season_range(season, y)
            if rel in ("last", "past"):
                # the most recent one that has fully ended ("last summer" in October = this year's)
                if end >= today:
                    start, end = _season_range(season, y - 1)
            elif start > today:
                # bare/"this" season that hasn't started yet → the previous one
                start, end = _season_range(season, y - 1)
            return start, _clamp(end, today)
        if take(r"\btoday\b"):
            return today, today
        if take(r"\byesterday\b"):
            return today - timedelta(days=1), today - timedelta(days=1)
        if take(r"\bthis week\b"):
            return today - timedelta(days=today.weekday()), today
        if take(r"\blast week\b"):
            start = today - timedelta(days=today.weekday() + 7)
            return start, start + timedelta(days=6)
        if take(r"\bthis month\b"):
            return today.replace(day=1), today
        if take(r"\blast month\b"):
            prev = today.replace(day=1) - timedelta(days=1)
            return _month_range(prev.year, prev.month)
        if take(r"\bthis year\b"):
            return date(y, 1, 1), today
        if take(r"\blast year\b"):
            return date(y - 1, 1, 1), date(y - 1, 12, 31)
        if m := take(r"\b(?:last|past)\s+(\d+)\s+(day|week|month|year)s?\b"):
            n, unit = int(m.group(1)), m.group(2)
            days = {"day": 1, "week": 7, "month": 30, "year": 365}[unit] * n
            return today - timedelta(days=days), today
        if m := take(r"\b(\d+|a|one|two|three)\s+years?\s+ago\b"):
            n = {"a": 1, "one": 1, "two": 2, "three": 3}.get(m.group(1)) or int(m.group(1))
            return date(y - n, 1, 1), date(y - n, 12, 31)
        if m := take(r"\b(19[5-9]\d|20\d{2})\b"):
            return date(int(m.group(1)), 1, 1), date(int(m.group(1)), 12, 31)
        # bare month name → that month in any year ("may" only with a preposition, it's also a verb)
        if m := take(rf"\b(?:(?:in|during|from)\s+(may)|({'|'.join(k for k in MONTHS if k != 'may')}))\b"):
            return ("months", MONTHS[m.group(1) or m.group(2)])
        return None


# ---------------------------------------------------------------- Gemini
PROMPT = """You turn a photo-library search query into structured filters.
Today is {today}. Known people: {people}. Known places: {places}.
Rules:
- Only use people and places from the known lists (match spelling/nicknames to them); leave others in visual_query.
- Resolve relative dates ("last summer", "two years ago", "christmas 2023") to an inclusive date range.
  "last <season>" = the most recent one that has fully ended (in October, "last summer" is this year's).
- A holiday WITHOUT a year ("christmas", "halloween") means every year: no dates, keep it in visual_query.
- A month WITHOUT a year ("photos from december") means that month in every year: set months, not dates.
- kinds only if the user clearly asks for that type of image: {kinds}.
- visual_query: what should be visible in the image, in plain English, without the filters and WITHOUT any
  person or place names (the image model can't recognise names; "Leo playing football" → "playing football").
  Null if nothing visual remains.
Query: {query}"""


# Queries this short rarely need a model ("sunset", "receipts"): rules alone are exact and instant.
MIN_WORDS_FOR_API = 3
MIN_WORDS_FOR_LLM = 2


def _mentioned(name: str, query: str) -> bool:
    """The model may only return a known name that (nearly) appears in the query: no invented people."""
    words = re.findall(r"\w+", query.lower())
    return all(
        any(w == part or difflib.SequenceMatcher(None, w, part).ratio() >= 0.75 for w in words)
        for part in re.findall(r"\w+", name.lower())
    )


def _strip_dates(text: str, today: date) -> str:
    """Remove date expressions (rules already turned them into filters) from the model's visual part."""
    q = f" {text.lower()} "

    def take(pattern: str):
        nonlocal q
        m = re.search(PREP + pattern, q)
        if m:
            q = q[: m.start()] + " " + q[m.end() :]
        return m

    while LocalParser._dates(take, today):
        pass
    return q


class Understander:
    def __init__(self, mode: str, gemini, model: str, llm=None):
        self.local = LocalParser()
        self.gemini = gemini if mode == "api" else None
        self.llm = llm if mode in ("llm", "auto") else None
        self.model = model
        self.mode = "api" if self.gemini else "llm" if self.llm else "local"

    def parse(self, query: str, today: date, people: list[str], places: list[str]) -> Understanding:
        from . import gemini as g

        if self.gemini and len(query.split()) >= MIN_WORDS_FOR_API and g.available():
            try:
                return self._gemini(query, today, people, places)
            except Exception as exc:
                g.note_failure(exc)
                log.warning("gemini query understanding failed (%s); using local parser", str(exc)[:200])
        rules = self.local.parse(query, today, people, places)
        if self.llm and len(query.split()) >= MIN_WORDS_FOR_LLM:
            try:
                return self._with_llm(rules, query, today, people, places)
            except Exception as exc:
                log.warning("local LLM query understanding failed (%s); using rules", str(exc)[:200])
        return rules

    def _with_llm(self, rules: Understanding, query, today, people, places) -> Understanding:
        out = self.llm.extract(query, people, places)
        known_people = {p.lower(): p for p in people}
        known_places = {p.lower(): p for p in places}
        found_people = [
            known_people[p.lower()] for p in out["people"] if p.lower() in known_people and _mentioned(p, query)
        ]
        found_places = [
            known_places[p.lower()] for p in out["places"] if p.lower() in known_places and _mentioned(p, query)
        ]
        kinds = list(dict.fromkeys([*rules.kinds, *(k for k in out["kinds"] if k in KINDS)]))
        visual = out["visual_query"]
        if visual:
            visual = _strip_dates(visual, today)
            # Kind words the filter already covers ("receipts" with kinds=[receipt]) aren't visual.
            for word, kind in KIND_WORDS.items():
                if kind in kinds:
                    visual = re.sub(rf"\b{re.escape(word)}\b", " ", visual, flags=re.I)
            visual = _strip_names(visual, [*people, *places])
        return Understanding(
            visual_query=visual,
            date_from=rules.date_from,
            date_to=rules.date_to,
            months=rules.months,
            people=list(dict.fromkeys([*rules.people, *found_people])),
            places=list(dict.fromkeys([*rules.places, *found_places])),
            kinds=kinds,
            source="llm",
        )

    def _gemini(self, query, today, people, places) -> Understanding:
        from google.genai import types

        class Schema(BaseModel):
            visual_query: str | None = None
            date_from: str | None = None
            date_to: str | None = None
            places: list[str] = []
            people: list[str] = []
            kinds: list[str] = []
            months: list[int] = []

        resp = self.gemini.models.generate_content(
            model=self.model,
            contents=PROMPT.format(
                today=today.isoformat(),
                people=people[:200] or "none",
                places=places[:200] or "none",
                kinds=list(KINDS),
                query=query,
            ),
            config=types.GenerateContentConfig(
                temperature=0,
                response_mime_type="application/json",
                response_schema=Schema,
                http_options=types.HttpOptions(timeout=10_000),  # Gemini rejects deadlines under 10 s
            ),
        )
        s = resp.parsed if isinstance(resp.parsed, Schema) else Schema.model_validate_json(resp.text or "{}")
        known_people = {p.lower(): p for p in people}
        known_places = {p.lower(): p for p in places}
        return Understanding(
            visual_query=_strip_names(s.visual_query, [*people, *places]),
            date_from=_iso(s.date_from),
            date_to=_iso(s.date_to),
            # never trust names the model invented: keep only known ones
            people=[known_people[p.lower()] for p in s.people if p.lower() in known_people],
            places=[known_places[p.lower()] for p in s.places if p.lower() in known_places],
            kinds=[k for k in s.kinds if k in KINDS],
            months=[m for m in s.months if 1 <= m <= 12],
            source="gemini",
        )


def _strip_names(text: str | None, names: list[str]) -> str | None:
    """Drop known people/place names and generic nouns the model left in the visual part."""
    if not text:
        return None
    for name in sorted(names, key=len, reverse=True):
        text = re.sub(rf"\b{re.escape(name)}(?:'s)?\b", " ", text, flags=re.I)
    # Generic nouns ("photos", "pictures") carry no visual meaning; alone they'd match nothing.
    text = re.sub(GENERIC, " ", text, flags=re.I)
    text = re.sub(r"\s+", " ", text).strip(" ,.-")
    text = re.sub(r"^(?:in|at|of|with|and|from)\s+|\s+(?:in|at|of|with|and|from)$", "", text, flags=re.I).strip()
    return text or None


def _iso(v):
    try:
        return date.fromisoformat(v).isoformat() if v else None
    except ValueError:
        return None
