"""The only thing the model is allowed to know.

Two rules shape this file, and they are the whole safety story of the feature:

* **One agency, one offer.** The context is built from a row the caller already
  fetched through `Offer.publicly_visible()`. There is no "all offers" variant
  and no shared knowledge base, because a bot that knows every agency leaks
  tenants through its mouth instead of through a query — and no guard in
  `apps/common/tenancy.py` would ever see it.

* **A pure function, testable without a model.** `build_context()` takes an
  `Offer` and returns plain data. That is what lets the test suite prove the
  prompt contains the real price and no typo, with Ollama switched off.

## Why `attributes` is filtered here (Known Gaps G1)

`Offer.attributes` is a `JSONField` with no per-kind schema yet, so the database
will happily store `nightsInMaccah` next to `nights_makkah`. A model answering
from that blob would repeat the typo with total confidence — the worst failure
mode this feature has, because it is indistinguishable from a fact.

Until the write side is fixed (a `Strict` schema per kind in
`apps/common/validators.py`), the read side refuses to pass anything it does not
recognise: known keys, primitive values, nothing nested. Dropping a real key
costs an answer; passing a typo costs the traveler's trust in every other answer.
That asymmetry is the reason this filter exists before the feature, not after.
"""

import json
from datetime import timedelta

from django.urls import reverse

from apps.common.wilayas import WILAYA_NAMES_FR
from apps.offers.models import Offer

MAX_RELATED_OFFERS = 3
MAX_MILESTONES = 20
MAX_DESCRIPTION = 1200
MAX_ATTRIBUTE_TEXT = 120

# Keys an agency may store per offer kind. Anything else is dropped on the way
# into the prompt. Keep this list in step with the per-kind schemas when G1 is
# fixed — at that point this becomes the *test oracle*, not the only guard.
_PILGRIMAGE = frozenset(
    {
        "visa_included",
        "flight_included",
        "transport_included",
        "hotel_stars",
        "nights_makkah",
        "nights_madinah",
        "makkah_hotel_distance_m",
        "madinah_hotel_distance_m",
        "meal_plan",
        "room_type",
        "ziyarat_included",
    }
)
_TRIP = frozenset(
    {
        "visa_included",
        "flight_included",
        "transport_included",
        "hotel_stars",
        "nights",
        "meal_plan",
        "room_type",
        "beachfront",
        "excursions_included",
    }
)
_VISA = frozenset({"visa_type", "processing_days", "appointment_included", "insurance_included"})

ATTRIBUTE_ALLOWLIST = {
    Offer.OMRA: _PILGRIMAGE,
    Offer.HAJJ: _PILGRIMAGE,
    Offer.TRIP: _TRIP,
    Offer.VISA: _VISA,
}

_PRIMITIVES = (bool, int, str)  # bool before int: True is an int in Python.


def build_context(offer):
    """Everything the assistant may say about this offer, as plain data."""
    return _compact(
        {
            "agency": _agency_facts(offer.agency),
            "offer": _offer_facts(offer),
            "programme": [
                _milestone_facts(offer, milestone)
                for milestone in offer.milestones.all()[:MAX_MILESTONES]
            ],
            "other_offers": [_other_offer_facts(o) for o in related_offers(offer)],
        }
    )


def facts_json(offer):
    """The context as one compact line. Compact because prompt tokens are time."""
    return json.dumps(build_context(offer), ensure_ascii=False, separators=(",", ":"))


def related_offers(offer, limit=MAX_RELATED_OFFERS):
    """Other listings from the *same* agency, same kind first.

    Deliberately not the model's job: it must never choose a slug, a price or a
    link. This queryset is the truth the cards are rendered from, and it is the
    same rows the prompt was given, so prose and cards cannot disagree.
    """
    base = (
        Offer.publicly_visible()
        .filter(agency_id=offer.agency_id)
        .exclude(pk=offer.pk)
        .order_by("departure_date")
    )
    same_kind = list(base.filter(kind=offer.kind)[:limit])
    if len(same_kind) < limit:
        same_kind += list(base.exclude(kind=offer.kind)[: limit - len(same_kind)])
    return same_kind


def related_offer_cards(offer):
    """The JSON the widget renders. `url` is built server-side so the browser
    never hardcodes a route that a URLconf change can break."""
    return [
        {
            "id": str(o.id),
            "url": reverse("offer-detail", args=[o.id]),
            "title": o.title_fr,
            "price_centimes": o.price_centimes,
            "departure_date": o.departure_date.isoformat(),
            "seats_left": o.seats_left,
        }
        for o in related_offers(offer)
    ]


def clean_attributes(offer):
    """Allowlisted, primitive, clipped. Unknown keys never reach the model."""
    allowed = ATTRIBUTE_ALLOWLIST.get(offer.kind, frozenset())
    details = {}
    for key, value in (offer.attributes or {}).items():
        if key not in allowed:
            continue
        if isinstance(value, bool):
            details[key] = value
        elif isinstance(value, int):
            details[key] = value
        elif isinstance(value, str) and value.strip():
            details[key] = _clip(value, MAX_ATTRIBUTE_TEXT)
    return details


def _agency_facts(agency):
    return _compact(
        {
            "name": agency.name,
            "city": agency.city,
            "wilaya": WILAYA_NAMES_FR.get(agency.wilaya_code, agency.wilaya_code),
            "verified": agency.is_verified,
            "about": _clip(agency.description, MAX_DESCRIPTION),
            "rating": agency.rating_average,
            "reviews": agency.rating_count,
            # Business contact details, already public on the agency's page.
            # Never a traveler's number: those live on Lead/Reservation.
            "phone": agency.phone,
            "whatsapp": agency.whatsapp,
        }
    )


def _offer_facts(offer):
    destination = ", ".join(
        part for part in (offer.destination_city, offer.destination_country) if part
    )
    return _compact(
        {
            "title": offer.title_fr,
            "title_ar": offer.title_ar,
            "kind": offer.get_kind_display(),
            "price": _dzd(offer.price_centimes),
            "price_to": _dzd(offer.price_to_centimes) if offer.price_to_centimes else "",
            "departure_date": offer.departure_date.isoformat(),
            "return_date": offer.return_date.isoformat() if offer.return_date else "",
            "flexible_dates": offer.is_flexible_dates,
            "departure_from": WILAYA_NAMES_FR.get(
                offer.departure_wilaya_code, offer.departure_wilaya_code
            ),
            "destination": destination,
            "seats_left": offer.seats_left,
            "seats_total": offer.seats_total,
            "description": _clip(offer.description, MAX_DESCRIPTION),
            "details": clean_attributes(offer),
        }
    )


def _milestone_facts(offer, milestone):
    return _compact(
        {
            "day": milestone.day_offset + 1,
            "date": (offer.departure_date + timedelta(days=milestone.day_offset)).isoformat(),
            "time": milestone.time_of_day,
            "title": milestone.title,
            "kind": milestone.get_kind_display(),
            "location": milestone.location_name,
            "meeting_point": milestone.meeting_point,
        }
    )


def _other_offer_facts(offer):
    return _compact(
        {
            "title": offer.title_fr,
            "kind": offer.get_kind_display(),
            "price": _dzd(offer.price_centimes),
            "departure_date": offer.departure_date.isoformat(),
            "seats_left": offer.seats_left,
            "destination": ", ".join(
                part for part in (offer.destination_city, offer.destination_country) if part
            ),
        }
    )


def _dzd(centimes):
    """Exact dinars as text. Never a float (rule 6), and never truncated cents."""
    dinars, cents = divmod(int(centimes), 100)
    if cents == 0:
        return f"{dinars} DZD"
    return f"{dinars}.{cents:02d} DZD"


def _clip(value, limit):
    text = (value or "").strip()
    if len(text) <= limit:
        return text
    return text[: limit - 1].rstrip() + "…"


def _compact(data):
    """Drop empty values so the prompt is facts, not a form with blanks."""
    if isinstance(data, dict):
        return {
            key: _compact(value) for key, value in data.items() if value not in ("", None, {}, [])
        }
    if isinstance(data, list):
        return [_compact(item) for item in data]
    return data
