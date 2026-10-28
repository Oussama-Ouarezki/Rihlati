"""The seed command, tested.

Seeds rot in a specific and annoying way: a model changes, `seed_preview`
keeps referring to the old field, and nobody notices until someone clones the
repo, follows the README, and gets a traceback on their first command. By then
the fix is archaeology. This file costs one test and makes that impossible.

It is also the closest thing here to an end-to-end check: the command touches
almost every model, so a broken relation anywhere shows up as a failure here.
"""

from django.core.management import call_command
from django.core.management.base import CommandError
from django.test import TestCase, override_settings

from apps.accounts.models import Agency
from apps.leads.models import Client, Lead
from apps.offers.models import Offer, OfferMilestone
from apps.trips.models import Reservation


# The command refuses to run unless DEBUG is on, because its first act is to
# delete every agency, offer and lead in the database. Django forces DEBUG=False
# during tests, so exercising the destructive path has to be opted into out
# loud. That is the right shape rather than an annoyance: the guard stays
# strict, and the one place allowed past it says so in a decorator nobody can
# miss while reading.
@override_settings(DEBUG=True)
class SeedPreviewTests(TestCase):
    def test_the_seed_command_runs(self):
        call_command("seed_preview", verbosity=0)
        self.assertTrue(Agency.objects.exists())
        self.assertTrue(Offer.objects.exists())
        self.assertTrue(OfferMilestone.objects.exists())
        self.assertTrue(Reservation.objects.exists())

    def test_running_it_twice_is_safe(self):
        """It wipes before it writes. If the delete order is wrong, the second
        run fails on a protected foreign key — and `Reservation.offer` is
        PROTECT on purpose, so this is a live risk rather than a hypothetical."""
        call_command("seed_preview", verbosity=0)
        call_command("seed_preview", verbosity=0)
        self.assertEqual(Agency.objects.count(), 3)

    def test_every_seeded_lead_carries_consent(self):
        """The application refuses to create a lead without consent. A seed
        that creates one anyway produces a database in a state production can
        never reach, and the consent code then gets debugged against a lie."""
        call_command("seed_preview", verbosity=0)
        without = [lead.full_name for lead in Lead.objects.all() if not lead.has_consent]
        self.assertEqual(without, [])

    def test_the_seeded_public_catalogue_is_only_verified_agencies(self):
        call_command("seed_preview", verbosity=0)
        agencies = {offer.agency.status for offer in Offer.publicly_visible()}
        self.assertEqual(agencies, {Agency.VERIFIED})

    def test_a_pending_agency_is_left_in_the_queue(self):
        """So the admin's verification queue is not empty in the preview —
        an empty back office looks like a broken one."""
        call_command("seed_preview", verbosity=0)
        self.assertTrue(Agency.objects.filter(status=Agency.PENDING).exists())

    def test_every_seeded_lead_and_reservation_has_a_client(self):
        """The client page is the demo of the client page. A seed that leaves
        half the history unlinked shows an empty CRM and looks broken."""
        call_command("seed_preview", verbosity=0)
        self.assertEqual(Lead.objects.filter(client__isnull=True).count(), 0)
        self.assertEqual(Reservation.objects.filter(client__isnull=True).count(), 0)
        self.assertTrue(Client.objects.exists())

    def test_the_seed_has_a_repeat_client_and_a_note(self):
        """Otherwise "Repeat" and the chronology are empty in every screenshot,
        which reads as a bug in the filter rather than an empty fixture."""
        from django.db.models import Count

        call_command("seed_preview", verbosity=0)
        self.assertTrue(
            Client.objects.annotate(trips=Count("reservations")).filter(trips__gte=2).exists()
        )
        self.assertTrue(Client.objects.filter(notes__isnull=False).exists())

    def test_every_seeded_offer_has_a_programme(self):
        """A listing with an empty itinerary makes the Trip Programme page,
        the public "you are here" marker and the quality score all look broken
        in the same click. The threshold is the one `compute_quality_score`
        rewards, so a seed that drops below it fails here rather than in a
        screenshot."""
        call_command("seed_preview", verbosity=0)
        thin = [offer.title_fr for offer in Offer.objects.all() if offer.milestones.count() < 3]
        self.assertEqual(thin, [])


class SeedPreviewRefusesOutsideDebugTests(TestCase):
    """Deliberately NOT decorated with `override_settings(DEBUG=True)`.

    The class above opts into the destructive path; this one checks the door is
    still shut for everybody else. Without it, deleting the guard would make
    every other test in this file pass and nothing would notice — which is
    exactly how the guard came to be missing in the first place.
    """

    def test_it_refuses_to_run_when_debug_is_off(self):
        with self.assertRaises(CommandError):
            call_command("seed_preview", verbosity=0)

    def test_it_deletes_nothing_before_refusing(self):
        """The check has to come before the first `.delete()`, not after. A
        guard that fires halfway through is not a guard."""
        Agency.objects.create(name="Wahran Tours", slug="wahran-tours", city="Oran")

        with self.assertRaises(CommandError):
            call_command("seed_preview", verbosity=0)

        self.assertEqual(Agency.objects.count(), 1)
