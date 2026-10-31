"""Fake data so the preview shows something. No real names or phone numbers.

Two rules this file follows, and both have bitten before:

* **Every seeded lead carries a consent trail.** The model's position is that a
  lead without one is not a cheaper lead, it is not a lead — so a seed that
  creates bare `Lead` rows produces a database in a state the application
  refuses to produce, and then someone debugs the consent code against it.
* **Seed the features that exist, not the three that existed first.** A demo
  with no milestones, no manifest and no tracked links makes those features
  look broken when someone clicks into them and finds an empty page.
"""

from datetime import date, timedelta

from django.conf import settings
from django.core.management.base import BaseCommand, CommandError
from django.db import transaction
from django.utils import timezone

from apps.accounts.models import Agency, Membership, User
from apps.leads.models import CONSENT_TEXT_VERSION, Client, ClientNote, Lead, LeadActivity, Tag
from apps.leads.services import client_for_contact
from apps.offers.models import (
    CheckpointType,
    MilestoneKind,
    Offer,
    OfferMilestone,
    TrackedLink,
)
from apps.reviews.models import Review
from apps.trips.models import AttendanceStatus, Reservation

PASSWORD = "preview-password"  # throwaway local fixture, not a credential

# Free Unsplash photos, hotlinked exactly like agency-supplied URLs would be.
PHOTOS = {
    "omra": "https://images.unsplash.com/photo-1591604129939-f1efa4d9f7fa?w=800&q=70",
    "istanbul": "https://images.unsplash.com/photo-1541432901042-2d8bd64b4a9b?w=800&q=70",
    "tunis": "https://images.unsplash.com/photo-1548574505-5e239809ee19?w=800&q=70",
    "visa": "https://images.unsplash.com/photo-1569154941061-e231b4725ef1?w=800&q=70",
    "hajj": "https://images.unsplash.com/photo-1519817650390-64a93db51149?w=800&q=70",
    "marrakech": "https://images.unsplash.com/photo-1597212618440-806262de4f6b?w=800&q=70",
    "djerba": "https://images.unsplash.com/photo-1603565816030-6b389eeb23cb?w=800&q=70",
    "paris": "https://images.unsplash.com/photo-1502602898657-3e91760cbb34?w=800&q=70",
}

# Programmes are data, not logic: one list per offer, keyed by its English
# title. Module-level so a database that already exists can be topped up
# without re-running the destructive seed — and so the preview never shows a
# listing with an empty itinerary. The tuple is
# (day_offset, time_of_day, title, kind, checkpoint_type).
PROGRAMMES = {
    "Omra Ramadan — 15 days": [
        (0, "06:00", "Airport meeting", MilestoneKind.MEETING, CheckpointType.MANDATORY),
        (0, "09:30", "Flight Algiers — Jeddah", MilestoneKind.FLIGHT, CheckpointType.NONE),
        (0, "18:00", "Hotel check-in", MilestoneKind.HOTEL, CheckpointType.NONE),
        (1, "04:30", "Umrah — Tawaf and Sa'i", MilestoneKind.RITUAL, CheckpointType.OPTIONAL),
        (3, "08:00", "Departure for Madinah", MilestoneKind.TRANSPORT, CheckpointType.MANDATORY),
        (4, "10:00", "Ziyara of the holy sites", MilestoneKind.ZIYARA, CheckpointType.OPTIONAL),
    ],
    "Istanbul — 7 nights, flight included": [
        (
            0,
            "07:00",
            "Meeting at Oran airport",
            MilestoneKind.MEETING,
            CheckpointType.MANDATORY,
        ),
        (0, "10:15", "Flight Oran — Istanbul", MilestoneKind.FLIGHT, CheckpointType.NONE),
        (
            0,
            "15:30",
            "Transfer and hotel check-in",
            MilestoneKind.HOTEL,
            CheckpointType.NONE,
        ),
        (
            1,
            "09:00",
            "Breakfast and trip briefing",
            MilestoneKind.MEAL,
            CheckpointType.OPTIONAL,
        ),
        (2, "08:30", "Bosphorus cruise", MilestoneKind.OTHER, CheckpointType.OPTIONAL),
        (3, "09:00", "Sultanahmet visit", MilestoneKind.OTHER, CheckpointType.OPTIONAL),
        (
            4,
            "10:00",
            "Free day and Grand Bazaar",
            MilestoneKind.FREE_TIME,
            CheckpointType.OPTIONAL,
        ),
        (
            7,
            "12:00",
            "Transfer to the airport",
            MilestoneKind.TRANSPORT,
            CheckpointType.MANDATORY,
        ),
        (7, "15:00", "Return flight Istanbul — Oran", MilestoneKind.FLIGHT, CheckpointType.NONE),
    ],
    "Tunisia — 5 nights by the sea": [
        (
            0,
            "06:00",
            "Meeting at Algiers bus station",
            MilestoneKind.MEETING,
            CheckpointType.MANDATORY,
        ),
        (
            0,
            "07:00",
            "Coach Algiers — Hammamet",
            MilestoneKind.TRANSPORT,
            CheckpointType.MANDATORY,
        ),
        (0, "16:00", "Hotel check-in", MilestoneKind.HOTEL, CheckpointType.NONE),
        (1, "09:30", "Breakfast and beach", MilestoneKind.MEAL, CheckpointType.OPTIONAL),
        (2, "08:00", "Kairouan excursion", MilestoneKind.OTHER, CheckpointType.OPTIONAL),
        (3, "10:00", "Free day in Hammamet", MilestoneKind.FREE_TIME, CheckpointType.OPTIONAL),
        (
            5,
            "08:00",
            "Departure Hammamet — Algiers",
            MilestoneKind.TRANSPORT,
            CheckpointType.MANDATORY,
        ),
        (5, "17:00", "Arrival in Algiers", MilestoneKind.TRANSPORT, CheckpointType.NONE),
    ],
    "Schengen visa assistance": [
        (
            0,
            "09:00",
            "File review and first contact",
            MilestoneKind.MEETING,
            CheckpointType.MANDATORY,
        ),
        (1, "10:00", "List of required documents", MilestoneKind.OTHER, CheckpointType.NONE),
        (
            3,
            "14:00",
            "Complete file check",
            MilestoneKind.OTHER,
            CheckpointType.OPTIONAL,
        ),
        (
            5,
            "09:00",
            "Consulate appointment booking",
            MilestoneKind.OTHER,
            CheckpointType.MANDATORY,
        ),
        (
            10,
            "08:00",
            "File submission at the consulate",
            MilestoneKind.MEETING,
            CheckpointType.MANDATORY,
        ),
        (14, "10:00", "Application follow-up", MilestoneKind.OTHER, CheckpointType.OPTIONAL),
    ],
    "Hajj 2027 — draft": [
        (
            0,
            "05:00",
            "Meeting at Oran airport",
            MilestoneKind.MEETING,
            CheckpointType.MANDATORY,
        ),
        (0, "08:00", "Flight Oran — Jeddah", MilestoneKind.FLIGHT, CheckpointType.NONE),
        (
            0,
            "17:00",
            "Hotel check-in in Makkah",
            MilestoneKind.HOTEL,
            CheckpointType.NONE,
        ),
        (2, "04:00", "Hajj — Ihram and Tawaf", MilestoneKind.RITUAL, CheckpointType.OPTIONAL),
        (3, "06:00", "Day in Mina", MilestoneKind.RITUAL, CheckpointType.MANDATORY),
        (5, "09:00", "Departure for Madinah", MilestoneKind.TRANSPORT, CheckpointType.MANDATORY),
        (7, "10:00", "Ziyara of the holy sites", MilestoneKind.ZIYARA, CheckpointType.OPTIONAL),
        (10, "14:00", "Return flight Jeddah — Oran", MilestoneKind.FLIGHT, CheckpointType.NONE),
    ],
    "Omra Chaabane — 12 days": [
        (0, "05:30", "Meeting at Algiers airport", MilestoneKind.MEETING, CheckpointType.MANDATORY),
        (0, "08:00", "Flight Algiers — Jeddah", MilestoneKind.FLIGHT, CheckpointType.NONE),
        (0, "17:00", "Hotel check-in in Makkah", MilestoneKind.HOTEL, CheckpointType.NONE),
        (1, "04:00", "Umrah — Tawaf and Sa'i", MilestoneKind.RITUAL, CheckpointType.OPTIONAL),
        (6, "08:00", "Departure for Madinah", MilestoneKind.TRANSPORT, CheckpointType.MANDATORY),
        (7, "10:00", "Ziyara of the holy sites", MilestoneKind.ZIYARA, CheckpointType.OPTIONAL),
        (11, "15:00", "Return flight Jeddah — Algiers", MilestoneKind.FLIGHT, CheckpointType.NONE),
    ],
    "Omra express — 10 days": [
        (0, "04:30", "Meeting at Oran airport", MilestoneKind.MEETING, CheckpointType.MANDATORY),
        (0, "07:00", "Flight Oran — Jeddah", MilestoneKind.FLIGHT, CheckpointType.NONE),
        (0, "16:00", "Hotel check-in in Makkah", MilestoneKind.HOTEL, CheckpointType.NONE),
        (1, "04:30", "Umrah — Tawaf and Sa'i", MilestoneKind.RITUAL, CheckpointType.OPTIONAL),
        (5, "08:00", "Departure for Madinah", MilestoneKind.TRANSPORT, CheckpointType.MANDATORY),
        (9, "13:00", "Return flight Jeddah — Oran", MilestoneKind.FLIGHT, CheckpointType.NONE),
    ],
    "Hajj 2027 — 20 days": [
        (0, "05:00", "Meeting at Algiers airport", MilestoneKind.MEETING, CheckpointType.MANDATORY),
        (0, "08:00", "Flight Algiers — Jeddah", MilestoneKind.FLIGHT, CheckpointType.NONE),
        (0, "18:00", "Hotel check-in in Makkah", MilestoneKind.HOTEL, CheckpointType.NONE),
        (2, "04:00", "Hajj — Ihram and Tawaf", MilestoneKind.RITUAL, CheckpointType.OPTIONAL),
        (3, "06:00", "Day in Mina", MilestoneKind.RITUAL, CheckpointType.MANDATORY),
        (8, "09:00", "Departure for Madinah", MilestoneKind.TRANSPORT, CheckpointType.MANDATORY),
        (12, "10:00", "Ziyara of the holy sites", MilestoneKind.ZIYARA, CheckpointType.OPTIONAL),
        (19, "14:00", "Return flight Jeddah — Algiers", MilestoneKind.FLIGHT, CheckpointType.NONE),
    ],
    "Marrakech — 6 nights": [
        (0, "06:00", "Meeting at Oran airport", MilestoneKind.MEETING, CheckpointType.MANDATORY),
        (0, "09:00", "Flight Oran — Marrakech", MilestoneKind.FLIGHT, CheckpointType.NONE),
        (0, "15:00", "Riad check-in and free evening", MilestoneKind.HOTEL, CheckpointType.NONE),
        (1, "09:00", "Guided tour of the medina", MilestoneKind.OTHER, CheckpointType.OPTIONAL),
        (
            3,
            "08:00",
            "Day trip to the Atlas mountains",
            MilestoneKind.OTHER,
            CheckpointType.OPTIONAL,
        ),
        (6, "11:00", "Return flight Marrakech — Oran", MilestoneKind.FLIGHT, CheckpointType.NONE),
    ],
    "Djerba — 7 nights all inclusive": [
        (0, "06:00", "Meeting at Algiers airport", MilestoneKind.MEETING, CheckpointType.MANDATORY),
        (0, "09:00", "Flight Algiers — Djerba", MilestoneKind.FLIGHT, CheckpointType.NONE),
        (0, "14:00", "Beach hotel check-in", MilestoneKind.HOTEL, CheckpointType.NONE),
        (1, "10:00", "Breakfast and beach day", MilestoneKind.MEAL, CheckpointType.OPTIONAL),
        (3, "09:00", "Houmt Souk market visit", MilestoneKind.OTHER, CheckpointType.OPTIONAL),
        (5, "10:00", "Free day and water sports", MilestoneKind.FREE_TIME, CheckpointType.OPTIONAL),
        (7, "12:00", "Return flight Djerba — Algiers", MilestoneKind.FLIGHT, CheckpointType.NONE),
    ],
    "France visa assistance": [
        (
            0,
            "09:00",
            "File review and first contact",
            MilestoneKind.MEETING,
            CheckpointType.MANDATORY,
        ),
        (1, "10:00", "Documents checklist", MilestoneKind.OTHER, CheckpointType.NONE),
        (3, "14:00", "Complete file check", MilestoneKind.OTHER, CheckpointType.OPTIONAL),
        (5, "09:00", "Visa appointment booking", MilestoneKind.OTHER, CheckpointType.MANDATORY),
        (
            10,
            "08:00",
            "Submission at the consulate",
            MilestoneKind.MEETING,
            CheckpointType.MANDATORY,
        ),
        (14, "10:00", "Application follow-up", MilestoneKind.OTHER, CheckpointType.OPTIONAL),
    ],
}


def seed_consent(lead):
    """What `Lead.record_consent()` writes, minus the request.

    Not called through the API on purpose — a seed that drives the endpoint it
    is seeding for turns every fixture into an integration test that fails for
    unrelated reasons. But the *shape* has to match, or the preview database
    misrepresents what production rows look like.
    """
    lead.consent_given_at = timezone.now()
    lead.consent_text_version = CONSENT_TEXT_VERSION
    # A hash of an invented IP. Never a real one — see rule 4.
    lead.consent_ip_hash = "seed" + "0" * 60
    lead.consent_user_agent = "seed_preview"
    return lead


class Command(BaseCommand):
    help = "Seed two agencies, their offers, leads, a programme and a manifest."

    @transaction.atomic
    def handle(self, *args, **options):
        # This command's first act is to delete every agency, offer, lead and
        # reservation in the database. That is fine on a laptop and a disaster
        # anywhere else, and the two are one `DJANGO_SETTINGS_MODULE` apart —
        # so refuse rather than trust whoever typed it.
        if not settings.DEBUG:
            raise CommandError(
                "seed_preview wipes the database and only runs with DEBUG=1. "
                "Set DJANGO_DEBUG=1 if this really is a local machine."
            )

        # Order matters: children before parents, or a protected FK refuses.
        # `Reservation.offer` is PROTECT precisely so that deleting a departure
        # someone booked is a decision, not an accident.
        Review.objects.all().delete()
        Reservation.objects.all().delete()
        LeadActivity.objects.all().delete()
        Lead.objects.all().delete()
        # Cascades to ClientNote / ClientTag. Deleting clients before tags means
        # the shared Tag vocabulary is left for the delete below.
        Client.objects.all().delete()
        Tag.objects.all().delete()
        TrackedLink.objects.all().delete()
        OfferMilestone.objects.all().delete()
        Offer.objects.all().delete()
        Membership.objects.all().delete()
        Agency.objects.all().delete()
        User.objects.filter(is_superuser=False).delete()

        alger = Agency.objects.create(
            slug="dar-essalam",
            name="Dar Essalam Voyages",
            city="Algiers",
            wilaya_code="16",
            # `status`, not `is_verified` — the latter is a property computed
            # from this field. Setting the status is also what makes these
            # offers visible at all: `publicly_visible()` filters on it.
            status=Agency.VERIFIED,
            decision_note="Verified in the demo data.",
            decided_at=timezone.now(),
        )
        oran = Agency.objects.create(
            slug="wahran-tours",
            name="Wahran Tours",
            city="Oran",
            wilaya_code="31",
            status=Agency.VERIFIED,
            decision_note="Verified in the demo data.",
            decided_at=timezone.now(),
        )
        # One agency still waiting, so the verification queue is not empty and
        # the "unverified offers are invisible" rule is visible in the preview.
        Agency.objects.create(
            slug="sahara-evasion",
            name="Sahara Escape",
            city="Ghardaïa",
            wilaya_code="47",
            status=Agency.PENDING,
            submitted_for_review_at=timezone.now(),
        )

        for agency, username in ((alger, "amina"), (oran, "karim")):
            user = User.objects.create_user(username=username, password=PASSWORD)
            Membership.objects.create(user=user, agency=agency, role=Membership.OWNER)

        omra = Offer.objects.create(
            agency=alger,
            title_fr="Omra Ramadan — 15 days",
            cover_image_url=PHOTOS["omra"],
            title_ar="عمرة رمضان — ١٥ يوم",
            kind=Offer.OMRA,
            description=(
                "Guided Omra during Ramadan: 10 nights in Makkah and 3 in Madinah, ten "
                "minutes from both sanctuaries. Flight, visa and transfers included."
            ),
            price_centimes=42_000_000,  # 420 000,00 DZD
            departure_date=date.today() + timedelta(days=60),
            departure_wilaya_code="16",
            destination_country="Saudi Arabia",
            destination_city="Makkah",
            seats_total=40,
            seats_left=12,
            # Keys the assistant is allowed to read (apps/chat/context.py).
            # Seeded because a demo whose bot cannot answer "is the visa
            # included?" makes the feature look broken.
            attributes={
                "visa_included": True,
                "flight_included": True,
                "transport_included": True,
                "hotel_stars": 4,
                "nights_makkah": 10,
                "nights_madinah": 3,
                "makkah_hotel_distance_m": 600,
                "madinah_hotel_distance_m": 400,
                "meal_plan": "Half board",
                "room_type": "Triple room",
                "ziyarat_included": True,
            },
            status=Offer.PUBLISHED,
        )
        istanbul = Offer.objects.create(
            agency=oran,
            title_fr="Istanbul — 7 nights, flight included",
            cover_image_url=PHOTOS["istanbul"],
            title_ar="إسطنبول — ٧ ليالٍ، الرحلة مشمولة",
            kind=Offer.TRIP,
            description=(
                "Seven nights in Istanbul in a 4-star hotel with breakfast, including a "
                "return flight from Oran and airport transfer."
            ),
            price_centimes=13_500_000,
            departure_date=date.today() + timedelta(days=30),
            departure_wilaya_code="31",
            destination_country="Türkiye",
            destination_city="Istanbul",
            seats_total=25,
            seats_left=25,
            attributes={
                "visa_included": False,
                "flight_included": True,
                "transport_included": True,
                "hotel_stars": 4,
                "nights": 7,
                "meal_plan": "Breakfast",
                "room_type": "Double room",
                "beachfront": False,
                "excursions_included": False,
            },
            status=Offer.PUBLISHED,
        )
        hajj = Offer.objects.create(
            agency=oran,
            title_fr="Hajj 2027 — draft",
            cover_image_url=PHOTOS["hajj"],
            title_ar="حج ٢٠٢٧ — مسودة",
            kind=Offer.HAJJ,
            price_centimes=90_000_000,
            departure_date=date.today() + timedelta(days=300),
            seats_total=20,
            seats_left=20,
            status=Offer.DRAFT,  # invisible to travelers
        )
        tunis = Offer.objects.create(
            agency=alger,
            title_fr="Tunisia — 5 nights by the sea",
            cover_image_url=PHOTOS["tunis"],
            title_ar="تونس — ٥ ليالٍ على شاطئ البحر",
            kind=Offer.TRIP,
            description=(
                "Five nights in Hammamet in a seafront 4-star hotel, half board. "
                "Departure from Algiers, transport included."
            ),
            price_centimes=7_900_000,
            departure_date=date.today() + timedelta(days=21),
            departure_wilaya_code="16",
            destination_country="Tunisia",
            destination_city="Hammamet",
            seats_total=30,
            seats_left=4,
            attributes={
                "visa_included": False,
                "flight_included": False,
                "transport_included": True,
                "hotel_stars": 4,
                "nights": 5,
                "meal_plan": "Half board",
                "room_type": "Double room",
                "beachfront": True,
                "excursions_included": False,
            },
            status=Offer.PUBLISHED,
        )
        visa = Offer.objects.create(
            agency=alger,
            title_fr="Schengen visa assistance",
            cover_image_url=PHOTOS["visa"],
            title_ar="مساعدة في تأشيرة شنغن",
            kind=Offer.VISA,
            description=(
                "Consulate appointment booking, file review and travel insurance for a "
                "Schengen visa application."
            ),
            price_centimes=1_200_000,
            departure_date=date.today() + timedelta(days=14),
            seats_total=100,
            seats_left=87,
            attributes={
                "visa_type": "Schengen short stay",
                "processing_days": 21,
                "appointment_included": True,
                "insurance_included": True,
            },
            status=Offer.PUBLISHED,
        )

        # --- the wider catalogue -------------------------------------------
        # These are the listings the discovery chat has to choose between. One
        # offer per common request (Omra, Hajj, beach, city break, visa) and a
        # second departure city for Omra, so "from Oran" and "cheaper" produce
        # different answers instead of the same singleton.
        omra_chaabane = Offer.objects.create(
            agency=alger,
            title_fr="Omra Chaabane — 12 days",
            cover_image_url=PHOTOS["omra"],
            title_ar="عمرة شعبان — ١٢ يوم",
            kind=Offer.OMRA,
            description=(
                "Twelve-day Omra with seven nights in Makkah and three in Madinah, "
                "four-star hotels within walking distance of the sanctuaries. Visa, "
                "flight and transfers included."
            ),
            price_centimes=38_500_000,
            departure_date=date.today() + timedelta(days=45),
            return_date=date.today() + timedelta(days=57),
            departure_wilaya_code="16",
            destination_country="Saudi Arabia",
            destination_city="Makkah",
            seats_total=40,
            seats_left=18,
            attributes={
                "visa_included": True,
                "flight_included": True,
                "transport_included": True,
                "hotel_stars": 4,
                "nights_makkah": 7,
                "nights_madinah": 3,
                "meal_plan": "Half board",
                "room_type": "Double room",
                "ziyarat_included": True,
            },
            status=Offer.PUBLISHED,
        )
        omra_express = Offer.objects.create(
            agency=oran,
            title_fr="Omra express — 10 days",
            cover_image_url=PHOTOS["omra"],
            title_ar="عمرة سريعة — ١٠ أيام",
            kind=Offer.OMRA,
            description=(
                "A shorter Omra from Oran for travellers with limited leave: six nights "
                "in Makkah, three in Madinah, visa and return flight included."
            ),
            price_centimes=34_000_000,
            departure_date=date.today() + timedelta(days=30),
            return_date=date.today() + timedelta(days=40),
            departure_wilaya_code="31",
            destination_country="Saudi Arabia",
            destination_city="Makkah",
            seats_total=35,
            seats_left=9,
            attributes={
                "visa_included": True,
                "flight_included": True,
                "transport_included": True,
                "hotel_stars": 3,
                "nights_makkah": 6,
                "nights_madinah": 3,
                "meal_plan": "Breakfast",
                "room_type": "Triple room",
                "ziyarat_included": True,
            },
            status=Offer.PUBLISHED,
        )
        hajj_long = Offer.objects.create(
            agency=alger,
            title_fr="Hajj 2027 — 20 days",
            cover_image_url=PHOTOS["hajj"],
            title_ar="حج ٢٠٢٧ — ٢٠ يوم",
            kind=Offer.HAJJ,
            description=(
                "Twenty-day Hajj package with full guidance, Mina tents, Makkah and "
                "Madinah hotels, visa, flights and all transfers included."
            ),
            price_centimes=95_000_000,
            departure_date=date.today() + timedelta(days=280),
            return_date=date.today() + timedelta(days=300),
            departure_wilaya_code="16",
            destination_country="Saudi Arabia",
            destination_city="Makkah",
            seats_total=25,
            seats_left=14,
            attributes={
                "visa_included": True,
                "flight_included": True,
                "transport_included": True,
                "hotel_stars": 4,
                "nights_makkah": 12,
                "nights_madinah": 6,
                "meal_plan": "Full board",
                "room_type": "Quad room",
                "ziyarat_included": True,
            },
            status=Offer.PUBLISHED,
        )
        marrakech = Offer.objects.create(
            agency=oran,
            title_fr="Marrakech — 6 nights",
            cover_image_url=PHOTOS["marrakech"],
            title_ar="مراكش — ٦ ليالٍ",
            kind=Offer.TRIP,
            description=(
                "Six nights in a traditional riad in the medina, with a guided tour, "
                "a day in the Atlas mountains and return flights from Oran."
            ),
            price_centimes=11_200_000,
            departure_date=date.today() + timedelta(days=25),
            return_date=date.today() + timedelta(days=31),
            departure_wilaya_code="31",
            destination_country="Morocco",
            destination_city="Marrakech",
            seats_total=20,
            seats_left=11,
            attributes={
                "visa_included": False,
                "flight_included": True,
                "transport_included": True,
                "hotel_stars": 4,
                "nights": 6,
                "meal_plan": "Breakfast",
                "room_type": "Double room",
                "beachfront": False,
                "excursions_included": True,
            },
            status=Offer.PUBLISHED,
        )
        djerba = Offer.objects.create(
            agency=alger,
            title_fr="Djerba — 7 nights all inclusive",
            cover_image_url=PHOTOS["djerba"],
            title_ar="جربة — ٧ ليالٍ شاملة",
            kind=Offer.TRIP,
            description=(
                "Seven nights all inclusive in a beachfront hotel in Djerba, with return "
                "flights from Algiers, transfers and meals included."
            ),
            price_centimes=9_800_000,
            departure_date=date.today() + timedelta(days=18),
            return_date=date.today() + timedelta(days=25),
            departure_wilaya_code="16",
            destination_country="Tunisia",
            destination_city="Djerba",
            seats_total=40,
            seats_left=22,
            attributes={
                "visa_included": False,
                "flight_included": True,
                "transport_included": True,
                "hotel_stars": 4,
                "nights": 7,
                "meal_plan": "All inclusive",
                "room_type": "Double room",
                "beachfront": True,
                "excursions_included": False,
            },
            status=Offer.PUBLISHED,
        )
        france_visa = Offer.objects.create(
            agency=oran,
            title_fr="France visa assistance",
            cover_image_url=PHOTOS["paris"],
            title_ar="مساعدة في تأشيرة فرنسا",
            kind=Offer.VISA,
            description=(
                "France Schengen visa support from Oran: document checklist, file review, "
                "appointment booking and travel insurance."
            ),
            price_centimes=1_800_000,
            departure_date=date.today() + timedelta(days=10),
            departure_wilaya_code="31",
            destination_country="France",
            destination_city="Paris",
            seats_total=80,
            seats_left=64,
            attributes={
                "visa_type": "Schengen short stay",
                "processing_days": 15,
                "appointment_included": True,
                "insurance_included": True,
            },
            status=Offer.PUBLISHED,
        )

        catalogue = [
            omra,
            istanbul,
            hajj,
            tunis,
            visa,
            omra_chaabane,
            omra_express,
            hajj_long,
            marrakech,
            djerba,
            france_visa,
        ]

        # --- a programme for every listing, not just the Omra one ----------
        # A listing without an itinerary is the empty-page problem this seed
        # exists to prevent: the Trip Programme page, the public "you are here"
        # marker and the quality score all read these rows.
        for offer in catalogue:
            for order, (day, hour, title, kind, checkpoint) in enumerate(
                PROGRAMMES[offer.title_fr]
            ):
                OfferMilestone.objects.create(
                    agency=offer.agency,
                    offer=offer,
                    title=title,
                    kind=kind,
                    day_offset=day,
                    time_of_day=hour,
                    sort_order=order,
                    checkpoint_type=checkpoint,
                )

        # --- tracked links, the "which Facebook post worked?" feature -----
        # `code` is passed explicitly because TrackedLink does NOT fill it in
        # `save()` — unlike Reservation.public_code, which does. Omitting it
        # writes an empty string, and the second link then dies on the unique
        # constraint. Worth knowing: the inconsistency is in the model, and the
        # caller is what remembers.
        facebook = TrackedLink.objects.create(
            agency=oran,
            offer=istanbul,
            label="Facebook post — 12 March",
            code=TrackedLink.new_code(),
            click_count=214,
        )
        TrackedLink.objects.create(
            agency=alger,
            offer=omra,
            label="Instagram story — Ramadan",
            code=TrackedLink.new_code(),
            click_count=87,
        )

        # --- CRM: tags, then leads that each carry consent ----------------
        vip = Tag.objects.create(agency=alger, name="VIP", colour="#b45309")
        Tag.objects.create(agency=alger, name="Call back", colour="#0369a1")
        Tag.objects.create(agency=oran, name="Group", colour="#15803d")

        seeded_leads = [
            (istanbul, "Traveler One", "+213555000001", "Is the visa included?", Lead.NEW, None),
            (
                istanbul,
                "Traveler Two",
                "+213661000002",
                "Can it depart from Oran?",
                Lead.CONTACTED,
                facebook,
            ),
            (tunis, "Traveler Three", "+213770000003", "Family room?", Lead.NEW, None),
            # BOOKED, not WON — the stage vocabulary is new/contacted/quoted/
            # negotiating/booked/travelled/lost. There is no "won".
            (tunis, "Traveler Four", "+213555000004", "", Lead.BOOKED, None),
            (
                omra,
                "Traveler Five",
                "+213555000005",
                "Hotel close to the Haram?",
                Lead.QUOTED,
                None,
            ),
        ]
        leads = []
        for offer, name, phone, msg, status, link in seeded_leads:
            lead = Lead(
                agency=offer.agency,
                offer=offer,
                client=client_for_contact(agency=offer.agency, full_name=name, phone_e164=phone),
                full_name=name,
                phone_e164=phone,
                message=msg,
                status=status,
                source=Lead.Source.TRACKED_LINK if link else Lead.Source.MARKETPLACE,
                tracked_link=link,
            )
            seed_consent(lead)
            lead.save()
            LeadActivity.objects.create(
                agency=lead.agency, lead=lead, verb="created", detail={"source": lead.source}
            )
            leads.append(lead)

        leads[3].lead_tags.create(agency=alger, tag=vip)
        TrackedLink.objects.filter(pk=facebook.pk).update(lead_count=1)

        # --- the manifest: who is actually going --------------------------
        booked = leads[3]
        Reservation.objects.create(
            agency=alger,
            offer=tunis,
            lead=booked,
            client=booked.client,
            full_name=booked.full_name,
            phone_e164=booked.phone_e164,
            party_size=4,
            note="Two young children.",
        )
        Reservation.objects.create(
            agency=alger,
            offer=omra,
            client=client_for_contact(
                agency=alger, full_name=booked.full_name, phone_e164=booked.phone_e164
            ),
            full_name=booked.full_name,
            phone_e164=booked.phone_e164,
            party_size=2,
            note="Second trip for the same family.",
        )
        Reservation.objects.create(
            agency=alger,
            offer=tunis,
            client=client_for_contact(
                agency=alger, full_name="Traveler Six", phone_e164="+213555000006"
            ),
            full_name="Traveler Six",
            phone_e164="+213555000006",
            party_size=2,
            status=AttendanceStatus.CHECKED_IN,
        )
        Reservation.objects.create(
            agency=alger,
            offer=omra,
            client=client_for_contact(
                agency=alger, full_name="Traveler Seven", phone_e164="+213555000007"
            ),
            full_name="Traveler Seven",
            phone_e164="+213555000007",
            party_size=1,
        )

        # A little client-side memory, so the new page is not a list of names
        # with empty sections. The phone numbers are invented.
        vip_client = booked.client
        vip_client.client_tags.create(agency=alger, tag=vip)
        ClientNote.objects.create(
            agency=alger,
            client=vip_client,
            author=None,
            body="Prefers an evening call. Two young children.",
        )

        # --- one review, so the rating is not a placeholder ---------------
        travelled = Lead.objects.create(
            agency=alger,
            offer=tunis,
            client=client_for_contact(
                agency=alger, full_name="Traveler Eight", phone_e164="+213555000008"
            ),
            full_name="Traveler Eight",
            phone_e164="+213555000008",
            status=Lead.TRAVELLED,
        )
        seed_consent(travelled)
        travelled.save()
        Review.objects.create(
            agency=alger,
            lead=travelled,
            author_name="Traveler Eight",
            rating=5,
            comment="Impeccable organisation, a very helpful guide.",
        )
        alger.recompute_rating()

        # `verbosity=0` is what the test suite passes. Ignoring it puts six
        # copies of this banner between a reviewer and the one failure they
        # were looking at, and a noisy build is a build people stop reading.
        if options["verbosity"]:
            self.stdout.write(
                self.style.SUCCESS(
                    "Seeded. Logins: amina (Dar Essalam) / karim (Wahran Tours), "
                    f"password {PASSWORD!r}.\n"
                    "One agency (Sahara Escape) is left pending, so /admin/ has a "
                    "verification queue to work through."
                )
            )
