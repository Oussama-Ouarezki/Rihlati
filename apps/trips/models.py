"""The trip manifest: who is actually going, and who is actually here.

A [[Lead]] is a question. A Reservation is a commitment — a named family on a
named departure. They are separate tables because they answer separate
questions and have separate lifetimes: a lead that never converts is still a
useful commercial record, and a reservation can exist for someone who walked
into the office and never was a lead at all.
"""

import secrets

from django.db import models
from django.utils import timezone

from apps.accounts.models import Agency, User, UUIDModel
from apps.offers.models import CheckpointType, Offer, OfferMilestone


class AttendanceStatus(models.TextChoices):
    """One vocabulary, used at booking level and at every checkpoint.

    Deliberately free transitions — any status to any status. A guide at 4am
    with one hand on a phone does not need a state machine telling them the
    family they just watched board cannot be marked present.
    """

    EXPECTED = "expected", "Expected"
    CHECKED_IN = "checked_in", "Checked in"
    NO_SHOW = "no_show", "No-show"
    CANCELLED = "cancelled", "Cancelled"


class Reservation(UUIDModel):
    """One family on one departure."""

    agency = models.ForeignKey(Agency, on_delete=models.CASCADE, related_name="reservations")
    offer = models.ForeignKey(Offer, on_delete=models.PROTECT, related_name="reservations")
    lead = models.ForeignKey(
        "leads.Lead", null=True, blank=True, on_delete=models.SET_NULL, related_name="reservations"
    )
    # The person behind the booking. Nullable and SET_NULL for the same reason
    # as `lead`: deleting a client must not delete a family's travel record.
    client = models.ForeignKey(
        "leads.Client",
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="reservations",
    )

    # Snapshotted, not linked — the same reasoning as Lead. A reservation is a
    # business document about a moment, not a view of a mutable profile.
    full_name = models.CharField(max_length=150)
    phone_e164 = models.CharField(max_length=20)
    party_size = models.PositiveSmallIntegerField(default=1)
    note = models.TextField(blank=True)

    status = models.CharField(
        max_length=20, choices=AttendanceStatus.choices, default=AttendanceStatus.EXPECTED
    )

    # A capability URL: whoever holds the code can read this family's trip
    # page. Acceptable ONLY because the page shows their own booking and an
    # already-public programme — never the passenger list, never CRM notes.
    public_code = models.CharField(max_length=32, unique=True, db_index=True, blank=True)

    class Meta:
        ordering = ["full_name"]
        indexes = [
            models.Index(fields=["agency", "offer", "status"]),
            models.Index(fields=["offer", "full_name"]),
        ]

    def __str__(self):
        # Rule 4: never render a full phone number into a log or a repr.
        return f"{self.full_name} · {self.offer.title_fr}"

    def save(self, *args, **kwargs):
        if not self.public_code:
            self.public_code = self.new_public_code()
        return super().save(*args, **kwargs)

    @staticmethod
    def new_public_code():
        # 32 hex chars ≈ 128 bits. The URL *is* the credential, so it has to be
        # unguessable in the same sense a password is.
        return secrets.token_hex(16)


class MilestoneCheckIn(UUIDModel):
    """One family's attendance at ONE checkpoint.

    Stored per (milestone, reservation) rather than on the reservation, because
    a family can be `checked_in` for the outbound flight and still `expected`
    at a ziyara three days later. One status per booking cannot express that.

    Rows are created lazily — the first time a guide opens a checkpoint's list —
    so adding a checkpoint mid-trip needs no backfill.
    """

    agency = models.ForeignKey(Agency, on_delete=models.CASCADE, related_name="check_ins")
    milestone = models.ForeignKey(
        OfferMilestone, on_delete=models.CASCADE, related_name="check_ins"
    )
    reservation = models.ForeignKey(Reservation, on_delete=models.CASCADE, related_name="check_ins")
    status = models.CharField(
        max_length=20, choices=AttendanceStatus.choices, default=AttendanceStatus.EXPECTED
    )
    checked_in_at = models.DateTimeField(null=True, blank=True)
    checked_in_by = models.ForeignKey(
        User, null=True, blank=True, on_delete=models.SET_NULL, related_name="check_ins_made"
    )

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["milestone", "reservation"], name="one_checkin_per_family_per_checkpoint"
            )
        ]
        indexes = [
            models.Index(fields=["agency"]),
            models.Index(fields=["milestone", "status"]),
        ]

    def __str__(self):
        return f"{self.reservation.full_name} @ {self.milestone.title}: {self.status}"


def default_status_for(milestone, reservation):
    """What a checkpoint row starts as before anyone taps anything.

    A mandatory checkpoint — a flight, the departure bus — **never** defaults.
    Everyone starts `expected` and somebody physically confirms each family. A
    wrong default at a mandatory stop means a family left behind.

    An optional checkpoint carries the last optional answer forward: a family
    that skipped yesterday's excursion probably skipped today's, and re-marking
    the same absent family at every stop is how a guide stops using the app.
    It is only ever a *default* — one tap changes it.
    """
    if milestone.checkpoint_type == CheckpointType.MANDATORY:
        return AttendanceStatus.EXPECTED

    previous = (
        MilestoneCheckIn.objects.filter(
            reservation=reservation,
            milestone__offer_id=milestone.offer_id,
            milestone__checkpoint_type=CheckpointType.OPTIONAL,
        )
        .exclude(milestone_id=milestone.pk)
        .order_by("-milestone__day_offset", "-milestone__sort_order")
        .first()
    )
    if previous and previous.status == AttendanceStatus.NO_SHOW:
        return AttendanceStatus.NO_SHOW
    return AttendanceStatus.EXPECTED


def current_milestone(offer):
    """ "You are here" = the first milestone the agency has NOT ticked off.

    Deliberately not derived from the clock. The programme says 04:30, but the
    bus leaves when the bus leaves, and computing progress from
    `departure_date + day_offset + time_of_day` would confidently announce that
    a delayed group had already boarded. A tick is a deliberate act by somebody
    standing there; a clock is a guess.
    """
    return offer.milestones.filter(completed_at__isnull=True).first()


def mark_completed(milestone, user):
    milestone.completed_at = timezone.now()
    milestone.completed_by = user
    milestone.save(update_fields=["completed_at", "completed_by", "updated_at"])
    return milestone
