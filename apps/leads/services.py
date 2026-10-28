"""Turning contact details into a client, once and in one place.

A lead or a reservation is a moment; a client is the person across moments.
Every door that creates contact details — the public form, the JSON API, the
manifest, the seed — calls this function, so "does this phone already have a
client?" has exactly one answer.

The phone must already be normalised by `validate_dz_phone`. That is not a
convention: it is what stops `0555…` and `+213555…` becoming two clients.
"""

from apps.leads.models import Client


def client_for_contact(*, agency, full_name, phone_e164):
    """The client for this phone, created on first contact.

    `get_or_create` is race-safe because of the unique constraint on
    `(agency, phone_e164)`; two simultaneous inquiries from the same number
    converge on one row instead of raising or duplicating.

    An existing client's name is left alone. The first spelling may be a typo,
    but silently replacing it on every inquiry is worse: the profile is edited
    by staff, not by whoever filled the form last.
    """
    client, _created = Client.objects.get_or_create(
        agency=agency,
        phone_e164=phone_e164,
        defaults={"full_name": (full_name or "").strip()},
    )
    return client
