"""Natural language query parser for travel offer search.

Extracts structured parameters from free-text traveler queries so the
AI search endpoint can build database filters dynamically.

Syntax: adjacent string literals (no triple-quoted block) so ruff line-length
applies like any other code.  The text itself is unchanged: no literal newline
is introduced between the pieces.
"""

import re

# --------------------------------------------------------------------------
# Currency & number patterns (Algerian DZD)
# --------------------------------------------------------------------------

# Match price in various formats:
#   "400 DZD", "400000", "400 000", "under 400", "budget 300 000"
#
# A budget word is tried before a bare number on purpose: in "7 nights under
# 400 000 DZD" the first number is the duration, and matching it as the budget
# made every explicit budget wrong.
BUDGET_PREFIX_PATTERN = re.compile(
    r"\b(?:under|below|less\s+than|up\s+to|max(?:imum)?|budget(?:\s+of)?|"
    r"moins\s+de|jusqu'à|أقل\s+من)\s*"
    r"(\d{1,10}(?:[\s.,]\d{3})*)"
    r"(?:\s*(?:DZD|dinars?|din|centimes))?",
    re.IGNORECASE,
)
PRICE_AFTER_PATTERN = re.compile(
    r"\b(?:above|over|more\s+than|plus\s+de)\s*"
    r"(\d{1,10}(?:[\s.,]\d{3})*)"
    r"(?:\s*(?:DZD|dinars?|din|centimes))?",
    re.IGNORECASE,
)
CURRENCY_SUFFIX_PATTERN = re.compile(
    r"(\d{1,10}(?:[\s.,]\d{3})*)\s*(?:DZD|dinars?|din|centimes)\b",
    re.IGNORECASE,
)
BARE_NUMBER_PATTERN = re.compile(r"\d{1,10}(?:[\s.,]\d{3})*")
DURATION_AFTER_NUMBER = re.compile(r"\s*(?:day|days|night|nights|d|n)\b", re.IGNORECASE)

# Match duration in days or nights
DURATION_DAYS_PATTERN = re.compile(r"\b(\d+)\s*(?:day|days|d)\b", re.IGNORECASE)
DURATION_NIGHTS_PATTERN = re.compile(r"\b(\d+)\s*(?:night|nights|n)\b", re.IGNORECASE)

# Match "15 days", "7 nights", etc.
DURATION_COMBINED_PATTERN = re.compile(r"\b(\d+)\s*(?:day|days|night|nights|d|n)\b", re.IGNORECASE)

# --------------------------------------------------------------------------
# Destination / city / country patterns
# --------------------------------------------------------------------------

# Common travel destinations mentioned in Rihlati offers. Only real places:
# "beach" is a theme, not a city, and filtering destination_city on it returned
# zero rows for the most natural query in the catalogue.
COMMON_DESTINATIONS = frozenset(
    {
        "makkah",
        "madinah",
        "medinah",
        "saudi",
        "turkey",
        "istanbul",
        "tunisia",
        "hammamet",
        "djerba",
        "cairo",
        "dubai",
        "jeddah",
        "marrakech",
        "morocco",
        "paris",
        "france",
    }
)

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


def _to_int(raw: str) -> int | None:
    """A grouped integer ("400 000", "400,000") as an int, or None."""
    digits = raw.replace(" ", "").replace(".", "").replace(",", "").strip()
    try:
        return int(digits)
    except ValueError:
        return None


def extract_price_centimes(query: str) -> int | None:
    """Extract the maximum budget, in DZD, from a query.

    Returns the cap for "under"/"less than"/"budget", the value for
    "400 000 DZD", and a plausible bare number. A minimum ("over", "above")
    is not a maximum, so it returns None rather than silently excluding cheap
    trips.

    The stored value is in dinars; `apply_filters()` multiplies by 100 because
    `Offer.price_centimes` is stored in centimes. Keeping the parser's unit in
    dinars matches what a traveller types.
    """
    m = BUDGET_PREFIX_PATTERN.search(query)
    if m:
        value = _to_int(m.group(1))
        return value if value and value > 0 else None

    # "over 500 000" is a floor, not a ceiling. Returning None is the honest
    # answer until the schema has a price_min filter on the NLP path.
    if PRICE_AFTER_PATTERN.search(query):
        return None

    m = CURRENCY_SUFFIX_PATTERN.search(query)
    if m:
        value = _to_int(m.group(1))
        return value if value and value > 0 else None

    # Last resort: a bare large number ("omra 400000"). Duration numbers are
    # filtered out, and 10 000 is the floor that keeps a year ("Hajj 2027")
    # from becoming a budget.
    for match in BARE_NUMBER_PATTERN.finditer(query):
        if DURATION_AFTER_NUMBER.match(query[match.end() :]):
            continue
        value = _to_int(match.group(0))
        if value and value >= 10_000:
            return value
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

    # Longest name first: "madinah" must win over a short substring, and
    # "saudi arabia" over "saudi".
    for dest in sorted(COMMON_DESTINATIONS, key=len, reverse=True):
        if re.search(rf"\b{re.escape(dest)}\b", query_lower):
            return dest

    # Unknown place names are deliberately not guessed. A wrong guess filters
    # the catalogue to zero rows, which looks like "no such trip" rather than
    # "I did not understand you".
    return None


def extract_kind(query: str) -> list[str]:
    """Return list of offer kinds found in the query.

    Returns [] if no kind can be identified — caller should fall back
    to showing all kinds or using the static filter UI.
    """
    return _find_kind_keywords(query)


def extract_inclusions(query: str) -> dict[str, bool]:
    """Extract boolean inclusion flags from the query.

    Returns dict with keys: visa, flight, transport, hotel, meals, beach.
    Values are True when the traveller explicitly asks for that inclusion,
    False when the word is merely present. The distinction matters: the query
    "visa assistance" is a `kind`, not a request for every offer that happens
    to include a visa, so a naive `"visa" in q` filtered the visa offers out of
    their own search.
    """
    q = query.lower()

    def wants(*phrases: str) -> bool:
        return any(re.search(phrase, q) for phrase in phrases)

    return {
        "visa": wants(
            r"\bvisa\s+(?:is\s+)?included\b",
            r"\bwith\s+(?:the\s+)?visa\b",
            r"\bvisa\s+and\s+flight\b",
        ),
        "flight": wants(
            r"\bflight\s+(?:is\s+)?included\b",
            r"\bwith\s+(?:the\s+)?flight\b",
            r"\bflights?\s+and\s+hotel\b",
        ),
        "transport": wants(
            r"\btransport\s+(?:is\s+)?included\b",
            r"\btransfers?\s+(?:are\s+)?included\b",
            r"\bwith\s+(?:the\s+)?transfer\b",
        ),
        "hotel": wants(
            r"\bhotel\s+(?:is\s+)?included\b",
            r"\bwith\s+(?:the\s+)?hotel\b",
        ),
        "meals": wants(
            r"\bmeals?\s+(?:are\s+)?included\b",
            r"\bhalf[\s-]board\b",
            r"\bfull[\s-]board\b",
            r"\ball[\s-]inclusive\b",
            r"\bbreakfast\s+included\b",
        ),
        "beach": wants(r"\bbeach(?:front)?\b", r"\bseaside\b", r"\bby\s+the\s+sea\b"),
    }


# --------------------------------------------------------------------------
# High-level parser
# --------------------------------------------------------------------------


def parse_query(query: str) -> dict[str, object]:
    """Parse a traveler's natural language query into structured parameters.

    Returns dict with possible keys:
        kind:        list[str]   | None  (e.g. ["omra"] or [])
        budget_max:  int | None  | maximum price in DZD (for "under X")
        duration_days: int | None| requested days (None = no filter)
        destination: str | None  | destination city/country
        inclusions:  dict[str, bool]  (visa, flight, transport, hotel, meals, beach)

    Example
    -------
    >>> parse_query("Omra with visa included under 400 DZD")
    {'kind': ['omra'], 'budget_max': 400, 'duration_days': None,
     'destination': None,
     'inclusions': {'visa': True, 'flight': False, 'transport': False,
                    'hotel': False, 'meals': False, 'beach': False}}
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
                "beach": False,
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
