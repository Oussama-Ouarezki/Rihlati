"""Validation rules shared by the API schemas and the HTML forms.

This file is the Django answer to `packages/shared` — one definition, imported
by both entry points, so a rule can't drift between the JSON API and the form.

Each function raises Django's `ValidationError`. Django Ninja schemas call them
from a Pydantic validator and let `apps.common.errors` reshape the result; the
forms call them directly. Same sentence, same rule, two doors.
"""

import re

from django.core.exceptions import ValidationError

from apps.common.wilayas import WILAYA_CODES

# Guess at the valid Algerian mobile prefixes. VERIFY before real signups.
E164_DZ = re.compile(r"^\+213[5-7]\d{8}$")
PHONE_HELP = "International format: +213XXXXXXXXX"

TIME_OF_DAY = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")


def validate_dz_phone(value):
    if not E164_DZ.match(value or ""):
        raise ValidationError("Enter an Algerian number in the +213… format.")
    return value


def validate_wilaya_code(value):
    """Empty is allowed — "departure not specified" is a real state, and forcing a
    guess would put wrong wilayas in the search index."""
    if value and value not in WILAYA_CODES:
        raise ValidationError("Unknown wilaya.")
    return value


def validate_time_of_day(value):
    """A wall-clock string, `HH:MM`, 24h. Not a time field: see OfferMilestone —
    this is never converted between timezones, so it is not a moment."""
    if value and not TIME_OF_DAY.match(value):
        raise ValidationError("Enter a time in HH:MM (24h) format.")
    return value


def validate_price_centimes(value):
    """Money is integer centimes and must be positive.

    The upper bound is not paranoia: a typo of `35000000000` in a price field
    renders as "350 000 000,00 DZD" on a card and makes the whole search page
    look broken. 100 million DZD is far above any real trip.
    """
    if value is None:
        raise ValidationError("Price is required.")
    if value <= 0:
        raise ValidationError("The price must be positive.")
    if value > 10_000_000_000:
        raise ValidationError("Unrealistic price — check the amount.")
    return value


def validate_date_range(departure_date, return_date):
    if return_date and departure_date and return_date < departure_date:
        raise ValidationError("The return date cannot be before the departure date.")
    return return_date
