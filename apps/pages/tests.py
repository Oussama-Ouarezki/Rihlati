"""The HTML pages get the same tenant-isolation treatment as the API.

Two entry points into the same models means two places to get authorization
wrong — so both are tested, not just the JSON one.
"""

from datetime import date, timedelta

from django.test import TestCase, override_settings
from django.urls import reverse
from django.utils import timezone

from apps.accounts.models import Agency, AuditLog, Membership
from apps.chat.models import MAX_FAQS, AgencyAssistant, AgencyFaq, OfferAssistant
from apps.common.testing import (
    make_agency,
    make_client,
    make_lead,
    make_milestone,
    make_offer,
    make_reservation,
    make_user,
)
from apps.leads.models import Client, Lead, Tag
from apps.offers.models import CheckpointType, MilestoneKind, Offer, OfferMilestone, TrackedLink
from apps.pages.templatetags.programme import KIND_EMOJI
from apps.trips.models import Reservation


class PageTenantIsolationTests(TestCase):
    def setUp(self):
        self.a = make_agency("A", slug="a")
        self.b = make_agency("B", slug="b", city="Oran")
        # MANAGER: creating an offer through the form needs it, and an AGENT
        # would fail these for the wrong reason.
        self.user_b = make_user("b", self.b, role=Membership.MANAGER)
        self.offer_a = make_offer(self.a)
        self.lead_a = make_lead(self.a, self.offer_a)

    def test_dashboard_requires_login(self):
        res = self.client.get(reverse("dashboard"))
        self.assertEqual(res.status_code, 302)
        self.assertIn("/login/", res["Location"])

    def test_member_cannot_open_another_agencys_dashboard(self):
        self.client.force_login(self.user_b)
        res = self.client.get(reverse("agency-offers", args=[self.a.id]))
        self.assertEqual(res.status_code, 404)

    def test_member_cannot_edit_another_agencys_offer(self):
        """A's offer id under B's own agency path — scoped queryset, so 404."""
        self.client.force_login(self.user_b)
        res = self.client.get(reverse("agency-offer-edit", args=[self.b.id, self.offer_a.id]))
        self.assertEqual(res.status_code, 404)

    def test_member_cannot_move_another_agencys_lead(self):
        self.client.force_login(self.user_b)
        res = self.client.post(
            reverse("agency-lead-status", args=[self.b.id, self.lead_a.id]),
            {"status": Lead.BOOKED},
        )
        self.assertEqual(res.status_code, 404)
        self.lead_a.refresh_from_db()
        self.assertEqual(self.lead_a.status, Lead.NEW)

    def test_created_offer_belongs_to_the_url_agency(self):
        self.client.force_login(self.user_b)
        res = self.client.post(
            reverse("agency-offer-new", args=[self.b.id]),
            {
                "title_fr": "Nouvelle",
                "title_ar": "جديد",
                "kind": Offer.TRIP,
                "price_dzd": 120000,
                "departure_date": (date.today() + timedelta(days=9)).isoformat(),
                "seats_total": 10,
                "seats_left": 10,
                "status": Offer.DRAFT,
            },
        )
        self.assertEqual(res.status_code, 302)
        created = Offer.objects.get(title_fr="Nouvelle")
        self.assertEqual(created.agency, self.b)
        # Dinars in, centimes stored. No float anywhere in between.
        self.assertEqual(created.price_centimes, 12_000_000)


class PublicPageTests(TestCase):
    def setUp(self):
        self.verified = make_agency("V", slug="v")
        self.unverified = make_agency("U", slug="u", city="Blida", verified=False)
        self.visible = make_offer(self.verified, title_fr="Visible")
        self.draft = make_offer(self.verified, title_fr="Brouillon", status=Offer.DRAFT)
        self.hidden = make_offer(self.unverified, title_fr="NonVerifiee")

    def test_search_lists_only_public_offers(self):
        res = self.client.get(reverse("search"))
        self.assertContains(res, "Visible")
        self.assertNotContains(res, "Brouillon")
        self.assertNotContains(res, "NonVerifiee")

    def test_draft_detail_page_is_404(self):
        res = self.client.get(reverse("offer-detail", args=[self.draft.id]))
        self.assertEqual(res.status_code, 404)

    def test_departure_wilaya_filter(self):
        """The search filters on `wilaya`, the departure wilaya code — not on
        `city`, which is the agency's own address and answers a different
        question ("who is selling this?" rather than "where do I leave from?").
        A traveler in Oran cares about the second one."""
        res = self.client.get(reverse("search"), {"wilaya": "31"})
        self.assertNotContains(res, "Visible")

    def test_inquiry_form_creates_lead_for_the_offers_agency(self):
        res = self.client.post(
            reverse("offer-detail", args=[self.visible.id]),
            # `consent` is required by the form, exactly as it is by the JSON
            # API. Without it there is no lead — that is the rule, not a
            # validation detail.
            {
                "full_name": "T",
                "phone_e164": "+213555111222",
                "message": "Bonjour",
                "consent": "on",
            },
            follow=True,
        )
        self.assertEqual(res.status_code, 200)
        self.assertEqual(Lead.objects.get().agency, self.verified)

    def test_bad_phone_is_rejected_by_the_form_too(self):
        self.client.post(
            reverse("offer-detail", args=[self.visible.id]),
            {"full_name": "T", "phone_e164": "0555111222", "consent": "on"},
        )
        self.assertEqual(Lead.objects.count(), 0)

    def test_an_unticked_consent_box_creates_nothing_here_either(self):
        """The same rule at the second door. One entry point enforcing consent
        and the other not is worse than neither, because the leads that arrive
        without a trail are indistinguishable afterwards from the ones with."""
        self.client.post(
            reverse("offer-detail", args=[self.visible.id]),
            {"full_name": "T", "phone_e164": "+213555111222", "message": "Bonjour"},
        )
        self.assertEqual(Lead.objects.count(), 0)


class RoadmapPageTests(TestCase):
    """The in-app map is drawn from one list, so these tests guard the list's
    completeness and the counters that read from it — not the coordinates.
    A roadmap that silently loses a stop is the failure mode that matters."""

    def test_it_renders_for_anyone(self):
        res = self.client.get(reverse("roadmap"))
        self.assertEqual(res.status_code, 200)
        self.assertContains(res, "Pilot-ready")

    def test_every_milestone_is_a_stop_with_a_pin(self):
        res = self.client.get(reverse("roadmap"))
        phases = res.context["phases"]
        self.assertEqual(res.context["total"], 29)
        self.assertEqual(sum(len(phase["stops"]) for phase in phases), 29)
        self.assertTrue(all(stop["emoji"].strip() for phase in phases for stop in phase["stops"]))

    def test_the_header_count_equals_the_stops_marked_done(self):
        res = self.client.get(reverse("roadmap"))
        phases = res.context["phases"]
        self.assertEqual(
            res.context["done"],
            sum(1 for phase in phases for stop in phase["stops"] if stop["status"] == "done"),
        )

    def test_the_footer_links_to_it(self):
        res = self.client.get(reverse("search"))
        self.assertContains(res, reverse("roadmap"))


class ProgrammePageTests(TestCase):
    """The programme, at its three doors: the public offer page, the agency
    editor, and the traveler's own link.

    Each one has a different reader and a different rule about what they may
    see, so each one is asserted separately. A single "does it render" test
    over the editor would have passed while the capability URL leaked the
    manifest.
    """

    def setUp(self):
        self.a = make_agency("A", slug="a")
        self.b = make_agency("B", slug="b", city="Oran")
        self.manager_a = make_user("ma", self.a, role=Membership.MANAGER)
        self.manager_b = make_user("mb", self.b, role=Membership.MANAGER)
        self.offer_a = make_offer(self.a, title_fr="Omra A")
        self.step = make_milestone(
            self.offer_a,
            title="Rassemblement aéroport",
            meeting_point="Terminal 1, porte 3",
            checkpoint_type=CheckpointType.MANDATORY,
        )

    def test_public_offer_page_shows_the_programme(self):
        res = self.client.get(reverse("offer-detail", args=[self.offer_a.id]))
        self.assertContains(res, "Rassemblement aéroport")
        self.assertContains(res, "Terminal 1, porte 3")

    def test_the_programme_is_a_road_with_one_pin_per_step(self):
        """The curve is decoration, but the pins are what `road.js` measures:
        a step without one is a step the road would skip."""
        res = self.client.get(reverse("offer-detail", args=[self.offer_a.id]))
        self.assertContains(res, "data-road")
        self.assertEqual(res.content.count(b"data-road-pin"), self.offer_a.milestones.count())

    def test_the_road_script_is_loaded_on_every_page(self):
        """`base.html` loads it, not the partial: My Trip and the editor get
        the same road without a second include to forget."""
        res = self.client.get(reverse("offer-detail", args=[self.offer_a.id]))
        self.assertContains(res, "road.js")

    def test_every_kind_has_a_pin_emoji(self):
        """Nine kinds today. A tenth without an icon would silently render as
        the fallback pin, and nobody would notice what was missing."""
        self.assertEqual(set(KIND_EMOJI), set(MilestoneKind.values))

    def test_editor_renders(self):
        self.client.force_login(self.manager_a)
        res = self.client.get(reverse("agency-programme", args=[self.a.id, self.offer_a.id]))
        self.assertEqual(res.status_code, 200)
        self.assertContains(res, "Rassemblement aéroport")

    def test_another_agency_cannot_open_the_editor(self):
        self.client.force_login(self.manager_b)
        res = self.client.get(reverse("agency-programme", args=[self.b.id, self.offer_a.id]))
        self.assertEqual(res.status_code, 404)

    def test_another_agency_cannot_delete_a_step(self):
        """The milestone id is real and the agency id in the path is the
        attacker's own. Scoping the *queryset* is what stops this, not the URL
        looking plausible."""
        self.client.force_login(self.manager_b)
        res = self.client.post(
            reverse("agency-milestone-delete", args=[self.b.id, self.offer_a.id, self.step.id])
        )
        self.assertEqual(res.status_code, 404)
        self.assertTrue(OfferMilestone.objects.filter(pk=self.step.pk).exists())

    def test_adding_a_step_attaches_it_to_the_url_agency(self):
        self.client.force_login(self.manager_a)
        res = self.client.post(
            reverse("agency-programme", args=[self.a.id, self.offer_a.id]),
            {
                "title": "Vol Alger — Jeddah",
                "kind": "flight",
                "day_offset": 0,
                "time_of_day": "09:30",
                "checkpoint_type": CheckpointType.NONE,
            },
        )
        self.assertEqual(res.status_code, 302)
        created = OfferMilestone.objects.get(title="Vol Alger — Jeddah")
        self.assertEqual(created.agency, self.a)
        self.assertEqual(created.offer, self.offer_a)

    def test_a_bad_time_is_refused(self):
        """`time_of_day` is a string, so nothing in the database stops "25:70".
        The validator does, at both doors."""
        self.client.force_login(self.manager_a)
        self.client.post(
            reverse("agency-programme", args=[self.a.id, self.offer_a.id]),
            {
                "title": "X",
                "kind": "other",
                "day_offset": 0,
                "time_of_day": "25:70",
                "checkpoint_type": CheckpointType.NONE,
            },
        )
        self.assertFalse(OfferMilestone.objects.filter(title="X").exists())

    def test_copying_a_programme_from_another_agency_copies_nothing(self):
        """Reading a competitor's programme is reading the thing they compete
        on. The source offer is fetched inside the caller's own scope."""
        target = make_offer(self.b, title_fr="Omra B")
        self.client.force_login(self.manager_b)
        res = self.client.post(
            reverse("agency-programme-copy", args=[self.b.id, target.id]),
            {"source_offer_id": str(self.offer_a.id)},
        )
        self.assertEqual(res.status_code, 404)
        self.assertEqual(target.milestones.count(), 0)

    def test_duplicating_a_day_does_not_carry_the_ticks_over(self):
        """A copy is a plan, not something that already happened."""
        self.step.completed_at = timezone.now()
        self.step.save(update_fields=["completed_at"])
        self.client.force_login(self.manager_a)
        self.client.post(
            reverse("agency-day-duplicate", args=[self.a.id, self.offer_a.id]),
            {"day_offset": 0, "to_day_offset": 3},
        )
        copy = self.offer_a.milestones.get(day_offset=3)
        self.assertIsNone(copy.completed_at)


class MyTripPageTests(TestCase):
    """The capability URL. Holding the link *is* the credential, which is only
    acceptable while the page shows nothing the holder does not already know."""

    def setUp(self):
        self.agency = make_agency("A", slug="a")
        self.offer = make_offer(self.agency, title_fr="Omra")
        make_milestone(self.offer, title="Rassemblement", meeting_point="Terminal 1")
        self.mine = make_reservation(self.offer, full_name="Famille Une", note="Note interne")
        self.other = make_reservation(
            self.offer, full_name="Famille Deux", phone_e164="+213555999888"
        )

    def test_the_link_opens_without_a_login(self):
        res = self.client.get(reverse("my-trip", args=[self.mine.public_code]))
        self.assertContains(res, "Famille Une")
        self.assertContains(res, "Rassemblement")

    def test_it_never_shows_the_other_passengers(self):
        res = self.client.get(reverse("my-trip", args=[self.mine.public_code]))
        self.assertNotContains(res, "Famille Deux")
        self.assertNotContains(res, "+213555999888")

    def test_it_is_marked_noindex(self):
        """An indexed capability URL is a published one."""
        res = self.client.get(reverse("my-trip", args=[self.mine.public_code]))
        self.assertContains(res, "noindex")

    def test_a_wrong_code_is_404_not_a_hint(self):
        res = self.client.get(reverse("my-trip", args=["0" * 32]))
        self.assertEqual(res.status_code, 404)

    def test_a_short_code_never_reaches_the_database(self):
        res = self.client.get(reverse("my-trip", args=["abc"]))
        self.assertEqual(res.status_code, 404)


class ManifestPageTests(TestCase):
    def setUp(self):
        self.a = make_agency("A", slug="a")
        self.b = make_agency("B", slug="b", city="Oran")
        self.agent_a = make_user("aa", self.a)
        self.agent_b = make_user("ab", self.b)
        self.offer_a = make_offer(self.a, seats_total=10, seats_left=10)
        self.checkpoint = make_milestone(self.offer_a, checkpoint_type=CheckpointType.MANDATORY)

    def test_manifest_renders_for_a_member(self):
        make_reservation(self.offer_a, full_name="Famille Une")
        self.client.force_login(self.agent_a)
        res = self.client.get(reverse("agency-manifest", args=[self.a.id, self.offer_a.id]))
        self.assertContains(res, "Famille Une")

    def test_another_agency_sees_nothing(self):
        self.client.force_login(self.agent_b)
        res = self.client.get(reverse("agency-manifest", args=[self.b.id, self.offer_a.id]))
        self.assertEqual(res.status_code, 404)

    def test_adding_a_reservation_takes_the_seats(self):
        self.client.force_login(self.agent_a)
        self.client.post(
            reverse("agency-manifest", args=[self.a.id, self.offer_a.id]),
            {"full_name": "Famille", "phone_e164": "+213555111222", "party_size": 4, "note": ""},
        )
        self.offer_a.refresh_from_db()
        self.assertEqual(self.offer_a.seats_left, 6)

    def test_a_party_bigger_than_the_bus_is_refused(self):
        self.client.force_login(self.agent_a)
        self.client.post(
            reverse("agency-manifest", args=[self.a.id, self.offer_a.id]),
            {"full_name": "Groupe", "phone_e164": "+213555111222", "party_size": 40, "note": ""},
        )
        self.assertEqual(Reservation.objects.count(), 0)
        self.offer_a.refresh_from_db()
        self.assertEqual(self.offer_a.seats_left, 10)

    def test_checkpoint_screen_creates_a_row_per_family(self):
        """Rows are made lazily, so a checkpoint invented mid-trip needs no
        backfill and this morning's booking simply appears."""
        make_reservation(self.offer_a, full_name="Famille Une")
        self.client.force_login(self.agent_a)
        res = self.client.get(
            reverse("agency-checkpoint", args=[self.a.id, self.offer_a.id, self.checkpoint.id])
        )
        self.assertContains(res, "Famille Une")
        self.assertEqual(self.checkpoint.check_ins.count(), 1)

    def test_another_agency_cannot_open_the_checkpoint(self):
        self.client.force_login(self.agent_b)
        res = self.client.get(
            reverse("agency-checkpoint", args=[self.b.id, self.offer_a.id, self.checkpoint.id])
        )
        self.assertEqual(res.status_code, 404)


class LeadDetailPageTests(TestCase):
    def setUp(self):
        self.a = make_agency("A", slug="a")
        self.b = make_agency("B", slug="b", city="Oran")
        self.agent_a = make_user("aa", self.a)
        self.agent_b = make_user("ab", self.b)
        self.offer_a = make_offer(self.a)
        self.lead_a = make_lead(self.a, self.offer_a, message="Le visa est-il inclus ?")

    def test_it_renders(self):
        self.client.force_login(self.agent_a)
        res = self.client.get(reverse("agency-lead-detail", args=[self.a.id, self.lead_a.id]))
        self.assertContains(res, "Le visa est-il inclus ?")

    def test_another_agency_gets_404(self):
        self.client.force_login(self.agent_b)
        res = self.client.get(reverse("agency-lead-detail", args=[self.b.id, self.lead_a.id]))
        self.assertEqual(res.status_code, 404)

    def test_a_note_is_recorded_against_the_lead(self):
        self.client.force_login(self.agent_a)
        self.client.post(
            reverse("agency-lead-detail", args=[self.a.id, self.lead_a.id]),
            {"note": "Rappelée, veut partir en famille."},
        )
        self.assertEqual(self.lead_a.notes.count(), 1)
        # And the timeline records that it happened, separately from the note
        # itself — notes are editable, the timeline is not.
        self.assertTrue(self.lead_a.activities.filter(verb="note_added").exists())


class ClientPageTests(TestCase):
    def setUp(self):
        self.a = make_agency("A", slug="a")
        self.b = make_agency("B", slug="b", city="Oran")
        self.agent_a = make_user("aa", self.a)
        self.agent_b = make_user("ab", self.b)
        self.manager_a = make_user("am", self.a, role=Membership.MANAGER)
        self.offer_a = make_offer(self.a, title_fr="Omra Ramadan")
        self.offer_a2 = make_offer(self.a, title_fr="Tunis")

        self.client_a = make_client(self.a, full_name="Fatima Zerrouki", phone_e164="+213555111222")
        self.lead_a = make_lead(
            self.a,
            self.offer_a,
            client=self.client_a,
            full_name="Fatima Zerrouki",
            phone_e164="+213555111222",
            message="Le visa est-il inclus ?",
        )
        self.reservation_a = make_reservation(
            self.offer_a,
            client=self.client_a,
            full_name="Fatima Zerrouki",
            phone_e164="+213555111222",
            party_size=3,
        )
        # A second trip: "répété" means two or more, and this client is the
        # fixture the repeat filter is tested against.
        make_reservation(
            self.offer_a2,
            client=self.client_a,
            full_name="Fatima Zerrouki",
            phone_e164="+213555111222",
            party_size=2,
        )

    def test_the_offers_console_has_buttons_for_both_crm_doors(self):
        """The offers page is where login lands. If the CRM is only in a tab
        strip, it is easy to miss — these are the explicit doors."""
        self.client.force_login(self.agent_a)
        res = self.client.get(reverse("agency-offers", args=[self.a.id]))
        self.assertEqual(res.status_code, 200)
        self.assertContains(res, reverse("agency-leads", args=[self.a.id]))
        self.assertContains(res, reverse("agency-clients", args=[self.a.id]))
        self.assertContains(res, "Clients")

    def test_the_crm_pages_link_to_each_other(self):
        self.client.force_login(self.agent_a)
        leads = self.client.get(reverse("agency-leads", args=[self.a.id]))
        self.assertContains(leads, reverse("agency-clients", args=[self.a.id]))
        clients = self.client.get(reverse("agency-clients", args=[self.a.id]))
        self.assertContains(clients, reverse("agency-leads", args=[self.a.id]))

    def test_the_directory_renders(self):
        self.client.force_login(self.agent_a)
        res = self.client.get(reverse("agency-clients", args=[self.a.id]))
        self.assertEqual(res.status_code, 200)
        self.assertContains(res, "Fatima Zerrouki")
        self.assertContains(res, "Clients")

    def test_a_phone_typed_without_the_country_code_finds_the_client(self):
        self.client.force_login(self.agent_a)
        res = self.client.get(reverse("agency-clients", args=[self.a.id]), {"q": "0555111222"})
        self.assertContains(res, "Fatima Zerrouki")

    def test_the_repeat_filter_excludes_a_client_with_one_trip(self):
        once = make_client(self.a, full_name="One Trip", phone_e164="+213555111333")
        make_reservation(
            self.offer_a,
            client=once,
            full_name="One Trip",
            phone_e164="+213555111333",
            party_size=1,
        )
        self.client.force_login(self.agent_a)
        res = self.client.get(reverse("agency-clients", args=[self.a.id]), {"filter": "repeat"})
        self.assertContains(res, "Fatima Zerrouki")
        self.assertNotContains(res, "One Trip")

    def test_the_detail_page_shows_trips_demands_and_notes(self):
        self.client.force_login(self.agent_a)
        res = self.client.get(reverse("agency-client-detail", args=[self.a.id, self.client_a.id]))
        self.assertEqual(res.status_code, 200)
        self.assertContains(res, "Omra Ramadan")
        self.assertContains(res, "Trips")

    def test_another_agency_gets_404(self):
        self.client.force_login(self.agent_b)
        res = self.client.get(reverse("agency-client-detail", args=[self.b.id, self.client_a.id]))
        self.assertEqual(res.status_code, 404)

    def test_a_client_can_be_added_from_the_directory(self):
        self.client.force_login(self.agent_a)
        res = self.client.post(
            reverse("agency-clients", args=[self.a.id]),
            {
                "full_name": "Mohamed Amrani",
                "phone_e164": "+213661000002",
                "note": "Appelé le matin.",
            },
        )
        self.assertEqual(res.status_code, 302)
        client = Client.objects.get(agency=self.a, phone_e164="+213661000002")
        self.assertEqual(client.notes.count(), 1)

    def test_a_duplicate_phone_does_not_create_a_second_client(self):
        self.client.force_login(self.agent_a)
        before = Client.objects.filter(agency=self.a).count()
        res = self.client.post(
            reverse("agency-clients", args=[self.a.id]),
            {"full_name": "Autre personne", "phone_e164": "+213555111222", "note": ""},
        )
        self.assertEqual(res.status_code, 200)
        self.assertEqual(Client.objects.filter(agency=self.a).count(), before)
        self.assertContains(res, "A client already has this number.")

    def test_a_note_is_recorded_against_the_client(self):
        self.client.force_login(self.agent_a)
        self.client.post(
            reverse("agency-client-detail", args=[self.a.id, self.client_a.id]),
            {"action": "note", "note": "Préfère être appelée le soir."},
        )
        self.assertEqual(self.client_a.notes.count(), 1)

    def test_a_manager_can_edit_the_profile_and_set_tags(self):
        tag = Tag.objects.create(agency=self.a, name="VIP", colour="#b45309")
        self.client.force_login(self.manager_a)
        res = self.client.post(
            reverse("agency-client-detail", args=[self.a.id, self.client_a.id]),
            {
                "action": "profile",
                "full_name": "Fatima Z.",
                "phone_e164": "+213555111222",
                "tags": [str(tag.id)],
            },
        )
        self.assertEqual(res.status_code, 302)
        self.client_a.refresh_from_db()
        self.assertEqual(self.client_a.full_name, "Fatima Z.")
        self.assertTrue(self.client_a.client_tags.filter(tag=tag).exists())

    def test_another_agency_s_tag_cannot_be_attached(self):
        foreign = Tag.objects.create(agency=self.b, name="Interdit", colour="#000000")
        self.client.force_login(self.manager_a)
        self.client.post(
            reverse("agency-client-detail", args=[self.a.id, self.client_a.id]),
            {
                "action": "profile",
                "full_name": "Fatima Z.",
                "phone_e164": "+213555111222",
                "tags": [str(foreign.id)],
            },
        )
        self.assertFalse(self.client_a.client_tags.filter(tag=foreign).exists())


class SettingsAndVerificationPageTests(TestCase):
    def setUp(self):
        self.agency = make_agency("A", slug="a", verified=False)
        self.owner = make_user("owner", self.agency, role=Membership.OWNER)
        self.manager = make_user("manager", self.agency, role=Membership.MANAGER)
        self.staff = make_user("staff", is_staff=True)

    def test_settings_renders_for_a_manager(self):
        self.client.force_login(self.manager)
        res = self.client.get(reverse("agency-settings", args=[self.agency.id]))
        self.assertEqual(res.status_code, 200)

    def test_a_manager_cannot_submit_the_verification_file(self):
        """It is a legal declaration about the company. Hiding the form is UX;
        this 404 is the security."""
        self.client.force_login(self.manager)
        res = self.client.post(
            reverse("agency-settings", args=[self.agency.id]),
            {
                "form": "verification",
                "registre_commerce": "16/00-1234567",
                "nif": "0001",
                "tourism_licence": "",
            },
        )
        self.assertEqual(res.status_code, 404)
        self.agency.refresh_from_db()
        self.assertEqual(self.agency.status, Agency.DRAFT)

    def test_an_owner_can_submit_and_lands_in_the_queue(self):
        self.client.force_login(self.owner)
        self.client.post(
            reverse("agency-settings", args=[self.agency.id]),
            {
                "form": "verification",
                "registre_commerce": "16/00-1234567",
                "nif": "0001",
                "tourism_licence": "",
            },
        )
        self.agency.refresh_from_db()
        self.assertEqual(self.agency.status, Agency.PENDING)
        self.assertIsNotNone(self.agency.submitted_for_review_at)

    def test_the_profile_form_cannot_write_status_or_plan(self):
        """An agency that could POST its own `status` would verify itself. The
        ModelForm writes exactly the fields it lists, and those are not on it."""
        self.client.force_login(self.owner)
        self.client.post(
            reverse("agency-settings", args=[self.agency.id]),
            {
                "name": "Renommée",
                "description": "",
                "city": "Alger",
                "wilaya_code": "16",
                "phone": "",
                "whatsapp": "",
                "email": "",
                "website_url": "",
                "logo_url": "",
                "status": Agency.VERIFIED,
                "plan": Agency.BUSINESS,
            },
        )
        self.agency.refresh_from_db()
        self.assertEqual(self.agency.name, "Renommée")
        self.assertEqual(self.agency.status, Agency.DRAFT)
        self.assertEqual(self.agency.plan, Agency.FREE)

    def test_the_queue_is_refused_to_a_non_staff_user(self):
        self.client.force_login(self.owner)
        self.assertEqual(self.client.get(reverse("verification-queue")).status_code, 404)

    def test_staff_can_verify_but_must_say_what_they_checked(self):
        self.agency.status = Agency.PENDING
        self.agency.submitted_for_review_at = timezone.now()
        self.agency.save()
        self.client.force_login(self.staff)

        # An empty note decides nothing: a badge nobody had to justify is a
        # badge that means nothing six months later.
        self.client.post(
            reverse("verification-queue"),
            {"agency_id": str(self.agency.id), "decision": "approve", "note": ""},
        )
        self.agency.refresh_from_db()
        self.assertEqual(self.agency.status, Agency.PENDING)

        self.client.post(
            reverse("verification-queue"),
            {
                "agency_id": str(self.agency.id),
                "decision": "approve",
                "note": "RC vérifié, licence à jour.",
            },
        )
        self.agency.refresh_from_db()
        self.assertEqual(self.agency.status, Agency.VERIFIED)
        self.assertEqual(self.agency.decided_by, self.staff)

    def test_a_rejection_without_a_reason_is_refused(self):
        """The owner reads it verbatim. "Refusée." with no reason produces a
        support ticket, a resubmission of the same file, and a lost agency."""
        self.agency.status = Agency.PENDING
        self.agency.save()
        self.client.force_login(self.staff)
        self.client.post(
            reverse("verification-queue"),
            {
                "agency_id": str(self.agency.id),
                "decision": "reject",
                "note": "Registre illisible.",
                "rejection_reason": "",
            },
        )
        self.agency.refresh_from_db()
        self.assertEqual(self.agency.status, Agency.PENDING)


class TrackedLinkTests(TestCase):
    """The half of the feature that was missing: the redirect that counts.

    A link an agency can create but nobody can tap is a table, not a feature —
    and the counter is the entire product here, so it is what gets asserted.
    """

    def setUp(self):
        self.agency = make_agency("Campagne", slug="campagne")
        self.other = make_agency("Autre", slug="autre", city="Oran")
        self.offer = make_offer(self.agency, title_fr="Omra")
        self.manager = make_user("mgr", self.agency, role=Membership.MANAGER)
        self.agent = make_user("agt", self.agency, role=Membership.AGENT)
        self.link = TrackedLink.objects.create(
            agency=self.agency, offer=self.offer, label="Post Facebook", code="abc12345"
        )

    def test_tapping_the_link_counts_a_click_and_redirects_to_the_offer(self):
        res = self.client.get(reverse("tracked-link", args=["abc12345"]))
        self.link.refresh_from_db()
        self.assertEqual(self.link.click_count, 1)
        self.assertIn(str(self.offer.id), res["Location"])
        self.assertIn("ref=abc12345", res["Location"])

    def test_the_redirect_is_temporary(self):
        """301 gets cached by the browser, so from the second tap onwards the
        click never reaches the server and the agency thinks the post died."""
        res = self.client.get(reverse("tracked-link", args=["abc12345"]))
        self.assertEqual(res.status_code, 302)

    def test_every_tap_counts_not_just_the_first(self):
        for _ in range(3):
            self.client.get(reverse("tracked-link", args=["abc12345"]))
        self.link.refresh_from_db()
        self.assertEqual(self.link.click_count, 3)

    def test_an_unknown_code_is_a_404(self):
        res = self.client.get(reverse("tracked-link", args=["deadbeef"]))
        self.assertEqual(res.status_code, 404)

    def test_a_link_without_an_offer_lands_on_the_catalogue(self):
        TrackedLink.objects.create(agency=self.agency, label="Page agence", code="nooffer1")
        res = self.client.get(reverse("tracked-link", args=["nooffer1"]))
        self.assertEqual(res["Location"], reverse("search"))

    def test_an_inquiry_carrying_the_ref_is_attributed_and_counted(self):
        res = self.client.post(
            reverse("offer-detail", args=[self.offer.id]),
            {
                "full_name": "Traveler",
                "phone_e164": "+213555000123",
                "message": "",
                "consent": "on",
                "ref": "abc12345",
            },
        )
        self.assertEqual(res.status_code, 302)
        lead = Lead.objects.get()
        self.assertEqual(lead.tracked_link_id, self.link.id)
        self.assertEqual(lead.source, Lead.Source.TRACKED_LINK)
        self.link.refresh_from_db()
        self.assertEqual(self.link.lead_count, 1)

    def test_another_agencys_code_is_ignored_rather_than_credited(self):
        """Otherwise a traveler — or the agency itself — could pad a rival's
        campaign numbers, or steal attribution, by editing one hidden input."""
        theirs = TrackedLink.objects.create(agency=self.other, label="Leur post", code="theirs00")
        self.client.post(
            reverse("offer-detail", args=[self.offer.id]),
            {
                "full_name": "Traveler",
                "phone_e164": "+213555000124",
                "message": "",
                "consent": "on",
                "ref": "theirs00",
            },
        )
        lead = Lead.objects.get()
        self.assertIsNone(lead.tracked_link_id)
        self.assertEqual(lead.source, Lead.Source.MARKETPLACE)
        theirs.refresh_from_db()
        self.assertEqual(theirs.lead_count, 0)

    def test_a_stale_ref_still_lets_the_inquiry_through(self):
        """A shared post outlives the campaign. Losing the attribution is the
        right thing to lose; losing the lead is not."""
        self.client.post(
            reverse("offer-detail", args=[self.offer.id]),
            {
                "full_name": "Traveler",
                "phone_e164": "+213555000125",
                "message": "",
                "consent": "on",
                "ref": "gone0000",
            },
        )
        self.assertEqual(Lead.objects.count(), 1)

    def test_the_console_lists_only_this_agencys_campaigns(self):
        TrackedLink.objects.create(agency=self.other, label="Leur post", code="theirs01")
        self.client.force_login(self.agent)
        res = self.client.get(reverse("agency-links", args=[self.agency.id]))
        self.assertContains(res, "Post Facebook")
        self.assertNotContains(res, "Leur post")

    def test_another_agency_cannot_open_the_console_page(self):
        outsider = make_user("outsider", self.other, role=Membership.OWNER)
        self.client.force_login(outsider)
        res = self.client.get(reverse("agency-links", args=[self.agency.id]))
        self.assertEqual(res.status_code, 404)

    def test_an_agent_cannot_create_a_campaign(self):
        """The tab is visible to them; the POST is not. The template hiding
        the form is UX, this is the security."""
        self.client.force_login(self.agent)
        res = self.client.post(
            reverse("agency-links", args=[self.agency.id]), {"label": "Interdit"}
        )
        self.assertEqual(res.status_code, 404)
        self.assertFalse(TrackedLink.objects.filter(label="Interdit").exists())

    def test_a_manager_creates_a_campaign_with_a_server_generated_code(self):
        self.client.force_login(self.manager)
        self.client.post(
            reverse("agency-links", args=[self.agency.id]),
            {"label": "Story Instagram", "offer": str(self.offer.id)},
        )
        link = TrackedLink.objects.get(label="Story Instagram")
        self.assertEqual(link.agency_id, self.agency.id)
        self.assertNotEqual(link.code, "")
        self.assertNotEqual(link.code, self.link.code)

    def test_a_campaign_cannot_point_at_another_agencys_offer(self):
        """Scoped in the form's queryset, so the id is rejected as invalid
        rather than accepted and quietly attached across tenants."""
        theirs = make_offer(self.other, title_fr="Leur offre")
        self.client.force_login(self.manager)
        self.client.post(
            reverse("agency-links", args=[self.agency.id]),
            {"label": "Vol", "offer": str(theirs.id)},
        )
        self.assertFalse(TrackedLink.objects.filter(label="Vol").exists())


@override_settings(CHAT_ENABLED=True)
class AssistantPageTests(TestCase):
    """The agency's instruction editor and the full-page assistant.

    The editor is manager work; the assistant page is public. They share one
    switch, so both halves are tested against it: an agency that turns the
    assistant off must disappear from the public page and the offer widget,
    not merely stop receiving answers.
    """

    def setUp(self):
        self.agency = make_agency("Assistant SARL")
        self.manager = make_user("manager", self.agency, role=Membership.MANAGER)
        self.agent = make_user("agent", self.agency)
        self.offer = make_offer(self.agency, title_fr="Omra test")

    def settings_url(self):
        return reverse("agency-assistant", args=[self.agency.id])

    def test_the_editor_renders_for_a_manager(self):
        self.client.force_login(self.manager)
        response = self.client.get(self.settings_url())

        self.assertEqual(response.status_code, 200)
        self.assertContains(response, "Agency instructions")
        self.assertContains(response, "Omra test")  # a test link, not an empty page

    def test_an_agent_cannot_open_the_editor(self):
        self.client.force_login(self.agent)
        self.assertEqual(self.client.get(self.settings_url()).status_code, 404)

    def test_a_manager_saves_the_instructions(self):
        self.client.force_login(self.manager)
        response = self.client.post(
            self.settings_url(),
            {
                "is_enabled": "on",
                "instructions": "Acompte de 30 % à la confirmation, solde 7 jours avant.",
            },
        )

        self.assertEqual(response.status_code, 302)
        config = AgencyAssistant.objects.get(agency=self.agency)
        self.assertTrue(config.is_enabled)
        self.assertIn("Acompte de 30 %", config.instructions)

    def test_unchecking_the_box_disables_the_assistant(self):
        self.client.force_login(self.manager)
        self.client.post(self.settings_url(), {"instructions": "Texte conservé."})

        config = AgencyAssistant.objects.get(agency=self.agency)
        self.assertFalse(config.is_enabled)
        self.assertEqual(config.instructions, "Texte conservé.")

    def test_overlong_instructions_are_refused_and_nothing_is_written(self):
        self.client.force_login(self.manager)
        response = self.client.post(
            self.settings_url(), {"is_enabled": "on", "instructions": "x" * 2001}
        )

        self.assertEqual(response.status_code, 200)
        self.assertFalse(AgencyAssistant.objects.filter(agency=self.agency).exists())

    def test_the_editor_renders_global_qa(self):
        self.client.force_login(self.manager)
        response = self.client.get(self.settings_url())

        self.assertContains(response, "Global Q&amp;A")
        self.assertContains(response, "No global answers yet")

    def test_a_manager_adds_a_global_question(self):
        self.client.force_login(self.manager)
        response = self.client.post(
            self.settings_url(),
            {
                "action": "faq_add",
                "question": "What is the deposit?",
                "answer": "A 30% deposit is due on confirmation.",
                "is_active": "on",
            },
        )

        self.assertEqual(response.status_code, 302)
        faq = AgencyFaq.objects.get(agency=self.agency)
        self.assertEqual(faq.question, "What is the deposit?")
        self.assertTrue(faq.is_active)
        self.assertTrue(
            AuditLog.objects.filter(action="assistant.faq_added", agency=self.agency).exists()
        )

    def test_duplicate_global_question_is_refused(self):
        AgencyFaq.objects.create(
            agency=self.agency, question="What is the deposit?", answer="A 30% deposit."
        )
        self.client.force_login(self.manager)
        response = self.client.post(
            self.settings_url(),
            {
                "action": "faq_add",
                "question": "What is the deposit?",
                "answer": "Another answer.",
                "is_active": "on",
            },
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(AgencyFaq.objects.filter(agency=self.agency).count(), 1)

    def test_an_agent_cannot_add_a_global_question(self):
        self.client.force_login(self.agent)
        response = self.client.post(
            self.settings_url(),
            {"action": "faq_add", "question": "Q?", "answer": "A.", "is_active": "on"},
        )

        self.assertEqual(response.status_code, 404)
        self.assertFalse(AgencyFaq.objects.filter(agency=self.agency).exists())

    def test_a_manager_edits_a_global_question(self):
        faq = AgencyFaq.objects.create(
            agency=self.agency, question="Old question?", answer="Old answer."
        )
        self.client.force_login(self.manager)
        response = self.client.post(
            reverse("agency-faq-edit", args=[self.agency.id, faq.id]),
            {"question": "New question?", "answer": "New answer.", "is_active": "on"},
        )

        self.assertEqual(response.status_code, 302)
        faq.refresh_from_db()
        self.assertEqual(faq.question, "New question?")
        self.assertEqual(faq.answer, "New answer.")
        self.assertTrue(
            AuditLog.objects.filter(action="assistant.faq_updated", agency=self.agency).exists()
        )

    def test_a_manager_deletes_a_global_question(self):
        faq = AgencyFaq.objects.create(agency=self.agency, question="Delete me?", answer="Gone.")
        self.client.force_login(self.manager)
        response = self.client.post(reverse("agency-faq-delete", args=[self.agency.id, faq.id]))

        self.assertEqual(response.status_code, 302)
        self.assertFalse(AgencyFaq.objects.filter(pk=faq.pk).exists())
        self.assertTrue(
            AuditLog.objects.filter(action="assistant.faq_deleted", agency=self.agency).exists()
        )

    def test_cannot_edit_or_delete_another_agencys_question(self):
        other = make_agency("Other Assistant SARL", city="Oran")
        faq = AgencyFaq.objects.create(
            agency=other, question="Their question?", answer="Their answer."
        )
        self.client.force_login(self.manager)

        self.assertEqual(
            self.client.get(reverse("agency-faq-edit", args=[self.agency.id, faq.id])).status_code,
            404,
        )
        self.assertEqual(
            self.client.post(
                reverse("agency-faq-delete", args=[self.agency.id, faq.id])
            ).status_code,
            404,
        )

    def test_overlong_faq_answer_is_refused(self):
        self.client.force_login(self.manager)
        response = self.client.post(
            self.settings_url(),
            {
                "action": "faq_add",
                "question": "Question?",
                "answer": "x" * 601,
                "is_active": "on",
            },
        )

        self.assertEqual(response.status_code, 200)
        self.assertFalse(AgencyFaq.objects.filter(agency=self.agency).exists())

    def test_the_faq_cap_is_refused(self):
        AgencyFaq.objects.bulk_create(
            [
                AgencyFaq(agency=self.agency, question=f"Question {i}?", answer="Answer.")
                for i in range(MAX_FAQS)
            ]
        )
        self.client.force_login(self.manager)
        response = self.client.post(
            self.settings_url(),
            {
                "action": "faq_add",
                "question": "One too many?",
                "answer": "No.",
                "is_active": "on",
            },
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(AgencyFaq.objects.filter(agency=self.agency).count(), MAX_FAQS)

    def offer_assistant_url(self, offer=None):
        return reverse(
            "agency-offer-assistant",
            args=[self.agency.id, (offer or self.offer).id],
        )

    def test_a_manager_saves_offer_instructions(self):
        self.client.force_login(self.manager)
        response = self.client.post(
            self.offer_assistant_url(),
            {"instructions": "Airport transfer is included from Constantine."},
        )

        self.assertEqual(response.status_code, 302)
        config = OfferAssistant.objects.get(offer=self.offer)
        self.assertEqual(config.agency, self.agency)
        self.assertIn("Airport transfer", config.instructions)
        self.assertTrue(
            AuditLog.objects.filter(action="offer_assistant.updated", agency=self.agency).exists()
        )

    def test_an_agent_cannot_open_the_offer_assistant_editor(self):
        self.client.force_login(self.agent)
        self.assertEqual(
            self.client.get(self.offer_assistant_url()).status_code,
            404,
        )

    def test_another_agencys_offer_has_no_offer_assistant_editor(self):
        other = make_agency("Other Offer SARL", city="Oran")
        theirs = make_offer(other, title_fr="Leur offre")
        self.client.force_login(self.manager)
        self.assertEqual(
            self.client.get(self.offer_assistant_url(theirs)).status_code,
            404,
        )

    def test_overlong_offer_instructions_are_refused(self):
        self.client.force_login(self.manager)
        response = self.client.post(
            self.offer_assistant_url(),
            {"instructions": "x" * 2001},
        )

        self.assertEqual(response.status_code, 200)
        self.assertFalse(OfferAssistant.objects.filter(offer=self.offer).exists())

    def test_the_full_page_renders_for_a_public_offer(self):
        response = self.client.get(reverse("offer-assistant", args=[self.offer.id]))

        self.assertEqual(response.status_code, 200)
        self.assertContains(response, "Have a question?")
        self.assertContains(response, reverse("api:chat_about_offer", args=[self.offer.id]))

    def test_a_draft_offer_has_no_assistant_page(self):
        draft = make_offer(self.agency, title_fr="Brouillon", status=Offer.DRAFT)
        response = self.client.get(reverse("offer-assistant", args=[draft.id]))
        self.assertEqual(response.status_code, 404)

    def test_a_disabled_agency_has_no_assistant_page(self):
        AgencyAssistant.objects.create(agency=self.agency, is_enabled=False)
        response = self.client.get(reverse("offer-assistant", args=[self.offer.id]))
        self.assertEqual(response.status_code, 404)

    def test_the_offer_widget_links_to_the_full_page(self):
        response = self.client.get(reverse("offer-detail", args=[self.offer.id]))

        self.assertContains(response, "Open the assistant on its own page")
        self.assertContains(response, reverse("offer-assistant", args=[self.offer.id]))

    def test_a_disabled_agency_has_no_widget(self):
        AgencyAssistant.objects.create(agency=self.agency, is_enabled=False)
        response = self.client.get(reverse("offer-detail", args=[self.offer.id]))

        self.assertNotContains(response, "Open the assistant on its own page")
        self.assertNotContains(response, "Have a question?")
