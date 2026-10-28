"""Fixture builders shared by the test suite.

Not a `conftest.py` — this project runs Django's own test runner, not pytest —
and deliberately not a fixtures JSON either. A factory function fails loudly
when a model changes; a JSON fixture silently loads stale columns until
something far away breaks.

Why these live here rather than being copy-pasted per test file: the first
version of this suite built agencies with `is_verified=True`, which was a real
column once and is now a property computed from `status`. Every test file
carried its own copy of that line, so one model change broke all of them
separately. One builder means one edit.

The rule these follow: **build the state you are testing, through the ORM, and
never through the API under test.** A test that sets up its world by calling
the endpoint it is about to assert on proves only that the endpoint agrees with
itself.
"""

from datetime import date, timedelta

from apps.accounts.models import Agency, Membership, User
from apps.leads.models import Client, Lead
from apps.leads.services import client_for_contact
from apps.offers.models import MilestoneKind, Offer, OfferMilestone
from apps.trips.models import Reservation

# A throwaway password for objects that only ever exist inside a test database
# created and dropped in the same process. Named so that a reader (or a secret
# scanner) can tell at a glance that it unlocks nothing.
TEST_PASSWORD = "not-a-real-password"


def make_agency(name="Agency", *, slug=None, verified=True, **kwargs):
    """A tenant.

    `verified=True` by default because an unverified agency is invisible to the
    public queryset, and a test that forgets this spends twenty minutes
    wondering why its offer does not appear in search. The cases that care
    about invisibility pass `verified=False` and say so in their name.
    """
    return Agency.objects.create(
        name=name,
        slug=slug or name.lower().replace(" ", "-"),
        city=kwargs.pop("city", "Alger"),
        status=Agency.VERIFIED if verified else Agency.DRAFT,
        **kwargs,
    )


def make_user(username, agency=None, *, role=Membership.AGENT, **kwargs):
    """A person, optionally holding a membership in one agency."""
    user = User.objects.create_user(username, password=TEST_PASSWORD, **kwargs)
    if agency is not None:
        Membership.objects.create(user=user, agency=agency, role=role)
    return user


def make_offer(agency, **kwargs):
    defaults = {
        "title_fr": "Offer",
        "title_ar": "عرض",
        "kind": Offer.OMRA,
        "price_centimes": 1_000_000,
        # Always in the future: `publicly_visible()` hides departures that have
        # already left, so a hardcoded past date makes a test fail next year
        # for a reason that has nothing to do with the code.
        "departure_date": date.today() + timedelta(days=10),
        "seats_total": 10,
        "seats_left": 10,
        "status": Offer.PUBLISHED,
    }
    return Offer.objects.create(agency=agency, **{**defaults, **kwargs})


def make_milestone(offer, **kwargs):
    """One step of a programme.

    `agency` is taken from the offer rather than accepted as an argument: a
    milestone whose agency differs from its offer's is a state the application
    cannot produce, and a fixture that can produce it will eventually be used
    to "prove" a tenant check that does not hold in reality.
    """
    defaults = {
        "title": "Rassemblement",
        "kind": MilestoneKind.MEETING,
        "day_offset": 0,
        "time_of_day": "06:00",
        "sort_order": 0,
    }
    return OfferMilestone.objects.create(agency=offer.agency, offer=offer, **{**defaults, **kwargs})


def make_client(agency, **kwargs):
    defaults = {"full_name": "Client", "phone_e164": "+213555000000"}
    return Client.objects.create(agency=agency, **{**defaults, **kwargs})


def make_reservation(offer, **kwargs):
    defaults = {
        "full_name": "Traveler",
        "phone_e164": "+213555000000",
        "party_size": 1,
    }
    values = {**defaults, **kwargs}
    # Mirrors what both creation doors do. A fixture that can produce a
    # reservation with no client is a state the application cannot reach, and
    # a test built on it proves nothing about the real one.
    values.setdefault(
        "client",
        client_for_contact(
            agency=offer.agency,
            full_name=values["full_name"],
            phone_e164=values["phone_e164"],
        ),
    )
    return Reservation.objects.create(agency=offer.agency, offer=offer, **values)


def make_lead(agency, offer, **kwargs):
    defaults = {
        "full_name": "Traveler",
        # Invented, and in the range reserved for documentation. A real number
        # in a fixture is a real person who eventually gets called by a test
        # that was pointed at the wrong environment.
        "phone_e164": "+213555000000",
    }
    values = {**defaults, **kwargs}
    values.setdefault(
        "client",
        client_for_contact(
            agency=agency,
            full_name=values["full_name"],
            phone_e164=values["phone_e164"],
        ),
    )
    return Lead.objects.create(agency=agency, offer=offer, **values)
