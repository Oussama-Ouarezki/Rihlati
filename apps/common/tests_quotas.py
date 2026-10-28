"""The quota table, tested as a table.

Most of these do not test a code path. They test that the *numbers* stay
coherent — that a more expensive plan is never more restrictive, that every
plan has a limit at all, that an override of zero means zero. Those are the
mistakes an edit to `quotas.py` actually produces, and none of them would be
caught by a test that publishes one offer.

The off-by-one is here for the opposite reason: it is the classic place to get
an inequality wrong, it only misbehaves at exactly the limit, and exactly the
limit is the one number nobody tries by hand.
"""

from django.test import TestCase

from apps.accounts.models import Agency
from apps.common.quotas import (
    PUBLISHED_OFFER_LIMITS,
    SEAT_LIMITS,
    QuotaExceeded,
    assert_can_publish,
    published_offer_limit,
    quota_state,
)
from apps.common.testing import make_agency, make_offer
from apps.offers.models import Offer

# Cheapest first. The order is the assertion in two tests below, so it lives
# here rather than being retyped in each.
PLANS_ASCENDING = [Agency.FREE, Agency.PRO, Agency.BUSINESS]


class QuotaTableTests(TestCase):
    def test_every_plan_has_a_published_offer_limit(self):
        """A plan missing from the table falls back to the free limit, which is
        a silent downgrade rather than an error. Better to notice here."""
        for plan in PLANS_ASCENDING:
            self.assertIn(plan, PUBLISHED_OFFER_LIMITS)

    def test_a_more_expensive_plan_is_never_more_restrictive(self):
        """The one invariant a hand-edit breaks: swapping two numbers, or
        raising `free` past `pro` while tuning the free tier."""
        limits = [PUBLISHED_OFFER_LIMITS[plan] for plan in PLANS_ASCENDING]
        self.assertEqual(limits, sorted(limits))

    def test_no_plan_is_unlimited(self):
        """`None` here would mean the largest customer can make every search
        query slow for everyone else, by accident. A number you can raise is
        friendlier than an outage."""
        for plan, limit in PUBLISHED_OFFER_LIMITS.items():
            self.assertIsNotNone(limit, f"{plan} is unlimited")

    def test_leads_are_not_capped_by_any_plan(self):
        """Selling fewer customers is the one lever this product refuses to
        pull, so there is deliberately no lead-limit table to edit. A
        dictionary of nulls is an invitation; its absence is a decision
        somebody has to reopen on purpose."""
        import apps.common.quotas as quotas

        self.assertFalse(
            [name for name in dir(quotas) if "LEAD" in name],
            "a lead-limit table appeared — see Plan Limits and Quotas",
        )

    def test_seat_limits_exist_but_are_all_unset(self):
        """The shape is in the file so the eventual number lands next to the
        others instead of as a magic constant inside a handler."""
        self.assertEqual(set(SEAT_LIMITS), set(PUBLISHED_OFFER_LIMITS))
        self.assertEqual(set(SEAT_LIMITS.values()), {None})


class PublishedOfferLimitTests(TestCase):
    def setUp(self):
        self.agency = make_agency("Quota", slug="quota")

    def test_the_plan_supplies_the_limit(self):
        self.assertEqual(published_offer_limit(self.agency), PUBLISHED_OFFER_LIMITS[Agency.FREE])

    def test_an_override_beats_the_plan(self):
        self.agency.published_offer_limit_override = 42
        self.assertEqual(published_offer_limit(self.agency), 42)

    def test_an_override_of_zero_means_zero(self):
        """Written `override or plan_limit` — the obvious way — 0 is falsy and
        a suspended agency silently gets its free quota back. The bug is
        invisible in review and fires on the one agency you wanted to stop."""
        self.agency.published_offer_limit_override = 0
        self.assertEqual(published_offer_limit(self.agency), 0)
        with self.assertRaises(QuotaExceeded):
            assert_can_publish(self.agency)


class AssertCanPublishTests(TestCase):
    def setUp(self):
        self.agency = make_agency("Publisher", slug="publisher")
        self.limit = PUBLISHED_OFFER_LIMITS[Agency.FREE]

    def publish(self, count):
        return [make_offer(self.agency, title_fr=f"Offre {i}") for i in range(count)]

    def test_one_below_the_limit_is_allowed(self):
        self.publish(self.limit - 1)
        assert_can_publish(self.agency)  # does not raise

    def test_exactly_at_the_limit_refuses(self):
        self.publish(self.limit)
        with self.assertRaises(QuotaExceeded):
            assert_can_publish(self.agency)

    def test_drafts_do_not_occupy_a_slot(self):
        """The scarce thing is visibility on the marketplace, not rows in a
        table. An agency that cannot prepare next season's catalogue in draft
        prepares it in a spreadsheet, and then never moves it here."""
        self.publish(self.limit)
        Offer.objects.update(status=Offer.DRAFT)
        assert_can_publish(self.agency)

    def test_a_full_agency_can_still_re_save_an_existing_offer(self):
        """Without `exclude_pk` an agency at exactly its limit could never fix
        a typo — a bug that only appears at the boundary."""
        offers = self.publish(self.limit)
        assert_can_publish(self.agency, exclude_pk=offers[0].pk)

    def test_another_agency_offers_do_not_count(self):
        """The count is scoped to the tenant like everything else. A shared
        counter would let a busy neighbour lock this agency out."""
        neighbour = make_agency("Neighbour", slug="neighbour")
        for i in range(self.limit):
            make_offer(neighbour, title_fr=f"Voisin {i}")
        assert_can_publish(self.agency)


class QuotaStateTests(TestCase):
    """What the API's `GET .../quota` and the bar on the offers page both read.
    One function, so the number in the console cannot disagree with the number
    that refuses the publish."""

    def test_reports_plan_limit_used_and_remaining(self):
        agency = make_agency("State", slug="state")
        make_offer(agency, title_fr="Une")
        state = quota_state(agency)
        self.assertEqual(state["plan"], Agency.FREE)
        self.assertEqual(state["limit"], PUBLISHED_OFFER_LIMITS[Agency.FREE])
        self.assertEqual(state["used"], 1)
        self.assertEqual(state["remaining"], state["limit"] - 1)

    def test_remaining_never_goes_negative(self):
        """An override lowered below what an agency already published is a
        real state — a downgrade. `-3 offres restantes` is not a sentence to
        show anyone."""
        agency = make_agency("Over", slug="over")
        make_offer(agency, title_fr="Une")
        make_offer(agency, title_fr="Deux")
        agency.published_offer_limit_override = 1
        self.assertEqual(quota_state(agency)["remaining"], 0)
