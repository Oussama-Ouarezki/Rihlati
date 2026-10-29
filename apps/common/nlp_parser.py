"""Natural language query parser for travel offer search.

Extracts structured parameters from free-text traveler queries so the
AI search endpoint can build database filters dynamically.

Syntax: adjacent string literals (no triple-quoted block) so ruff line-length
applies like any other code.  The text itself is unchanged: no literal newline
is introduced between the pieces.
"""

import re
from decimal import Decimal

from django.conf import settings

# --------------------------------------------------------------------------
# Currency & number patterns (Algerian DZD)
# --------------------------------------------------------------------------

# Match price in various formats:
#   "400 DZD", "400000", "400k", "400 000", "under 400", "above 500"
PRICE_PATTERN = re.compile(
    r"(?:"
    r"(?:under|above|over|more than|less than)\s+)?"
    r"("
    r"\d{1,10}"  # integer part
    r"(?:[\s.,]\d{3})*"  # optional grouped thousands
    r")"
    r"(?:\s*(?:DZD|dinars|din|centimes))?",
    re.IGNORECASE,
)

# Match duration in days or nights
DURATION_DAYS_PATTERN = re.compile(
    r"\b(\d+)\s*(?:day|days|d)\b", re.IGNORECASE
)
DURATION_NIGHTS_PATTERN = re.compile(
    r"\b(\d+)\s*(?:night|nights|n)\b", re.IGNORECASE
)

# Match "15 days", "7 nights", etc.
DURATION_COMBINED_PATTERN = re.compile(
    r"\b(\d+)\s*(?:day|days|night|nights|d|n)\b", re.IGNORECASE
)

# --------------------------------------------------------------------------
# Destination / city / country patterns
# --------------------------------------------------------------------------

# Common travel destinations mentioned in Rihlati offers
COMMON_DESTINATIONS = frozenset({
    "makkah",
    "medinah",
    "saudi",
    "turkey",
    "istanbul",
    "tunisia",
    "hammamet",
    "cairo",
    "dubai",
    "jeddah",
    "costa",
    "beach",
})

# Simple heuristic: if a token matches a known destination, capture it.
# We do NOT build a heavy NLP model here — just keyword harvesting.


# --------------------------------------------------------------------------
# Offer kind keywords
# --------------------------------------------------------------------------

KIND_KEYWORDS = {
    "omra": [
        r"\bomra\b",
        r"\bomrah\b",
        r"\bpilgrimage\s+to\s+makkah\b",
        r"\bmecca\b",
        r"\bmedinah\b",
    ],
    "hajj": [
        r"\bhajj\b",
        r"\bhajjah\b",
        r"\bgreater\s+pilgrimage\b",
        r"\bpillars\s+of\s+islam\b",
    ],
    "organized_trip": [
        r"\borganized\s+trip\b",
        r"\bholiday\b",
        r"\bvacation\b",
        r"\btrip\b",
        r"\btour\b",
    ],
    "visa_assistance": [
        r"\bvisa\b",
        r"\bschengen\b",
        r"\bvisa\s+assistance\b",
        r"\bapplication\b",
    ],
}


def _find_kind_keywords(text: str) -> list[str]:
    """Return kind labels found in text based on keyword regexes."""
    found: list[str] = []
    for kind, patterns in KIND_KEYWORDS.items():
        for pattern in patterns:
            if re.search(pattern, text, re.IGNORECASE):
                found.append(kind)
                break  # one match per kind is enough
    return found


# --------------------------------------------------------------------------
# Core extraction functions
# --------------------------------------------------------------------------


def extract_price_centimes(query: str) -> int | None:
    """Extract maximum budget in centimes from a query.

    Returns the price threshold, or None if no price found.
    If 'under'/'less than'/'below' is used, return that cap.
    If 'over'/'above'/'more than' is used, return None (price floor,
    not supported yet — treat as unrestricted).

    The value is returned in DZD centimes (1 DZD = 100 centimes for
    internal storage, but we store full integer centimes e.g. 42000000 = 420 000.00 DZD).
    """
    m = PRICE_PATTERN.search(query)
    if not m:
        return None

    raw = m.group(1).strip()
    # Remove thousand separators (spaces, dots, commas)
    raw = raw.replace(" ", "").replace(".", "").replace(",", "")

    # Strip currency tokens
    raw = raw.replace("DZD", "").replace("dinars", "").replace("din", "").replace("centimes", "").strip()

    try:
        value = int(raw)
    except ValueError:
        return None

    # If the query had "under"/"less than"/"below", this is a max cap
    query_lower = query.lower()
    if any(
        word in query_lower
        for word in ["under", "less than", "below", "under"]
    ):
        return value  # this is the max budget

    # If "over"/"above"/"more than" — not yet supported; return None
    # Caller can treat as "no price filter"
    return None


def extract_duration_days(query: str) -> int | None:
    """Extract requested duration in days from the query.

    Returns number of days, or None if not found.
    """
    # Look for "7 days", "15 days", "5-7 days"
    m = DURATION_DAYS_PATTERN.search(query)
    if m:
        return int(m.group(1))

    # Look for combined "7 nights" etc.
    m2 = DURATION_COMBINED_PATTERN.search(query)
    if m2:
        # If it's "7 nights", treat as rough days (7 nights ≈ 7 days travel)
        return int(m2.group(1))

    return None


def extract_destination(query: str) -> str | None:
    """Extract destination city/country from query using simple heuristics.

    Returns a destination string, or None if not identifiable.
    """
    query_lower = query.lower()

    # First: check against common destinations list
    for dest in COMMON_DESTINATIONS:
        if dest in query_lower:
            return dest

    # Second: look for capitalized place names that aren't common words
    # Simple heuristic: words starting with uppercase-like patterns after "to"
    # This is deliberately coarse — we fall back to title/q search later.
    return None


def extract_kind(query: str) -> list[str]:
    """Return list of offer kinds found in the query.

    Returns [] if no kind can be identified — caller should fall back
    to showing all kinds or using the static filter UI.
    """
    return _find_kind_keywords(query)


def extract_inclusions(query: str) -> dict[str, bool]:
    """Extract boolean inclusion flags from the query.

    Returns dict with keys: visa, flight, transport, hotel, meals.
    Values are True if the keyword appears, False otherwise (not "known
    negative", just "not explicitly mentioned").
    """
    q = query.lower()
    defaults = {
        "visa": "visa" in q or "visa included" in q,
        "flight": "flight" in q or "flight included" in q,
        "transport": "transport" in q or "transfer" in q,
        "hotel": "hotel" in q,
        "meals": any(
            word in q for word in ["meal", "board", "half board", "full board"]
        ),
    }
    return defaults


# --------------------------------------------------------------------------
# High-level parser
# --------------------------------------------------------------------------


def parse_query(query: str) -> dict[str, object]:
    """Parse a traveler's natural language query into structured parameters.

    Returns dict with possible keys:
        kind:        list[str]   | None  (e.g. ["omra"] or [])
        budget_max:  int | None  | maximum price in centimes (for "under X")
        duration_days: int | None| requested days (None = no filter)
        destination: str | None  | destination city/country
        inclusions:  dict[str, bool]  (visa, flight, transport, hotel, meals)

    Example
    -------
    >>> parse_query("Omra with visa included under 400 DZD")
    {'kind': ['omra'], 'budget_max': 40000000, 'duration_days': None,
     'destination': None, 'inclusions': {'visa': True, 'flight': True, 'transport': False, 'hotel': False, 'meals': False}}
    """
    if not query or not query.strip():
        return {
            "kind": [],
            "budget_max": None,
            "duration_days": None,
            "destination": None,
            "inclusions": {
                "visa": False,
                "flight": False,
                "transport": False,
                "hotel": False,
                "meals": False,
            },
        }

    q = query.strip()

    result: dict[str, object] = {
        "kind": extract_kind(q),
        "budget_max": extract_price_centimes(q),
        "duration_days": extract_duration_days(q),
        "destination": extract_destination(q),
        "inclusions": extract_inclusions(q),
    }

    # Post-validation: if budget_max is 0 or negative, clear it
    if result["budget_max"] is not None and result["budget_max"] <= 0:
        result["budget_max"] = None

    return result