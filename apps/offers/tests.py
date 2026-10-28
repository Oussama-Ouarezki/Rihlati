"""The test CLAUDE.md rule #3 says every tenant-scoped resource must ship with:
create as Agency A, fetch as Agency B, assert 404.

There are two distinct ways to get this wrong, and they need two different
tests, because a codebase can pass one and fail the other:

1. **B puts A's row id under B's own agency path.** The membership check
   passes — B really is a member of B — so the only thing standing between B
   and A's data is that the queryset was filtered by agency. Expect **404**:
   the row is not "refused", it was never in the set.
2. **B puts A's agency id in the path.** The membership check fails first.
   Expect **403**, deliberately, because agency ids appear in every agency's
   own URLs and are not secret; "you are not a member" is what a real user
   sees when access is revoked while a tab is open.

Getting a 403 where a 404 belongs is a free existence oracle: it confirms the
id is real. That is why the two are asserted separately rather than with
`assertIn(status, (403, 404))`, which would pass while the bug is present.

Authentication here is a bearer token rather than `force_login`, because that
is how a real client calls this API and because a session would drag CSRF into
tests that are not about CSRF.
"""

import json
from datetime import date, timedelta

from django.test import TestCase

from apps.accounts.models import Membership
from apps.common.auth import issue_access_token
from apps.common.testing import make_agency, make_lead, make_offer, make_user
from apps.leads.models import Lead
from apps.offers.api import apply_derived_fields
from apps.offers.models import Offer, TrackedLink


class ApiTestCase(TestCase):
    """Thin helpers so each test reads as one HTTP call and one assertion."""

    def auth(self, user):
        return {"HTTP_AUTHORIZATION": f"Bearer {issue_access_token(user)}"}

    def get(self, path, user=None):
        return self.client.get(path, **(self.auth(user) if user else {}))

    def post(self, path, body, user=None):
        return self.client.post(
            path,
            data=json.dumps(body),
            content_type="application/json",
            **(self.auth(user) if user else {}),
        )

    def put(self, path, body, user=None):
        return self.client.put(
            path,
            data=json.dumps(body),
            content_type="application/json",
            **(self.auth(user) if user else {}),
        )

    def body(self, response):
        return json.loads(response.content)


class TenantIsolationTests(ApiTestCase):
    def setUp(self):
        self.agency_a = make_agency("Agency A", slug="a")
        self.agency_b = make_agency("Agency B", slug="b", city="Oran")
        # MANAGER, because creating and editing an offer requires it. An AGENT
        # here would make the write tests below pass with a 403 for the wrong
        # reason — "you lack the role" rather than "that row is not yours".
        self.user_a = make_user("user_a", self.agency_a, role=Membership.MANAGER)
        self.user_b = make_user("user_b", self.agency_b, role=Membership.MANAGER)
        self.offer_a = make_offer(self.agency_a, title_fr="Offre A")
        self.lead_a = make_lead(self.agency_a, self.offer_a)

    def offers_url(self, agency):
        return f"/api/agencies/{agency.id}/offers"

    def offer_url(self, agency, offer):
        return f"/api/agencies/{agency.id}/offers/{offer.id}"

    def offer_read_url(self, agency, offer):
        """There is no `GET /agencies/{id}/offers/{offer_id}` — the API has a
        list and a PUT but no single-offer read. So isolation on reads is
        asserted through the milestones sub-resource, which uses the same
        `scoped(Offer.objects, agency_id)` lookup and therefore fails the same
        way. Worth knowing rather than papering over: the gap is real."""
        return f"/api/agencies/{agency.id}/offers/{offer.id}/milestones"

    def test_agency_sees_its_own_offers(self):
        res = self.get(self.offers_url(self.agency_a), self.user_a)
        self.assertEqual(res.status_code, 200)
        self.assertEqual(len(self.body(res)), 1)

    def test_other_agency_does_not_see_the_offer_in_its_list(self):
        """The positive control for the 404 tests below. If B's list were
        unscoped this would return A's offer, and every "assert 404" after it
        could still pass while the data leaked through the list endpoint."""
        res = self.get(self.offers_url(self.agency_b), self.user_b)
        self.assertEqual(res.status_code, 200)
        self.assertEqual(self.body(res), [])

    def test_agency_can_read_its_own_offer_detail(self):
        res = self.get(self.offer_read_url(self.agency_a, self.offer_a), self.user_a)
        self.assertEqual(res.status_code, 200)

    def test_other_agency_cannot_read_offer_through_its_own_url(self):
        """B asks for A's offer id under B's own agency path -> 404, not 403."""
        res = self.get(self.offer_read_url(self.agency_b, self.offer_a), self.user_b)
        self.assertEqual(res.status_code, 404)

    def test_other_agency_cannot_read_offer_through_a_borrowed_url(self):
        """B puts A's agency id in the path. Membership fails first -> 403."""
        res = self.get(self.offer_read_url(self.agency_a, self.offer_a), self.user_b)
        self.assertEqual(res.status_code, 403)

    def test_other_agency_cannot_update_offer(self):
        """A write, not a read. The scoping has to hold on both, and a queryset
        used for GET is not automatically the one used for PUT."""
        res = self.put(
            self.offer_url(self.agency_b, self.offer_a),
            {
                "title_fr": "Détourné",
                "kind": Offer.OMRA,
                "price_centimes": 1,
                "departure_date": str(date.today() + timedelta(days=5)),
                "seats_total": 1,
                "seats_left": 0,
            },
            self.user_b,
        )
        self.assertEqual(res.status_code, 404)
        self.offer_a.refresh_from_db()
        self.assertEqual(self.offer_a.title_fr, "Offre A")
        self.assertEqual(self.offer_a.seats_left, 10)

    def test_other_agency_cannot_read_lead(self):
        """Leads matter more than offers: an offer is public by design, a lead
        is a traveler's name and phone number."""
        res = self.get(f"/api/agencies/{self.agency_b.id}/leads/{self.lead_a.id}", self.user_b)
        self.assertEqual(res.status_code, 404)

    def test_other_agency_cannot_read_audit_log(self):
        res = self.get(f"/api/agencies/{self.agency_a.id}/audit", self.user_b)
        self.assertEqual(res.status_code, 403)

    def test_anonymous_cannot_reach_agency_endpoints(self):
        res = self.get(self.offers_url(self.agency_a))
        self.assertEqual(res.status_code, 401)
        self.assertEqual(self.body(res)["code"], "NOT_AUTHENTICATED")

    def test_an_expired_or_forged_token_is_not_a_session(self):
        res = self.client.get(
            self.offers_url(self.agency_a), HTTP_AUTHORIZATION="Bearer not-a-real-token"
        )
        self.assertEqual(res.status_code, 401)


class ServerOwnedFieldTests(ApiTestCase):
    """Rule 2 — never trust a client-sent `agencyId`, `status`, or `price`."""

    def setUp(self):
        self.agency_a = make_agency("Agency A", slug="a")
        self.agency_b = make_agency("Agency B", slug="b", city="Oran")
        self.user_a = make_user("user_a", self.agency_a, role=Membership.MANAGER)

    def valid_payload(self, **overrides):
        return {
            "title_fr": "Nouvelle offre",
            "kind": Offer.TRIP,
            "price_centimes": 100_000,
            "departure_date": str(date.today() + timedelta(days=5)),
            "seats_total": 5,
            "seats_left": 5,
            **overrides,
        }

    def test_the_baseline_payload_is_accepted(self):
        """Without this, every rejection test below could be passing because
        the payload is malformed for some unrelated reason."""
        res = self.post(
            f"/api/agencies/{self.agency_a.id}/offers", self.valid_payload(), self.user_a
        )
        self.assertEqual(res.status_code, 201)

    def test_an_agency_id_in_the_body_is_rejected_not_ignored(self):
        """The client says "this belongs to B". `Strict` forbids unknown keys,
        so this is a 422 naming the field — not a silent success that leaves
        the caller believing something else happened."""
        res = self.post(
            f"/api/agencies/{self.agency_a.id}/offers",
            self.valid_payload(agency=str(self.agency_b.id)),
            self.user_a,
        )
        self.assertEqual(res.status_code, 422)
        self.assertEqual(self.body(res)["code"], "VALIDATION_FAILED")

    def test_a_server_owned_field_cannot_be_set_at_creation(self):
        """`is_featured` is what an agency would pay for. A field absent from
        the schema is a field the client cannot set — a stronger guarantee than
        a handler remembering to pop it."""
        res = self.post(
            f"/api/agencies/{self.agency_a.id}/offers",
            self.valid_payload(is_featured=True),
            self.user_a,
        )
        self.assertEqual(res.status_code, 422)

    def test_status_cannot_be_set_at_creation(self):
        """Publishing goes through /publish, which is where the quota check
        lives. Accepting `status` here would route around it."""
        res = self.post(
            f"/api/agencies/{self.agency_a.id}/offers",
            self.valid_payload(status=Offer.PUBLISHED),
            self.user_a,
        )
        self.assertEqual(res.status_code, 422)


class PublicVisibilityTests(ApiTestCase):
    """The badge has to mean something in the queryset, not in the template."""

    def setUp(self):
        self.unverified = make_agency("Unverified", slug="u", city="Blida", verified=False)
        self.hidden = make_offer(self.unverified, title_fr="Caché", kind=Offer.VISA)

        self.verified = make_agency("Verified", slug="v")
        self.visible = make_offer(self.verified, title_fr="Visible")

    def test_a_verified_agencys_offer_is_public(self):
        res = self.get("/api/offers")
        self.assertEqual(res.status_code, 200)
        titles = [item["title_fr"] for item in self.body(res)["items"]]
        self.assertEqual(titles, ["Visible"])

    def test_an_unverified_agencys_offer_is_not_in_search(self):
        res = self.get("/api/offers")
        titles = [item["title_fr"] for item in self.body(res)["items"]]
        self.assertNotIn("Caché", titles)

    def test_an_unverified_agencys_offer_is_404_even_by_direct_id(self):
        """Not listing it is not enough — ids leak, get shared, get guessed."""
        res = self.get(f"/api/offers/{self.hidden.id}")
        self.assertEqual(res.status_code, 404)

    def test_a_draft_offer_is_not_public(self):
        draft = make_offer(self.verified, title_fr="Brouillon", status=Offer.DRAFT)
        res = self.get(f"/api/offers/{draft.id}")
        self.assertEqual(res.status_code, 404)

    def test_inquiry_on_a_hidden_offer_is_404(self):
        """Otherwise the inquiry form is a side channel confirming the offer
        exists, and an unverified agency collects leads anyway."""
        res = self.post(
            "/api/inquiries",
            {
                "offer_id": str(self.hidden.id),
                "full_name": "Traveler",
                "phone_e164": "+213555000000",
                "consent": True,
            },
        )
        self.assertEqual(res.status_code, 404)


class InquiryTests(ApiTestCase):
    def setUp(self):
        self.agency = make_agency("A", slug="a")
        self.offer = make_offer(self.agency)

    def inquire(self, **overrides):
        payload = {
            "offer_id": str(self.offer.id),
            "full_name": "Traveler",
            "phone_e164": "+213555000000",
            "message": "Bonjour",
            "consent": True,
            **overrides,
        }
        return self.post("/api/inquiries", payload)

    def test_an_anonymous_traveler_can_inquire(self):
        res = self.inquire()
        self.assertEqual(res.status_code, 201)
        self.assertEqual(Lead.objects.count(), 1)

    def test_the_agency_is_derived_from_the_offer(self):
        """The traveler never names an agency. It is read from the offer, which
        is why there is no `agency_id` field to forge."""
        self.inquire()
        self.assertEqual(Lead.objects.get().agency, self.agency)

    def test_the_response_does_not_echo_the_created_lead(self):
        """A confirmation, not the row. Echoing it back would hand anyone who
        can POST a plausible payload an id to try elsewhere."""
        res = self.inquire()
        self.assertNotIn("id", self.body(res))

    def test_an_unchecked_consent_box_creates_nothing(self):
        """Rule: the consent trail is what makes a paid introduction legal
        later. A lead without it is not a cheaper lead, it is not a lead."""
        res = self.inquire(consent=False)
        self.assertEqual(res.status_code, 422)
        self.assertEqual(Lead.objects.count(), 0)

    def test_consent_is_recorded_with_the_wording_that_was_shown(self):
        """Storing `True` proves nothing a year later. What was agreed to has
        to be stored alongside the fact of agreeing."""
        self.inquire()
        lead = Lead.objects.get()
        self.assertTrue(lead.has_consent)
        self.assertTrue(lead.consent_text_version)

    def test_a_non_algerian_phone_is_rejected(self):
        res = self.inquire(phone_e164="0555111222")
        self.assertEqual(res.status_code, 400)

    def test_an_unknown_field_is_rejected(self):
        """`is_billable` decides whether we could charge for this lead. A client
        setting it would be writing into the agency's invoice."""
        res = self.inquire(is_billable=True)
        self.assertEqual(res.status_code, 422)


class OfferAnalyticsTests(ApiTestCase):
    """The counters behind the agency's "how is this offer doing?" chart.

    These are the numbers an agency will make real decisions on — whether to
    reprice, whether to repost, whether the paid plan is worth it. A counter
    that quietly undercounts is worse than no counter at all, because nobody
    doubts a number that looks plausible.
    """

    def setUp(self):
        self.agency = make_agency("Analytics", slug="analytics")
        self.owner = make_user("owner", self.agency, role=Membership.OWNER)
        self.offer = make_offer(self.agency)

    def metrics(self, user=None):
        return self.get(
            f"/api/agencies/{self.agency.id}/offers/{self.offer.id}/metrics",
            user or self.owner,
        )

    def test_a_public_view_is_counted(self):
        self.client.get(f"/api/offers/{self.offer.id}")
        rows = self.metrics().json()
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["views"], 1)

    def test_two_views_share_one_row_for_the_day(self):
        """One row per offer per day, incremented in place. A row per *view*
        would mean millions of rows to answer "how many views last week", and
        would keep a visit trail per person for no product reason."""
        for _ in range(3):
            self.client.get(f"/api/offers/{self.offer.id}")
        rows = self.metrics().json()
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["views"], 3)

    def test_an_inquiry_is_counted_separately_from_a_view(self):
        self.client.get(f"/api/offers/{self.offer.id}")
        self.post(
            "/api/inquiries",
            {
                "offer_id": str(self.offer.id),
                "full_name": "Traveler",
                "phone_e164": "+213555111222",
                "consent": True,
            },
        )
        row = self.metrics().json()[0]
        self.assertEqual(row["views"], 1)
        self.assertEqual(row["inquiries"], 1)

    def test_a_tracked_link_tap_lands_in_link_clicks(self):
        """The offer chart's "where did this traffic come from" line. Distinct
        from `TrackedLink.click_count`, which answers "did that Facebook post
        work" — one number cannot answer both questions."""
        link = TrackedLink.objects.create(
            agency=self.agency, offer=self.offer, label="Post", code=TrackedLink.new_code()
        )
        self.client.get(f"/l/{link.code}/")
        self.assertEqual(self.metrics().json()[0]["link_clicks"], 1)

    def test_another_agency_cannot_read_these_numbers(self):
        """Views and inquiry counts are a competitor's market research: they
        say which departures sell and which do not."""
        rival = make_agency("Rival", slug="rival")
        intruder = make_user("intruder", rival, role=Membership.OWNER)
        response = self.get(f"/api/agencies/{rival.id}/offers/{self.offer.id}/metrics", intruder)
        self.assertEqual(response.status_code, 404)

    def test_the_window_is_capped(self):
        """`days` is client-supplied and bounded in the schema. Unbounded, it
        is a free full-table scan on the largest table in the database."""
        self.assertEqual(self.metrics().status_code, 200)
        capped = self.get(
            f"/api/agencies/{self.agency.id}/offers/{self.offer.id}/metrics?days=99999",
            self.owner,
        )
        self.assertEqual(capped.status_code, 422)


class DuplicateFingerprintTests(TestCase):
    """The rule that decides whether this is a marketplace or a directory.

    An agency posting the same Omra eight times with slightly different titles
    is abuse. Two *different* agencies selling the same wholesaler package at
    different prices is the entire reason a traveler came here rather than
    walking into one shop. The fingerprint has to tell those apart, and the way
    it does is by putting the agency id **inside** the hash — a cross-agency
    collision is then not filtered out, it cannot occur.

    This was inverted in the code once: the clash query excluded the agency's
    own offers and matched other agencies', so honest competitors were flagged
    and actual reposting was not. Nothing failed, because nothing tested it.
    """

    def setUp(self):
        self.a = make_agency("Agence A", slug="dup-a")
        self.b = make_agency("Agence B", slug="dup-b")

    def make(self, agency, title, **kwargs):
        offer = make_offer(agency, title_fr=title, **kwargs)
        apply_derived_fields(offer)
        offer.refresh_from_db()
        return offer

    def test_the_same_agency_posting_the_same_trip_twice_is_flagged(self):
        first = self.make(self.a, "Omra Ramadan 2026")
        second = self.make(self.a, "Omra Ramadan 2026")
        self.assertEqual(second.duplicate_status, Offer.SUSPECTED)
        self.assertEqual(second.duplicate_of_id, first.id)

    def test_the_first_offer_is_never_the_one_flagged(self):
        """The repost is the abuse, not the original. Flagging both would
        punish the agency that did nothing wrong on the way to punishing the
        one that did."""
        first = self.make(self.a, "Hajj 2026")
        self.make(self.a, "Hajj 2026")
        first.refresh_from_db()
        self.assertEqual(first.duplicate_status, Offer.CLEAN)

    def test_two_agencies_selling_the_same_package_never_collide(self):
        """The most important assertion in this file. Collapsing these would
        destroy the product in order to tidy the data."""
        mine = self.make(self.a, "Omra Ramadan 2026")
        theirs = self.make(self.b, "Omra Ramadan 2026")
        self.assertNotEqual(mine.fingerprint, theirs.fingerprint)
        self.assertEqual(theirs.duplicate_status, Offer.CLEAN)
        self.assertIsNone(theirs.duplicate_of_id)

    def test_marketing_noise_and_word_order_do_not_hide_a_repost(self):
        """An agency reposting retypes rather than copies, so the second title
        is never byte-identical — which is why a byte comparison catches
        nothing. Accents, punctuation, case, word order and the small
        `TITLE_FILLER` set are all normalised away before hashing."""
        first = self.make(self.a, "Offre spéciale OMRA RAMADAN 2026 — Départ Alger !!")
        second = self.make(self.a, "alger omra ramadan 2026 depart")
        self.assertEqual(first.fingerprint, second.fingerprint)
        self.assertEqual(second.duplicate_status, Offer.SUSPECTED)

    def test_changing_a_price_does_not_turn_one_offer_into_two(self):
        """Price is deliberately outside the hash. It is the most common edit
        an agency makes, and an earlier design that bucketed prices into bands
        split offers straddling a boundary — 149 000 and 150 000 DZD landed in
        different buckets. Every fixed bucketing has boundaries."""
        offer = self.make(self.a, "Omra Chaabane")
        before = offer.fingerprint
        offer.price_centimes = 42_000_000
        apply_derived_fields(offer)
        offer.refresh_from_db()
        self.assertEqual(offer.fingerprint, before)
        self.assertEqual(offer.duplicate_status, Offer.CLEAN)

    def test_a_different_departure_date_is_a_different_trip(self):
        first = self.make(self.a, "Omra Ramadan 2026")
        second = self.make(
            self.a, "Omra Ramadan 2026", departure_date=date.today() + timedelta(days=90)
        )
        self.assertNotEqual(first.fingerprint, second.fingerprint)
        self.assertEqual(second.duplicate_status, Offer.CLEAN)

    def test_a_human_decision_is_never_overwritten_by_a_later_save(self):
        """Only `clean` is ever changed automatically. Once a person has ruled
        on a pair, the next edit must not quietly re-open it — otherwise the
        queue hands back the same pair forever and the reviewer learns to
        ignore it, which costs more than the flag was worth.

        Note the gap this exposes: the only human verdict the schema can hold
        is `confirmed_duplicate`. There is no way to record "I looked, these
        are genuinely distinct" — see the open question in
        [[Duplicate and Spam Control]]."""
        self.make(self.a, "Omra Rajab")
        second = self.make(self.a, "Omra Rajab")
        Offer.objects.filter(pk=second.pk).update(duplicate_status=Offer.CONFIRMED_DUPLICATE)
        second.refresh_from_db()
        apply_derived_fields(second)
        second.refresh_from_db()
        self.assertEqual(second.duplicate_status, Offer.CONFIRMED_DUPLICATE)

    def test_nothing_is_ever_deleted_or_hidden_automatically(self):
        """`suspected` demotes and shows the agency a badge. It does not
        unpublish. An automatic takedown on a hash match is unrecoverable, and
        it would make copying a rival's title a way to remove their listing."""
        self.make(self.a, "Omra Chaoual")
        second = self.make(self.a, "Omra Chaoual")
        self.assertEqual(second.status, Offer.PUBLISHED)
        self.assertEqual(Offer.objects.count(), 2)
