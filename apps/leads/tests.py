"""The client half of the CRM, through the JSON door.

The page tests live in `apps/pages/tests.py`; these are the same rules through
the other entry point. Both matter: a client is a name and a phone number, and
that is exactly what a competitor would like to read.
"""

import json

from django.test import TestCase

from apps.accounts.models import Membership
from apps.common.auth import issue_access_token
from apps.common.testing import (
    make_agency,
    make_client,
    make_lead,
    make_offer,
    make_reservation,
    make_user,
)
from apps.leads.models import Client, Tag


class ClientApiTestCase(TestCase):
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

    def patch(self, path, body, user=None):
        return self.client.patch(
            path,
            data=json.dumps(body),
            content_type="application/json",
            **(self.auth(user) if user else {}),
        )

    def body(self, response):
        return json.loads(response.content)


class ClientTenantIsolationTests(ClientApiTestCase):
    def setUp(self):
        self.a = make_agency("A", slug="a")
        self.b = make_agency("B", slug="b", city="Oran")
        self.user_a = make_user("user_a", self.a, role=Membership.MANAGER)
        self.user_b = make_user("user_b", self.b, role=Membership.MANAGER)
        self.offer_a = make_offer(self.a, title_fr="Omra A")
        self.client_a = make_client(self.a, full_name="Fatima A", phone_e164="+213555111222")
        make_lead(self.a, self.offer_a, client=self.client_a)
        make_reservation(self.offer_a, client=self.client_a, party_size=3)

    def test_the_list_is_scoped_to_the_agency(self):
        res = self.get(f"/api/agencies/{self.b.id}/clients", self.user_b)
        self.assertEqual(res.status_code, 200)
        self.assertEqual(self.body(res), [])

    def test_another_agency_cannot_read_this_client(self):
        res = self.get(f"/api/agencies/{self.b.id}/clients/{self.client_a.id}", self.user_b)
        self.assertEqual(res.status_code, 404)

    def test_another_agency_cannot_update_this_client(self):
        res = self.patch(
            f"/api/agencies/{self.b.id}/clients/{self.client_a.id}",
            {"full_name": "Détourné"},
            self.user_b,
        )
        self.assertEqual(res.status_code, 404)
        self.client_a.refresh_from_db()
        self.assertEqual(self.client_a.full_name, "Fatima A")

    def test_borrowing_another_agency_s_id_is_forbidden(self):
        res = self.get(f"/api/agencies/{self.a.id}/clients", self.user_b)
        self.assertEqual(res.status_code, 403)

    def test_anonymous_cannot_reach_the_client_list(self):
        res = self.client.get(f"/api/agencies/{self.a.id}/clients")
        self.assertEqual(res.status_code, 401)


class ClientApiTests(ClientApiTestCase):
    def setUp(self):
        self.a = make_agency("A", slug="a")
        self.user_a = make_user("user_a", self.a, role=Membership.MANAGER)
        self.offer_a = make_offer(self.a, title_fr="Omra A")
        self.client_a = make_client(self.a, full_name="Fatima A", phone_e164="+213555111222")
        self.lead_a = make_lead(self.a, self.offer_a, client=self.client_a)
        self.reservation_a = make_reservation(self.offer_a, client=self.client_a, party_size=2)

    def test_the_detail_carries_the_whole_person(self):
        self.client_a.notes.create(agency=self.a, body="Préfère le soir.")
        tag = Tag.objects.create(agency=self.a, name="VIP", colour="#b45309")
        self.client_a.client_tags.create(agency=self.a, tag=tag)

        res = self.get(f"/api/agencies/{self.a.id}/clients/{self.client_a.id}", self.user_a)
        self.assertEqual(res.status_code, 200)
        data = self.body(res)
        self.assertEqual(data["full_name"], "Fatima A")
        self.assertEqual(data["lead_count"], 1)
        self.assertEqual(data["trip_count"], 1)
        self.assertEqual(len(data["leads"]), 1)
        self.assertEqual(len(data["reservations"]), 1)
        self.assertEqual(len(data["notes"]), 1)
        self.assertEqual(data["tags"], ["VIP"])

    def test_a_client_can_be_created_with_a_first_note(self):
        res = self.post(
            f"/api/agencies/{self.a.id}/clients",
            {"full_name": "Nouveau Client", "phone_e164": "+213661000002", "note": "Appel direct."},
            self.user_a,
        )
        self.assertEqual(res.status_code, 201)
        client = Client.objects.get(pk=self.body(res)["id"])
        self.assertEqual(client.notes.count(), 1)

    def test_a_duplicate_phone_is_a_409(self):
        res = self.post(
            f"/api/agencies/{self.a.id}/clients",
            {"full_name": "Doublon", "phone_e164": "+213555111222"},
            self.user_a,
        )
        self.assertEqual(res.status_code, 409)

    def test_patching_to_a_taken_phone_is_a_409(self):
        make_client(self.a, full_name="Autre", phone_e164="+213777000003")
        res = self.patch(
            f"/api/agencies/{self.a.id}/clients/{self.client_a.id}",
            {"phone_e164": "+213777000003"},
            self.user_a,
        )
        self.assertEqual(res.status_code, 409)

    def test_a_note_can_be_added_through_the_api(self):
        res = self.post(
            f"/api/agencies/{self.a.id}/clients/{self.client_a.id}/notes",
            {"body": "Rappelée, veut partir en famille."},
            self.user_a,
        )
        self.assertEqual(res.status_code, 201)
        self.assertEqual(self.client_a.notes.count(), 1)

    def test_filters_use_the_same_definition_as_the_page(self):
        # Fatima needs a second trip for "répété" to mean anything; one trip
        # is exactly what the filter is supposed to exclude.
        make_reservation(make_offer(self.a, title_fr="Tunis A"), client=self.client_a, party_size=1)
        once = make_client(self.a, full_name="One Trip", phone_e164="+213555999000")
        make_reservation(self.offer_a, client=once, party_size=1)
        res = self.get(f"/api/agencies/{self.a.id}/clients?filter=repeat", self.user_a)
        names = [row["full_name"] for row in self.body(res)]
        self.assertIn("Fatima A", names)
        self.assertNotIn("One Trip", names)

    def test_search_accepts_a_local_phone_number(self):
        res = self.get(f"/api/agencies/{self.a.id}/clients?q=0555111222", self.user_a)
        self.assertEqual([row["full_name"] for row in self.body(res)], ["Fatima A"])


class InquiryCreatesAClientTests(TestCase):
    def test_a_public_inquiry_creates_the_person_and_links_the_lead(self):
        agency = make_agency("A", slug="a")
        offer = make_offer(agency)
        res = self.client.post(
            "/api/inquiries",
            data=json.dumps(
                {
                    "offer_id": str(offer.id),
                    "full_name": "Fatima Zerrouki",
                    "phone_e164": "+213555111222",
                    "message": "Le visa est-il inclus ?",
                    "consent": True,
                }
            ),
            content_type="application/json",
        )
        self.assertEqual(res.status_code, 201)
        client = Client.objects.get(agency=agency, phone_e164="+213555111222")
        self.assertEqual(client.full_name, "Fatima Zerrouki")
        self.assertEqual(client.leads.count(), 1)
