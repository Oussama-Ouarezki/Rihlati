"""The review queue: who may open it, and what a decision is allowed to omit.

Every other authorization test in this project asks "does this row belong to
your agency". These routes have no agency in the path at all — a reviewer is
*supposed* to reach across every tenant, which is exactly why the gate has to
be somewhere else. It is `require_staff`, and `is_staff` is read from the
database on every request rather than carried in a token, so revoking a
reviewer takes effect on their next call instead of at their next login.

Two rules here are worth more than the status codes:

1. **A reviewer may not decide on their own agency** (`refuse_self_review`).
   The inverse of every other rule in the codebase — membership normally
   *grants* access, and here it removes it. A badge granted by its own owner
   proves nothing to a traveler, which is the badge's only job.
2. **A decision cannot be silent.** The note is mandatory whichever way the
   answer goes, and a refusal additionally needs a reason the owner will read
   verbatim. "Refusée." with no reason produces a support ticket, a
   resubmission of the identical file, and a lost agency.

See [[Agency Verification]].
"""

import json

from django.test import TestCase
from django.utils import timezone

from apps.accounts.models import Agency, AuditLog, Membership
from apps.common.auth import issue_access_token
from apps.common.testing import make_agency, make_user

QUEUE = "/api/admin/verification-queue"


def decision_url(agency):
    return f"/api/admin/agencies/{agency.id}/decision"


def suspend_url(agency):
    return f"/api/admin/agencies/{agency.id}/suspend"


class AdminTestCase(TestCase):
    def auth(self, user):
        return {"HTTP_AUTHORIZATION": f"Bearer {issue_access_token(user)}"} if user else {}

    def get(self, path, user=None):
        return self.client.get(path, **self.auth(user))

    def post(self, path, body, user=None):
        return self.client.post(
            path, data=json.dumps(body), content_type="application/json", **self.auth(user)
        )

    def body(self, response):
        return json.loads(response.content)


class Queue(AdminTestCase):
    """Shared cast: one reviewer, one agency waiting, one already verified."""

    def setUp(self):
        self.reviewer = make_user("nadia", is_staff=True)
        self.pending = make_agency("Voyages Atlas", verified=False)
        self.pending.status = Agency.PENDING
        self.pending.submitted_for_review_at = timezone.now()
        self.pending.save()
        self.verified = make_agency("Voyages Sahara", slug="sahara", verified=True)


class StaffGateTests(Queue):
    def test_an_ordinary_member_cannot_open_the_queue(self):
        """403, not 404. `/api/admin/...` is not a secret path — it is in the
        published OpenAPI schema — so hiding it would protect nothing while
        making a genuine permissions problem look like a broken link."""
        outsider = make_user("karim", self.verified, role=Membership.OWNER)
        for response in (
            self.get(QUEUE, outsider),
            self.post(
                decision_url(self.pending), {"approve": True, "note": "Dossier vu."}, outsider
            ),
            self.post(suspend_url(self.verified), {"approve": False, "note": "Plainte."}, outsider),
        ):
            self.assertEqual(response.status_code, 403)
            self.assertEqual(self.body(response)["code"], "FORBIDDEN")

    def test_a_stranger_gets_401_and_the_agency_is_untouched(self):
        response = self.post(decision_url(self.pending), {"approve": True, "note": "Bonjour."})
        self.assertEqual(response.status_code, 401)
        self.pending.refresh_from_db()
        self.assertEqual(self.pending.status, Agency.PENDING)

    def test_staff_is_read_from_the_database_not_from_the_token(self):
        """The reviewer's token is minted while they are staff, then the flag
        is removed. The very next call with that same still-valid token must
        fail — otherwise revoking a reviewer would not take effect until their
        token expired, which is the whole reason roles are not token claims."""
        token = issue_access_token(self.reviewer)
        self.reviewer.is_staff = False
        self.reviewer.save(update_fields=["is_staff"])
        response = self.client.get(QUEUE, HTTP_AUTHORIZATION=f"Bearer {token}")
        self.assertEqual(response.status_code, 403)


class QueueContentTests(Queue):
    def test_the_queue_holds_only_agencies_that_asked_to_be_reviewed(self):
        response = self.get(QUEUE, self.reviewer)
        self.assertEqual(response.status_code, 200)
        self.assertEqual([a["slug"] for a in self.body(response)], ["voyages-atlas"])

    def test_the_queue_is_oldest_first(self):
        """FIFO is a fairness decision, not an implementation detail. A queue
        sorted any other way quietly means whoever complains loudest — or
        whoever resubmits most often — gets reviewed first."""
        newer = make_agency("Voyages Tassili", slug="tassili", verified=False)
        newer.status = Agency.PENDING
        newer.submitted_for_review_at = timezone.now()
        newer.save()
        Agency.objects.filter(pk=self.pending.pk).update(
            submitted_for_review_at=timezone.now() - timezone.timedelta(days=3)
        )
        slugs = [a["slug"] for a in self.body(self.get(QUEUE, self.reviewer))]
        self.assertEqual(slugs, ["voyages-atlas", "tassili"])


class SelfReviewTests(Queue):
    def test_a_reviewer_cannot_decide_on_an_agency_they_belong_to(self):
        Membership.objects.create(user=self.reviewer, agency=self.pending, role=Membership.OWNER)
        response = self.post(
            decision_url(self.pending), {"approve": True, "note": "Je me vérifie."}, self.reviewer
        )
        self.assertEqual(response.status_code, 403)
        self.pending.refresh_from_db()
        self.assertEqual(self.pending.status, Agency.PENDING)

    def test_the_same_refusal_applies_to_suspension(self):
        """Both directions matter. Being unable to bless your own agency but
        able to suspend a competitor's while sitting on their board would be
        the same conflict of interest wearing the other hat."""
        Membership.objects.create(user=self.reviewer, agency=self.verified, role=Membership.AGENT)
        response = self.post(
            suspend_url(self.verified), {"approve": False, "note": "Concurrent."}, self.reviewer
        )
        self.assertEqual(response.status_code, 403)
        self.verified.refresh_from_db()
        self.assertEqual(self.verified.status, Agency.VERIFIED)

    def test_membership_in_some_other_agency_does_not_block_anything(self):
        """The rule is about *this* agency, not about having a day job."""
        Membership.objects.create(user=self.reviewer, agency=self.verified, role=Membership.AGENT)
        response = self.post(
            decision_url(self.pending),
            {"approve": True, "note": "Registre vérifié."},
            self.reviewer,
        )
        self.assertEqual(response.status_code, 200)


class DecisionTests(Queue):
    def test_approving_records_who_decided_and_when(self):
        response = self.post(
            decision_url(self.pending),
            {"approve": True, "note": "Registre de commerce vérifié, licence à jour."},
            self.reviewer,
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(self.body(response)["status"], Agency.VERIFIED)
        self.pending.refresh_from_db()
        self.assertEqual(self.pending.decided_by, self.reviewer)
        self.assertIsNotNone(self.pending.decided_at)
        self.assertEqual(self.pending.rejection_reason, "")

    def test_the_decision_is_written_to_the_audit_log_with_a_name_on_it(self):
        """Whoever grants a badge is on the record for it, forever. That is
        what makes the badge worth anything to a traveler."""
        self.post(
            decision_url(self.pending),
            {"approve": True, "note": "Documents conformes."},
            self.reviewer,
        )
        row = AuditLog.objects.get(action="agency.verified")
        self.assertEqual(row.actor, self.reviewer)
        self.assertEqual(row.agency_id, self.pending.id)
        self.assertEqual(row.before["status"], Agency.PENDING)
        self.assertEqual(row.after["status"], Agency.VERIFIED)

    def test_a_decision_without_a_note_is_refused_before_the_handler_runs(self):
        """422 — the Pydantic schema rejects it, so `decide()` is never
        entered. Shape failures are caught at the boundary; rule failures
        inside the handler answer 400. Both carry `VALIDATION_FAILED`, which
        is what a client actually branches on."""
        response = self.post(
            decision_url(self.pending), {"approve": True, "note": "ok"}, self.reviewer
        )
        self.assertEqual(response.status_code, 422)
        self.assertEqual(self.body(response)["code"], "VALIDATION_FAILED")
        self.pending.refresh_from_db()
        self.assertEqual(self.pending.status, Agency.PENDING)

    def test_a_refusal_must_say_why(self):
        response = self.post(
            decision_url(self.pending),
            {"approve": False, "note": "Dossier incomplet."},
            self.reviewer,
        )
        self.assertEqual(response.status_code, 422)
        self.pending.refresh_from_db()
        self.assertEqual(self.pending.status, Agency.PENDING)

    def test_a_refusal_with_a_reason_stores_the_text_the_owner_will_read(self):
        response = self.post(
            decision_url(self.pending),
            {
                "approve": False,
                "note": "Registre expiré depuis 2023.",
                "rejection_reason": "Votre registre de commerce a expiré. Envoyez-le à jour.",
            },
            self.reviewer,
        )
        self.assertEqual(response.status_code, 200)
        self.pending.refresh_from_db()
        self.assertEqual(self.pending.status, Agency.REJECTED)
        self.assertIn("expiré", self.pending.rejection_reason)

    def test_deciding_twice_is_a_conflict_not_a_second_decision(self):
        """The legal moves live in one dict on the model
        (`STATUS_TRANSITIONS`), so a second approval is refused by the same
        table that refuses every other impossible move. 409 says "the world
        moved on", which is the honest answer when two reviewers open the same
        row at once."""
        body = {"approve": True, "note": "Documents conformes."}
        self.assertEqual(
            self.post(decision_url(self.pending), body, self.reviewer).status_code, 200
        )
        second = self.post(decision_url(self.pending), body, self.reviewer)
        self.assertEqual(second.status_code, 409)
        self.assertEqual(self.body(second)["code"], "CONFLICT")


class SuspensionTests(Queue):
    def test_suspending_a_verified_agency_pulls_it_out_of_public_view(self):
        response = self.post(
            suspend_url(self.verified),
            {"approve": False, "note": "Plaintes répétées de voyageurs."},
            self.reviewer,
        )
        self.assertEqual(response.status_code, 200)
        self.verified.refresh_from_db()
        self.assertEqual(self.verified.status, Agency.SUSPENDED)
        self.assertFalse(self.verified.is_verified)
        self.assertEqual(self.verified.decided_by, self.reviewer)

    def test_suspension_keeps_the_agency_and_its_history(self):
        """Suspension, not deletion. A suspension is frequently the *start* of
        a dispute, and destroying the leads and the audit trail at exactly that
        moment destroys the evidence both sides need."""
        self.post(
            suspend_url(self.verified),
            {"approve": False, "note": "Enquête en cours."},
            self.reviewer,
        )
        self.assertTrue(Agency.objects.filter(pk=self.verified.pk).exists())
        self.assertEqual(AuditLog.objects.filter(action="agency.suspended").count(), 1)

    def test_an_agency_that_was_never_verified_cannot_be_suspended(self):
        response = self.post(
            suspend_url(self.pending), {"approve": False, "note": "Soupçons."}, self.reviewer
        )
        self.assertEqual(response.status_code, 409)

    def test_a_suspended_agency_can_be_reinstated(self):
        """The way back exists on purpose. A suspension that can only ever be
        permanent turns every borderline complaint into a decision nobody wants
        to make, so nobody makes it."""
        self.post(
            suspend_url(self.verified),
            {"approve": False, "note": "Vérification en cours."},
            self.reviewer,
        )
        response = self.post(
            decision_url(self.verified),
            {"approve": True, "note": "Plainte non fondée."},
            self.reviewer,
        )
        self.assertEqual(response.status_code, 200)
        self.verified.refresh_from_db()
        self.assertEqual(self.verified.status, Agency.VERIFIED)
