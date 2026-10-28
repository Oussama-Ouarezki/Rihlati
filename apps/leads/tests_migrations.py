"""The client backfill, run against a database that already has history.

A fresh database proves nothing about this migration: with no rows, every
backfill is vacuously correct. The risk it guards against is the preview
database — leads and bookings that predate `Client` — where a wrong mapping
shows up as two clients for one person, or as an unlinked reservation.

The two migrations are split across apps because the dependency would otherwise
be circular (leads ← trips ← leads), so both halves are exercised here in the
order Django runs them.
"""

from apps.offers.tests_migrations import MigrationTestCase

LEADS_BEFORE = "0002_leadactivity_leadnote_leadtag_tag_lead_assigned_to_and_more"
LEADS_AFTER = "0003_client_lead_client_clientnote_clienttag_and_more"


class ClientBackfillTests(MigrationTestCase):
    migrate_from = [
        ("leads", LEADS_BEFORE),
        ("trips", "0001_initial"),
    ]
    migrate_to = [
        ("leads", LEADS_AFTER),
        ("trips", "0002_reservation_client"),
    ]

    def seed(self, apps):
        Agency = apps.get_model("accounts", "Agency")
        Lead = apps.get_model("leads", "Lead")
        Offer = apps.get_model("offers", "Offer")
        Reservation = apps.get_model("trips", "Reservation")

        self.agency = Agency.objects.create(name="Dar Essalam", slug="dar-essalam", city="Alger")
        self.other = Agency.objects.create(name="Wahran Tours", slug="wahran-tours", city="Oran")
        offer = Offer.objects.create(
            agency=self.agency,
            title_fr="Omra Ramadan",
            title_ar="عمرة رمضان",
            slug="omra-ramadan",
            kind="omra",
            price_centimes=25_000_000,
            departure_date="2027-03-01",
            seats_total=40,
            seats_left=40,
            status="published",
        )

        # Two inquiries from the same number. The first is the name the client
        # should keep; the second must not rename them or make a second row.
        first = Lead.objects.create(
            agency=self.agency,
            offer=offer,
            full_name="Fatima Zerrouki",
            phone_e164="+213555111222",
        )
        Lead.objects.create(
            agency=self.agency,
            offer=offer,
            full_name="Fatima Z.",
            phone_e164="+213555111222",
        )
        # A different number is a different person.
        Lead.objects.create(
            agency=self.agency,
            offer=offer,
            full_name="Mohamed Amrani",
            phone_e164="+213661000002",
        )
        # Same number, other tenant: a different client there, in the same way
        # one shared phone is two people to two unrelated agencies.
        other_offer = Offer.objects.create(
            agency=self.other,
            title_fr="Séjour Tunis",
            title_ar="رحلة تونس",
            slug="sejour-tunis",
            kind="omra",
            price_centimes=10_000_000,
            departure_date="2027-04-01",
            seats_total=20,
            seats_left=20,
            status="published",
        )
        Lead.objects.create(
            agency=self.other,
            offer=other_offer,
            full_name="Fatima Zerrouki",
            phone_e164="+213555111222",
        )

        # A booking made from a lead, and a walk-in with no lead at all. The
        # walk-in is the one that catches a backfill that only reads leads.
        Reservation.objects.create(
            agency=self.agency,
            offer=offer,
            lead=first,
            full_name="Fatima Zerrouki",
            phone_e164="+213555111222",
            party_size=4,
            public_code="a" * 32,
        )
        Reservation.objects.create(
            agency=self.agency,
            offer=offer,
            full_name="Traveler Six",
            phone_e164="+213555000006",
            party_size=2,
            public_code="b" * 32,
        )

    def test_one_client_per_person_per_agency(self):
        Client = self.apps.get_model("leads", "Client")
        clients = Client.objects.filter(agency_id=self.agency.pk)

        self.assertEqual(clients.count(), 3)
        shared = clients.get(phone_e164="+213555111222")
        self.assertEqual(shared.leads.count(), 2)

    def test_the_client_keeps_the_name_from_the_first_inquiry(self):
        Client = self.apps.get_model("leads", "Client")
        client = Client.objects.get(agency_id=self.agency.pk, phone_e164="+213555111222")

        self.assertEqual(client.full_name, "Fatima Zerrouki")

    def test_the_same_phone_in_another_agency_is_another_client(self):
        Client = self.apps.get_model("leads", "Client")

        self.assertEqual(Client.objects.filter(phone_e164="+213555111222").count(), 2)
        self.assertTrue(
            Client.objects.filter(agency_id=self.other.pk, phone_e164="+213555111222").exists()
        )

    def test_every_lead_is_linked(self):
        Lead = self.apps.get_model("leads", "Lead")

        self.assertEqual(Lead.objects.filter(client__isnull=True).count(), 0)

    def test_a_walk_in_booking_gets_a_client_even_with_no_lead(self):
        Client = self.apps.get_model("leads", "Client")

        client = Client.objects.get(agency_id=self.agency.pk, phone_e164="+213555000006")
        self.assertEqual(client.full_name, "Traveler Six")
        self.assertEqual(client.reservations.count(), 1)

    def test_a_booking_from_a_lead_reuses_that_lead_s_client(self):
        Reservation = self.apps.get_model("trips", "Reservation")
        booking = Reservation.objects.get(public_code="a" * 32)

        self.assertIsNotNone(booking.client_id)
        self.assertEqual(booking.client.phone_e164, "+213555111222")

    def test_every_reservation_is_linked(self):
        Reservation = self.apps.get_model("trips", "Reservation")

        self.assertEqual(Reservation.objects.filter(client__isnull=True).count(), 0)
