"""Tests for the marketplace-wide discovery chat.

Two properties carry the feature:

* The answer comes from public rows, not from a model. A draft, an unverified
  agency or a confirmed duplicate must never appear, whatever the sentence.
* A follow-up refines the previous search. "cheaper" and "from Oran" are the
  difference between a chat and a search box with extra steps.

The model is not involved at all here, so these tests do not need Ollama.
"""

from unittest.mock import patch

from django.test import TestCase
from django.urls import reverse

from apps.chat import discovery
from apps.common.testing import make_agency, make_offer
from apps.offers.models import Offer

ORAN = "31"
ALGIERS = "16"


class DiscoveryIntentTests(TestCase):
    def test_a_duration_is_not_mistaken_for_a_budget(self):
        parsed = discovery.parse_message("7 nights under 300 000 DZD")
        self.assertEqual(parsed["budget_max"], 300_000)
        self.assertEqual(parsed["duration_days"], 7)

    def test_departure_city_is_extracted_from_context(self):
        parsed = discovery.parse_message("Omra under 400 000 DZD from Oran")
        self.assertEqual(parsed["departure_wilaya"], ORAN)

    def test_cheaper_reduces_the_previous_budget(self):
        previous = discovery.parse_message("Omra under 400 000 DZD")
        previous["departure_wilaya"] = None
        intent, _ = discovery.merge_intent(discovery.empty_intent(), previous, "Omra")
        refined, _ = discovery.merge_intent(intent, discovery.parse_message("cheaper"), "cheaper")
        self.assertEqual(refined["budget_max"], 320_000)
        self.assertEqual(refined["kind"], ["omra"])

    def test_a_follow_up_keeps_the_previous_fields(self):
        previous = discovery.parse_message("Omra under 400 000 DZD")
        previous["departure_wilaya"] = None
        intent, _ = discovery.merge_intent(discovery.empty_intent(), previous, "Omra")
        refined, _ = discovery.merge_intent(
            intent, discovery.parse_message("from Oran"), "from Oran"
        )
        self.assertEqual(refined["budget_max"], 400_000)
        self.assertEqual(refined["departure_wilaya"], ORAN)

    def test_reset_forgets_everything(self):
        previous = discovery.parse_message("Omra under 400 000 DZD")
        previous["departure_wilaya"] = None
        intent, _ = discovery.merge_intent(discovery.empty_intent(), previous, "Omra")
        cleared, reset = discovery.merge_intent(
            intent, discovery.parse_message("new search"), "new search"
        )
        self.assertTrue(reset)
        self.assertEqual(cleared, discovery.empty_intent())


class DiscoverySearchTests(TestCase):
    def setUp(self):
        self.verified = make_agency("Dar Essalam", slug="dar")
        self.hidden = make_agency("Sahara", slug="sahara", verified=False)

        self.omra = make_offer(
            self.verified,
            title_fr="Omra under budget",
            kind=Offer.OMRA,
            price_centimes=30_000_000,
            departure_wilaya_code=ALGIERS,
            attributes={"visa_included": True, "flight_included": True},
        )
        self.expensive_omra = make_offer(
            self.verified,
            title_fr="Luxury Omra",
            kind=Offer.OMRA,
            price_centimes=90_000_000,
            departure_wilaya_code=ALGIERS,
        )
        self.beach = make_offer(
            self.verified,
            title_fr="Beach week",
            kind=Offer.TRIP,
            price_centimes=9_000_000,
            departure_wilaya_code=ALGIERS,
            destination_city="Djerba",
            destination_country="Tunisia",
            attributes={"beachfront": True},
        )
        self.draft = make_offer(
            self.verified, title_fr="Draft Omra", kind=Offer.OMRA, status=Offer.DRAFT
        )
        self.unverified = make_offer(self.hidden, title_fr="Hidden Omra", kind=Offer.OMRA)

    def titles(self, response):
        return [offer["title"] for offer in response["offers"]]

    def test_budget_search_returns_only_public_matches(self):
        result = discovery.build_response("Omra under 400 000 DZD", None)
        self.assertEqual(self.titles(result), ["Omra under budget"])
        self.assertNotIn("Draft Omra", self.titles(result))
        self.assertNotIn("Hidden Omra", self.titles(result))

    def test_beach_is_a_theme_not_a_destination(self):
        result = discovery.build_response("beach trip from Algiers", None)
        self.assertEqual(self.titles(result), ["Beach week"])

    def test_inclusion_filter_uses_real_attribute_keys(self):
        result = discovery.build_response("Omra with visa included", None)
        self.assertEqual(self.titles(result), ["Omra under budget"])

    def test_a_destination_only_search_reads_naturally(self):
        result = discovery.build_response("Marrakech from Oran", None)
        self.assertEqual(result["summary"], "Marrakech from Oran")
        self.assertIn("for “Marrakech from Oran”", result["reply"])

    def test_no_match_gets_an_honest_answer(self):
        result = discovery.build_response("Hajj under 100 DZD", None)
        self.assertEqual(result["offers"], [])
        self.assertIn("could not find", result["reply"])

    def test_a_greeting_still_suggests_departures(self):
        result = discovery.build_response("hello", None)
        self.assertTrue(result["offers"])
        self.assertIn("next departures", result["reply"])

    def test_the_page_is_public_and_hides_unpublished_rows(self):
        response = self.client.get(reverse("discover"))
        self.assertEqual(response.status_code, 200)
        self.assertContains(response, "Omra under budget")
        self.assertNotContains(response, "Draft Omra")
        self.assertNotContains(response, "Hidden Omra")

    def test_the_page_has_a_chat_shell_and_reset_control(self):
        response = self.client.get(reverse("discover"))
        self.assertContains(response, "New search")
        self.assertContains(response, "data-discover-log")
        self.assertContains(response, "data-discover-reset")

    def test_a_budget_intent_maps_to_the_browse_form(self):
        result = discovery.build_response("Omra under 400 000 DZD from Oran", None)
        self.assertIn("kind=omra", result["search_url"])
        self.assertIn("wilaya=31", result["search_url"])
        self.assertIn("max_price=400000", result["search_url"])

    def test_total_counts_matches_before_the_visible_cut(self):
        for index in range(3):
            make_offer(
                self.verified,
                title_fr=f"Extra Omra {index}",
                kind=Offer.OMRA,
                price_centimes=31_000_000,
            )
        with patch("apps.chat.discovery.MAX_RESULTS", 2):
            result = discovery.build_response("Omra under 400 000 DZD", None)
        self.assertEqual(len(result["offers"]), 2)
        self.assertEqual(result["total"], 4)
        self.assertIn("Showing 2 of them", result["reply"])


class DiscoveryApiTests(TestCase):
    def setUp(self):
        self.agency = make_agency("Dar Essalam", slug="dar")
        self.offer = make_offer(
            self.agency,
            title_fr="Omra under budget",
            kind=Offer.OMRA,
            price_centimes=30_000_000,
            departure_wilaya_code=ALGIERS,
            attributes={"visa_included": True},
        )
        self.url = reverse("api:discover")

    def post(self, **payload):
        return self.client.post(self.url, payload, content_type="application/json")

    def test_no_login_is_required(self):
        response = self.post(message="Omra under 400 000 DZD")
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["offers"][0]["title"], "Omra under budget")
        self.assertEqual(body["summary"], "Omra under 400 000 DZD")
        self.assertEqual(body["total"], 1)
        self.assertIn("kind=omra", body["search_url"])

    def test_the_session_carries_the_intent_between_turns(self):
        self.post(message="Omra under 400 000 DZD")
        response = self.post(message="cheaper")
        self.assertEqual(response.json()["intent"]["budget_max"], 320_000)
        self.assertEqual(response.json()["offers"][0]["title"], "Omra under budget")

    def test_reset_clears_the_session_intent(self):
        self.post(message="Omra under 400 000 DZD")
        response = self.post(message="hello", reset=True)
        self.assertIn("next departures", response.json()["reply"])
        self.assertEqual(self.client.session[discovery.SESSION_KEY], discovery.empty_intent())

    def test_an_empty_message_is_rejected(self):
        response = self.post(message="")
        self.assertEqual(response.status_code, 422)

    def test_the_endpoint_never_returns_an_unpublished_duplicate(self):
        make_offer(
            self.agency,
            title_fr="Duplicate Omra",
            kind=Offer.OMRA,
            duplicate_status=Offer.CONFIRMED_DUPLICATE,
        )
        response = self.post(message="Omra")
        titles = [offer["title"] for offer in response.json()["offers"]]
        self.assertNotIn("Duplicate Omra", titles)
