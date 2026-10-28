"""The manifest, the 4am checkpoint, and the one URL that is its own password.

Three things are under test here, and only the first is routine:

1. **Tenant isolation** on reservations and check-ins — rule #3, the same
   create-as-A / fetch-as-B pair every resource ships with.
2. **Seat arithmetic**, because it is the only place in this app where two
   numbers must stay in agreement across a transaction. A reservation takes
   seats, a cancellation gives them back, and un-cancelling takes them again.
   A one-way rule leaves offers permanently short.
3. **What `/api/my-trip/{code}` does not say.** That endpoint has no login: the
   code in the URL *is* the credential. The tests that matter most in this file
   are the ones asserting the response body stays a short allow-list — a leak
   here is a passenger list handed to whoever forwards a WhatsApp message.
"""

import json

from django.test import TestCase

from apps.accounts.models import Membership
from apps.common.auth import issue_access_token
from apps.common.testing import make_agency, make_lead, make_milestone, make_offer, make_user
from apps.leads.models import Lead
from apps.offers.models import CheckpointType, Offer
from apps.trips.models import AttendanceStatus, MilestoneCheckIn, Reservation


class TripApiTestCase(TestCase):
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


class TwoAgencies(TripApiTestCase):
    def setUp(self):
        self.a = make_agency("Agency A", slug="a")
        self.b = make_agency("Agency B", slug="b", city="Oran")
        self.user_a = make_user("user_a", self.a, role=Membership.MANAGER)
        self.user_b = make_user("user_b", self.b, role=Membership.MANAGER)
        self.offer_a = make_offer(self.a, title_fr="Omra Ramadan")
        self.reservation_a = Reservation.objects.create(
            agency=self.a,
            offer=self.offer_a,
            full_name="Famille Amrani",
            phone_e164="+213555000001",
            party_size=4,
        )


class ManifestIsolationTests(TwoAgencies):
    def test_another_agency_cannot_list_this_offer_s_reservations(self):
        """B, under B's own path, asking for A's offer. Membership passes — B
        really is a member of B — so the only thing left is the queryset
        filter."""
        url = f"/api/agencies/{self.b.id}/offers/{self.offer_a.id}/reservations"
        self.assertEqual(self.get(url, self.user_b).status_code, 404)

    def test_another_agency_cannot_borrow_this_agency_s_id(self):
        """B putting A's agency id in the path fails earlier, at membership,
        and gets 403 on purpose: agency ids appear in public URLs and are not
        secret, so "you are not a member" leaks nothing."""
        url = f"/api/agencies/{self.a.id}/offers/{self.offer_a.id}/reservations"
        self.assertEqual(self.get(url, self.user_b).status_code, 403)

    def test_another_agency_cannot_change_a_reservation_s_status(self):
        url = f"/api/agencies/{self.b.id}/reservations/{self.reservation_a.id}"
        response = self.patch(url, {"status": AttendanceStatus.CHECKED_IN}, self.user_b)
        self.assertEqual(response.status_code, 404)
        self.reservation_a.refresh_from_db()
        self.assertEqual(self.reservation_a.status, AttendanceStatus.EXPECTED)

    def test_a_reservation_cannot_be_attached_to_another_agency_s_lead(self):
        """The lead id is client-supplied, so it is scoped like everything else.
        Without this, "reserve for lead X" is a way to read a competitor's
        client list one id at a time."""
        lead_b = make_lead(self.b, make_offer(self.b))
        response = self.post(
            f"/api/agencies/{self.a.id}/reservations",
            {
                "offer_id": str(self.offer_a.id),
                "full_name": "Famille Test",
                "phone_e164": "+213555000002",
                "lead_id": str(lead_b.id),
            },
            self.user_a,
        )
        self.assertEqual(response.status_code, 404)
        self.assertEqual(Reservation.objects.filter(lead=lead_b).count(), 0)

    def test_a_member_sees_only_their_own_offer_s_manifest(self):
        url = f"/api/agencies/{self.a.id}/offers/{self.offer_a.id}/reservations"
        rows = self.body(self.get(url, self.user_a))
        self.assertEqual([r["full_name"] for r in rows], ["Famille Amrani"])


class SeatArithmeticTests(TwoAgencies):
    def seats_left(self):
        return Offer.objects.get(pk=self.offer_a.pk).seats_left

    def test_a_reservation_takes_seats_for_the_whole_family(self):
        """One reservation is one family. Counting rows instead of people is
        how a 52-seat bus "fits" 70."""
        before = self.seats_left()
        response = self.post(
            f"/api/agencies/{self.a.id}/reservations",
            {
                "offer_id": str(self.offer_a.id),
                "full_name": "Famille Bensaid",
                "phone_e164": "+213555000003",
                "party_size": 3,
            },
            self.user_a,
        )
        self.assertEqual(response.status_code, 201)
        self.assertEqual(self.seats_left(), before - 3)

    def test_a_party_bigger_than_the_bus_is_refused(self):
        response = self.post(
            f"/api/agencies/{self.a.id}/reservations",
            {
                "offer_id": str(self.offer_a.id),
                "full_name": "Grande Famille",
                "phone_e164": "+213555000004",
                "party_size": 50,
            },
            self.user_a,
        )
        self.assertEqual(response.status_code, 409)
        self.assertEqual(self.seats_left(), 10)

    def test_cancelling_gives_the_seats_back_and_un_cancelling_takes_them_again(self):
        Offer.objects.filter(pk=self.offer_a.pk).update(seats_left=6)  # the 4 above are taken
        url = f"/api/agencies/{self.a.id}/reservations/{self.reservation_a.id}"

        self.patch(url, {"status": AttendanceStatus.CANCELLED}, self.user_a)
        self.assertEqual(self.seats_left(), 10)

        # Cancellations get reversed often enough that the one-way version
        # would leave this offer permanently four seats short.
        self.patch(url, {"status": AttendanceStatus.EXPECTED}, self.user_a)
        self.assertEqual(self.seats_left(), 6)

    def test_seats_never_exceed_the_bus_when_a_cancellation_is_repeated(self):
        url = f"/api/agencies/{self.a.id}/reservations/{self.reservation_a.id}"
        self.patch(url, {"status": AttendanceStatus.CANCELLED}, self.user_a)
        self.patch(url, {"status": AttendanceStatus.CANCELLED}, self.user_a)
        self.assertEqual(self.seats_left(), 10)

    def test_an_unknown_status_is_refused(self):
        url = f"/api/agencies/{self.a.id}/reservations/{self.reservation_a.id}"
        self.assertEqual(self.patch(url, {"status": "boarded"}, self.user_a).status_code, 422)

    def test_a_phone_number_that_is_not_algerian_is_refused(self):
        """400, not 422, and that is not a typo.

        A shape failure caught by the Pydantic schema is 422; a rule failure
        caught by a Django validator inside the handler is 400. Both carry the
        same `VALIDATION_FAILED` code, which is what a client actually branches
        on — see `STATUS_TO_CODE` in `apps/common/errors.py`. Pinned here so
        the distinction is a decision somebody made rather than a surprise.
        """
        response = self.post(
            f"/api/agencies/{self.a.id}/reservations",
            {
                "offer_id": str(self.offer_a.id),
                "full_name": "Famille Test",
                "phone_e164": "0555000005",
                "party_size": 1,
            },
            self.user_a,
        )
        self.assertEqual(response.status_code, 400)
        self.assertEqual(self.body(response)["code"], "VALIDATION_FAILED")


class CheckpointTests(TwoAgencies):
    def setUp(self):
        super().setUp()
        self.stop = make_milestone(
            self.offer_a, title="Départ du bus", checkpoint_type=CheckpointType.MANDATORY
        )
        self.url = f"/api/agencies/{self.a.id}/milestones/{self.stop.id}/checkpoint"

    def test_rows_are_created_lazily_on_first_open(self):
        """A checkpoint invented mid-trip needs no backfill, and this morning's
        reservation appears without anyone re-running anything."""
        self.assertEqual(MilestoneCheckIn.objects.count(), 0)
        payload = self.body(self.get(self.url, self.user_a))
        self.assertEqual(payload["expected"], 1)
        self.assertEqual([r["full_name"] for r in payload["rows"]], ["Famille Amrani"])
        self.assertEqual(MilestoneCheckIn.objects.count(), 1)

    def test_opening_twice_does_not_duplicate_rows(self):
        self.get(self.url, self.user_a)
        self.get(self.url, self.user_a)
        self.assertEqual(MilestoneCheckIn.objects.count(), 1)

    def test_a_cancelled_family_is_not_on_the_list(self):
        self.reservation_a.status = AttendanceStatus.CANCELLED
        self.reservation_a.save(update_fields=["status"])
        self.assertEqual(self.body(self.get(self.url, self.user_a))["rows"], [])

    def test_a_step_with_no_pointage_refuses_to_be_a_checkpoint(self):
        plain = make_milestone(self.offer_a, title="Dîner", checkpoint_type=CheckpointType.NONE)
        url = f"/api/agencies/{self.a.id}/milestones/{plain.id}/checkpoint"
        self.assertEqual(self.get(url, self.user_a).status_code, 409)

    def test_another_agency_cannot_open_the_checkpoint(self):
        url = f"/api/agencies/{self.b.id}/milestones/{self.stop.id}/checkpoint"
        self.assertEqual(self.get(url, self.user_b).status_code, 404)

    def test_one_tap_records_who_counted_this_family_and_when(self):
        """The stamp is the accountability: months later, "who counted them?"
        has an answer."""
        agent = make_user("agent_a", self.a, role=Membership.AGENT)
        response = self.post(
            f"{self.url}/{self.reservation_a.id}",
            {"status": AttendanceStatus.CHECKED_IN},
            agent,
        )
        self.assertEqual(response.status_code, 200)
        row = MilestoneCheckIn.objects.get()
        self.assertEqual(row.status, AttendanceStatus.CHECKED_IN)
        self.assertIsNotNone(row.checked_in_at)
        self.assertEqual(row.checked_in_by, agent)

    def test_undoing_a_check_in_clears_the_stamp(self):
        """ "Oops, wrong row" is the most common second tap at a bus at 4am. A
        corrected mistake must not leave a phantom "was counted at 04:12"."""
        self.post(f"{self.url}/{self.reservation_a.id}", {"status": "checked_in"}, self.user_a)
        self.post(f"{self.url}/{self.reservation_a.id}", {"status": "expected"}, self.user_a)
        row = MilestoneCheckIn.objects.get()
        self.assertEqual(row.status, AttendanceStatus.EXPECTED)
        self.assertIsNone(row.checked_in_at)

    def test_an_agent_may_check_families_in(self):
        """Check-in at the bus IS agent work. A manager-only manifest would
        just mean the owner's phone gets passed around in the dark."""
        agent = make_user("agent_b", self.a, role=Membership.AGENT)
        response = self.post(f"{self.url}/{self.reservation_a.id}", {"status": "checked_in"}, agent)
        self.assertEqual(response.status_code, 200)

    def test_another_agency_cannot_check_in_this_family(self):
        response = self.post(
            f"/api/agencies/{self.b.id}/milestones/{self.stop.id}/checkpoint/{self.reservation_a.id}",
            {"status": "checked_in"},
            self.user_b,
        )
        self.assertEqual(response.status_code, 404)

    def test_an_optional_stop_carries_yesterday_s_absence_forward(self):
        """A family that skipped yesterday's excursion probably skipped today's.
        Re-marking the same absent family at every stop is how a guide stops
        using the app — and it is only a default, one tap changes it."""
        yesterday = make_milestone(
            self.offer_a, title="Excursion 1", day_offset=1, checkpoint_type="optional"
        )
        today = make_milestone(
            self.offer_a, title="Excursion 2", day_offset=2, checkpoint_type="optional"
        )
        MilestoneCheckIn.objects.create(
            agency=self.a,
            milestone=yesterday,
            reservation=self.reservation_a,
            status=AttendanceStatus.NO_SHOW,
        )
        url = f"/api/agencies/{self.a.id}/milestones/{today.id}/checkpoint"
        self.assertEqual(self.body(self.get(url, self.user_a))["no_show"], 1)

    def test_a_mandatory_stop_never_defaults_anyone_absent(self):
        """A wrong default at a flight or a departure bus means a family left
        behind. Somebody confirms each one, physically."""
        earlier = make_milestone(
            self.offer_a, title="Excursion", day_offset=1, checkpoint_type="optional"
        )
        MilestoneCheckIn.objects.create(
            agency=self.a,
            milestone=earlier,
            reservation=self.reservation_a,
            status=AttendanceStatus.NO_SHOW,
        )
        flight = make_milestone(
            self.offer_a, title="Vol retour", day_offset=9, checkpoint_type="mandatory"
        )
        url = f"/api/agencies/{self.a.id}/milestones/{flight.id}/checkpoint"
        self.assertEqual(self.body(self.get(url, self.user_a))["expected"], 1)


class MyTripTests(TripApiTestCase):
    """The capability URL. Holding it is the credential, so the whole question
    is what it can be traded for."""

    def setUp(self):
        self.agency = make_agency("Agence Nour", slug="nour", phone="+213555999999")
        self.offer = make_offer(self.agency, title_fr="Omra Ramadan")
        make_milestone(self.offer, title="Rassemblement", day_offset=0)
        self.mine = Reservation.objects.create(
            agency=self.agency,
            offer=self.offer,
            full_name="Famille Amrani",
            phone_e164="+213555000001",
            party_size=4,
            note="A payé en espèces — rappeler le frère",
        )
        self.neighbour = Reservation.objects.create(
            agency=self.agency,
            offer=self.offer,
            full_name="Famille Bensaid",
            phone_e164="+213555000002",
        )

    def url(self, code):
        return f"/api/my-trip/{code}"

    def test_a_family_opens_their_page_with_no_account(self):
        """No Authorization header. That is the point: the link arrives by SMS
        and gets opened on a nephew's phone."""
        payload = self.body(self.get(self.url(self.mine.public_code)))
        self.assertEqual(payload["full_name"], "Famille Amrani")
        self.assertEqual(payload["party_size"], 4)
        self.assertEqual([m["title"] for m in payload["milestones"]], ["Rassemblement"])

    def test_the_page_never_carries_the_passenger_list_or_the_crm_note(self):
        """The single assertion this endpoint exists to survive. Anything added
        to `MyTripOut` later has to get past this test first."""
        raw = self.get(self.url(self.mine.public_code)).content.decode()
        self.assertNotIn("Bensaid", raw)
        self.assertNotIn("espèces", raw)
        self.assertNotIn(self.neighbour.public_code, raw)
        self.assertNotIn(self.mine.phone_e164, raw)

    def test_an_unknown_code_is_a_404(self):
        self.assertEqual(self.get(self.url("0" * 32)).status_code, 404)

    def test_a_code_of_the_wrong_shape_never_reaches_the_database(self):
        """Fail on length first, so a scanner cannot turn this endpoint into a
        query generator."""
        with self.assertNumQueries(0):
            self.assertEqual(self.get(self.url("abc")).status_code, 404)

    def test_the_current_step_is_the_first_one_not_ticked_off(self):
        """Progress comes from a deliberate tick by somebody standing there,
        never from the clock — the bus leaves when the bus leaves."""
        second = make_milestone(self.offer, title="Départ", day_offset=0, sort_order=1)
        payload = self.body(self.get(self.url(self.mine.public_code)))
        self.assertEqual([m["is_current"] for m in payload["milestones"]], [True, False])

        from apps.trips.models import mark_completed

        mark_completed(self.offer.milestones.first(), None)
        payload = self.body(self.get(self.url(self.mine.public_code)))
        self.assertEqual(payload["milestones"][1]["title"], second.title)
        self.assertEqual([m["is_current"] for m in payload["milestones"]], [False, True])


class LeadConversionTests(TwoAgencies):
    def test_reserving_from_a_lead_marks_it_booked(self):
        lead = make_lead(self.a, self.offer_a, full_name="Famille Khaled")
        response = self.post(
            f"/api/agencies/{self.a.id}/reservations",
            {
                "offer_id": str(self.offer_a.id),
                "full_name": "Famille Khaled",
                "phone_e164": "+213555000006",
                "party_size": 2,
                "lead_id": str(lead.id),
            },
            self.user_a,
        )
        self.assertEqual(response.status_code, 201)
        lead.refresh_from_db()
        self.assertEqual(lead.status, Lead.BOOKED)
        # Converting a lead is a first response by any reasonable definition,
        # and the response-time metric would otherwise count this agency slow.
        self.assertIsNotNone(lead.first_responded_at)

    def test_contact_details_are_snapshotted_not_linked(self):
        """The 4am list must not change because someone edited a record the
        night before."""
        lead = make_lead(self.a, self.offer_a, full_name="Famille Khaled")
        self.post(
            f"/api/agencies/{self.a.id}/reservations",
            {
                "offer_id": str(self.offer_a.id),
                "full_name": "Famille Khaled",
                "phone_e164": "+213555000007",
                "party_size": 1,
                "lead_id": str(lead.id),
            },
            self.user_a,
        )
        lead.full_name = "Nom corrigé"
        lead.save(update_fields=["full_name"])
        reservation = Reservation.objects.get(lead=lead)
        self.assertEqual(reservation.full_name, "Famille Khaled")
