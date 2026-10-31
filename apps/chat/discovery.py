"""Marketplace-wide discovery chat — search, not the per-offer assistant.

The existing assistant in `apps/chat/api.py` is deliberately scoped to one
offer: it must never mention another agency, because a bot that knows every
listing leaks tenants through its mouth. This module is the opposite surface.
Its job is to search **public listings from every verified agency**, which is
exactly what the search page does. The safety rule is therefore the same one
the search page already follows: every queryset starts from
`Offer.publicly_visible()`. Drafts, unverified agencies and confirmed
duplicates can never appear, no matter what the traveller types.

There is no model call here. The parser in `apps/common/nlp_parser.py` turns a
sentence into the same structured filters the form uses, and `apply_filters()`
does the search. That keeps the answer truthful and testable: a reply cannot
invent a price because the price comes from a row, and CI stays green with
Ollama switched off.

Follow-ups are merged into the previous intent and stored in the Django session
by the API handler. "cheaper" and "from Oran" therefore refine the last search
instead of starting over. Only the parsed filters — never the raw message — are
kept, so a phone number typed into the chat is not persisted.
"""

import re
import unicodedata
from urllib.parse import urlencode

from django.urls import reverse

from apps.common.nlp_parser import parse_query
from apps.common.wilayas import WILAYA_NAMES_FR
from apps.offers.api import OfferFilters, apply_filters
from apps.offers.models import Offer

SESSION_KEY = "discover_intent"
MAX_RESULTS = 12
FEATURED_RESULTS = 4

KIND_LABELS = {
    Offer.OMRA: "Omra",
    Offer.HAJJ: "Hajj",
    Offer.TRIP: "organized trip",
    Offer.VISA: "visa assistance",
}

INCLUSION_LABELS = {
    "visa": "visa included",
    "flight": "flights included",
    "transport": "transport included",
    "hotel": "hotel included",
    "meals": "meals included",
    "beach": "beachfront",
}

# "from Oran" is the single most common refinement in a travel search. The
# parser extracts destinations but not departure cities, because the form asks
# for a wilaya code. These aliases bridge the two without teaching the parser
# about the whole wilaya list.
CITY_ALIASES = {
    "algiers": "16",
    "alger": "16",
    "oran": "31",
    "wahran": "31",
    "constantine": "25",
    "annaba": "23",
    "setif": "19",
    "sétif": "19",
    "tlemcen": "13",
    "batna": "05",
    "blida": "09",
    "bejaia": "06",
    "béjaïa": "06",
    "tizi ouzou": "15",
    "ghardaia": "47",
    "ghardaïa": "47",
}

DEPARTURE_CONTEXT = re.compile(
    r"\b(?:from|depuis|au\s+départ\s+de|de|من)\s+([a-zà-ÿ'’\- ]{2,40})",
    re.IGNORECASE,
)
RESET_PATTERN = re.compile(
    r"\b(?:reset|start\s+over|new\s+search|clear|recommence|nouvelle\s+recherche)\b",
    re.IGNORECASE,
)
CHEAPER_PATTERN = re.compile(r"\b(?:cheaper|less\s+expensive|moins\s+cher|أرخص)\b", re.I)
PRICIER_PATTERN = re.compile(r"\b(?:pricier|more\s+expensive|plus\s+cher)\b", re.I)

STARTER_SUGGESTIONS = [
    "Omra under 400 000 DZD",
    "Beach trip from Algiers",
    "Marrakech from Oran",
    "Schengen visa assistance",
]


def empty_intent() -> dict:
    return {
        "kind": [],
        "budget_max": None,
        "duration_days": None,
        "destination": None,
        "departure_wilaya": None,
        "inclusions": {
            "visa": False,
            "flight": False,
            "transport": False,
            "hotel": False,
            "meals": False,
            "beach": False,
        },
    }


def parse_message(message: str) -> dict:
    """The parser's result plus a departure wilaya, when one is named."""
    parsed = parse_query(message)
    parsed["departure_wilaya"] = extract_departure_wilaya(message)
    return parsed


def extract_departure_wilaya(message: str) -> str | None:
    match = DEPARTURE_CONTEXT.search(message)
    if not match:
        return None
    fragment = _fold(match.group(1))

    # Longest alias first so "tizi ouzou" is not shadowed by a shorter name.
    for name in sorted(CITY_ALIASES, key=len, reverse=True):
        if re.search(rf"\b{re.escape(_fold(name))}\b", fragment):
            return CITY_ALIASES[name]

    for code, name in sorted(WILAYA_NAMES_FR.items(), key=lambda item: len(item[1]), reverse=True):
        if re.search(rf"\b{re.escape(_fold(name))}\b", fragment):
            return code
    return None


def merge_intent(previous: dict | None, parsed: dict, message: str) -> tuple[dict, bool]:
    """Refine the previous search with this message.

    Returns `(intent, reset)`. A reset starts from an empty intent, so the UI
    can say "new search" without the previous budget quietly surviving.
    """
    if RESET_PATTERN.search(message):
        return empty_intent(), True

    intent = _copy_intent(previous) if previous else empty_intent()

    if parsed.get("kind"):
        intent["kind"] = list(parsed["kind"])
    for key in ("budget_max", "duration_days", "destination", "departure_wilaya"):
        if parsed.get(key) is not None:
            intent[key] = parsed[key]

    for inclusion, value in (parsed.get("inclusions") or {}).items():
        if value:
            intent["inclusions"][inclusion] = True

    # "cheaper" has no number in it. Without this, the most natural follow-up
    # in the conversation would search the same results again.
    if intent["budget_max"] is None:
        return intent, False
    if CHEAPER_PATTERN.search(message):
        intent["budget_max"] = max(1, int(intent["budget_max"] * 0.8))
    elif PRICIER_PATTERN.search(message):
        intent["budget_max"] = int(intent["budget_max"] * 1.25)
    return intent, False


def has_intent(intent: dict) -> bool:
    return bool(
        intent.get("kind")
        or intent.get("budget_max")
        or intent.get("duration_days")
        or intent.get("destination")
        or intent.get("departure_wilaya")
        or any(intent.get("inclusions", {}).values())
    )


def search(intent: dict) -> tuple[list[Offer], int]:
    filters = OfferFilters(
        kind=intent["kind"][0] if len(intent.get("kind") or []) == 1 else None,
        wilaya=intent.get("departure_wilaya"),
        sort="departure",
        limit=MAX_RESULTS,
        nlp_kind=intent.get("kind") or None,
        nlp_budget_max=intent.get("budget_max"),
        nlp_duration_days=intent.get("duration_days"),
        nlp_destination=intent.get("destination"),
        nlp_inclusions={key: value for key, value in intent.get("inclusions", {}).items() if value}
        or None,
    )
    offers = apply_filters(
        Offer.publicly_visible().select_related("agency"),
        filters,
    )
    # Best-described first: the quality score is the only signal that a listing
    # carries enough detail for a traveller to judge it. The date breaks ties.
    ordered = offers.order_by("-quality_score", "departure_date")
    # Count before slicing: the page shows four cards and a "See all" link, so
    # the reply has to know how many matches exist beyond the visible cut.
    total = ordered.count()
    return list(ordered[:MAX_RESULTS]), total


def search_url(intent: dict) -> str:
    """The closest equivalent on the Browse page.

    The form understands kind, wilaya, q and max_price. Destination maps to q
    because that is how the keyword search finds it. Inclusion filters have no
    form equivalent yet, so this link is deliberately the nearest match rather
    than a promise of identical rows.
    """
    params = {}
    kinds = intent.get("kind") or []
    if len(kinds) == 1:
        params["kind"] = kinds[0]
    if intent.get("departure_wilaya"):
        params["wilaya"] = intent["departure_wilaya"]
    if intent.get("budget_max"):
        params["max_price"] = int(intent["budget_max"])
    if intent.get("destination"):
        params["q"] = intent["destination"]

    base = reverse("search")
    return f"{base}?{urlencode(params)}" if params else base


def featured_offers(limit: int = FEATURED_RESULTS) -> list[Offer]:
    return list(
        Offer.publicly_visible().select_related("agency").order_by("departure_date")[:limit]
    )


def build_response(message: str, previous: dict | None) -> dict:
    """Everything the page needs: a reply, the intent, cards and follow-ups."""
    parsed = parse_message(message)
    intent, reset = merge_intent(previous, parsed, message)
    understood = has_intent(intent)
    if understood:
        offers, total = search(intent)
        summary = describe_intent(intent)
    else:
        offers = featured_offers()
        total = len(offers)
        summary = "Next departures"

    return {
        "reply": compose_reply(intent, offers, understood, total),
        "summary": summary,
        "search_url": search_url(intent),
        "intent": intent,
        "parsed": parsed,
        "reset": reset,
        "offers": offer_cards(offers),
        "suggestions": suggestions(intent, understood),
        "total": total,
    }


def compose_reply(
    intent: dict, offers: list[Offer], understood: bool, total: int | None = None
) -> str:
    if not understood:
        # A greeting is not an error, and an empty result is not a crash. Show
        # the next departures and say what would narrow them.
        return (
            "Here are the next departures from verified agencies. Tell me a kind of "
            "trip, a destination, a departure city or a budget to narrow them down."
        )

    description = describe_intent(intent)
    if not offers:
        return (
            f"I could not find a published trip for “{description}”. Try a higher "
            "budget, another departure city, or a different kind of trip."
        )

    count = total if total is not None else len(offers)
    noun = "trip" if count == 1 else "trips"
    cheapest = min(offers, key=lambda offer: offer.price_centimes)
    price = _dinars(cheapest.price_centimes)
    shown = "" if count <= len(offers) else f" Showing {len(offers)} of them."
    return (
        f"I found {count} matching {noun} for “{description}”. The closest starts at "
        f"{price}; the cards below are the ones I would compare first.{shown}"
    )


def describe_intent(intent: dict) -> str:
    parts = []
    kinds = intent.get("kind") or []
    if kinds:
        labels = [KIND_LABELS.get(kind, kind.replace("_", " ")) for kind in kinds]
        parts.append(" and ".join(labels))

    if intent.get("destination"):
        destination = intent["destination"].title()
        parts.append(f"to {destination}" if kinds else destination)
    if intent.get("departure_wilaya"):
        name = WILAYA_NAMES_FR.get(intent["departure_wilaya"], intent["departure_wilaya"])
        parts.append(f"from {name}")
    if intent.get("budget_max"):
        parts.append(f"under {_dinars(intent['budget_max'] * 100)}")

    inclusions = [
        label for key, label in INCLUSION_LABELS.items() if intent.get("inclusions", {}).get(key)
    ]
    if inclusions:
        parts.append("with " + ", ".join(inclusions))

    if not kinds and not intent.get("destination"):
        parts.insert(0, "trips")

    return " ".join(parts) or "all trips"


def suggestions(intent: dict, understood: bool) -> list[str]:
    if not understood:
        return list(STARTER_SUGGESTIONS)
    if not intent.get("budget_max"):
        return ["Cheaper options", "Under 300 000 DZD", "From Oran", "With visa included"]
    return ["Cheaper options", "From Oran", "With visa included", "Show beach trips"]


def offer_cards(offers: list[Offer]) -> list[dict]:
    cards = []
    for offer in offers:
        destination = ", ".join(
            part for part in (offer.destination_city, offer.destination_country) if part
        )
        cards.append(
            {
                "id": str(offer.id),
                "url": reverse("offer-detail", args=[offer.id]),
                "title": offer.title_fr,
                "kind": offer.get_kind_display(),
                "kind_code": offer.kind,
                "price_centimes": offer.price_centimes,
                "price_dzd": int(offer.price_dzd),
                "departure_date": offer.departure_date.isoformat(),
                "destination": destination,
                "agency": offer.agency.name,
                "verified": offer.agency.is_verified,
                "seats_left": offer.seats_left,
                "cover_image_url": offer.cover_image_url or "",
            }
        )
    return cards


def _copy_intent(intent: dict) -> dict:
    return {
        "kind": list(intent.get("kind") or []),
        "budget_max": intent.get("budget_max"),
        "duration_days": intent.get("duration_days"),
        "destination": intent.get("destination"),
        "departure_wilaya": intent.get("departure_wilaya"),
        "inclusions": dict(intent.get("inclusions") or empty_intent()["inclusions"]),
    }


def _dinars(centimes: int) -> str:
    dinars, cents = divmod(int(centimes), 100)
    amount = f"{dinars:,}".replace(",", " ")
    if cents:
        return f"{amount}.{cents:02d} DZD"
    return f"{amount} DZD"


def _fold(value: str) -> str:
    """Lowercase and strip accents, so "Sétif" matches "setif"."""
    decomposed = unicodedata.normalize("NFKD", value.casefold())
    return "".join(char for char in decomposed if not unicodedata.combining(char))
