import secrets
import uuid

from django.contrib.auth.models import AbstractUser
from django.db import models
from django.utils import timezone


class UUIDModel(models.Model):
    """Rule 3: ids are UUIDs, never sequential integers.

    Sequential ids leak volume (`/offers/1041` says you have ~1000 offers) and
    invite enumeration attacks against any endpoint that forgets to scope.

    Inheriting this is not decoration: DEFAULT_AUTO_FIELD is BigAutoField, so a
    model that forgets silently gets integer ids back and nothing complains.
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        abstract = True


class User(AbstractUser):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    # E.164 only. Stored once, never logged in full.
    phone = models.CharField(max_length=20, blank=True)
    preferred_language = models.CharField(max_length=2, choices=[("en", "English")], default="en")


class Agency(UUIDModel):
    """The tenant. Every private row in the database points at one of these."""

    DRAFT = "draft"
    PENDING = "pending_review"
    VERIFIED = "verified"
    REJECTED = "rejected"
    SUSPENDED = "suspended"
    STATUSES = [
        (DRAFT, "Draft"),
        (PENDING, "Pending verification"),
        (VERIFIED, "Verified"),
        (REJECTED, "Rejected"),
        (SUSPENDED, "Suspended"),
    ]
    # Which states a reviewer may move an agency into, from where. A table
    # rather than scattered `if`s: anything not listed here is refused, and
    # adding a state means editing one dict instead of hunting for branches.
    STATUS_TRANSITIONS = {
        DRAFT: {PENDING},
        PENDING: {VERIFIED, REJECTED},
        REJECTED: {PENDING},
        VERIFIED: {SUSPENDED},
        SUSPENDED: {VERIFIED, REJECTED},
    }

    FREE, PRO, BUSINESS = "free", "pro", "business"
    PLANS = [(FREE, "Free"), (PRO, "Pro"), (BUSINESS, "Business")]

    name = models.CharField(max_length=200)
    slug = models.SlugField(unique=True)
    description = models.TextField(blank=True)
    city = models.CharField(max_length=100)
    # Two digits as a *string*: "01" must never become 1. See WILAYAS.
    wilaya_code = models.CharField(max_length=2, blank=True, db_index=True)

    phone = models.CharField(max_length=20, blank=True)
    # Separate from `phone` on purpose: in Algeria business happens on
    # WhatsApp, often on a different number from the office landline.
    whatsapp = models.CharField(max_length=20, blank=True)
    email = models.EmailField(blank=True)
    website_url = models.URLField(max_length=300, blank=True)
    logo_url = models.URLField(max_length=500, blank=True)

    # --- verification: the actual product -------------------------------
    status = models.CharField(max_length=20, choices=STATUSES, default=DRAFT, db_index=True)
    registre_commerce = models.CharField(max_length=50, blank=True)
    nif = models.CharField(max_length=50, blank=True)
    tourism_licence = models.CharField(max_length=50, blank=True)
    # Not the same as `updated_at`, which moves whenever anyone edits a phone
    # number. This one answers "who has been waiting longest?" — the only fair
    # way to order a manual queue — and is kept after the decision so that
    # "we took nine days to answer" stays a measurable fact.
    submitted_for_review_at = models.DateTimeField(null=True, blank=True)
    decided_at = models.DateTimeField(null=True, blank=True)
    decided_by = models.ForeignKey(
        User, null=True, blank=True, on_delete=models.SET_NULL, related_name="agency_decisions"
    )
    # What the reviewer actually checked. Required to grant the badge, because
    # a badge nobody had to justify is a badge that means nothing.
    decision_note = models.TextField(blank=True)
    # Shown VERBATIM to the owner, so it has to be written for them to read.
    rejection_reason = models.TextField(blank=True)

    # --- plan, quotas, money --------------------------------------------
    plan = models.CharField(max_length=20, choices=PLANS, default=FREE)
    published_offer_limit_override = models.PositiveIntegerField(null=True, blank=True)
    credit_balance_centimes = models.BigIntegerField(default=0)

    # --- denormalised counters ------------------------------------------
    # Read on every listing card, so they are stored rather than counted. The
    # price of that speed is that they can drift: recompute_rating() exists,
    # and any denormalised counter without a reconciliation job eventually lies.
    rating_sum = models.PositiveIntegerField(default=0)
    rating_count = models.PositiveIntegerField(default=0)
    open_report_count = models.PositiveIntegerField(default=0)

    class Meta:
        verbose_name_plural = "agencies"
        indexes = [models.Index(fields=["status", "wilaya_code"])]

    def __str__(self):
        return self.name

    @property
    def is_verified(self):
        return self.status == self.VERIFIED

    @property
    def rating_average(self):
        if not self.rating_count:
            return None
        return round(self.rating_sum / self.rating_count, 1)

    def can_transition_to(self, new_status):
        return new_status in self.STATUS_TRANSITIONS.get(self.status, set())

    def recompute_rating(self):
        """Recalculate from the source rows. The reconciliation half of the
        denormalisation trade — call it whenever a review changes, and from a
        periodic job that shouts if the stored numbers disagreed."""
        from apps.reviews.models import Review

        agg = Review.objects.filter(agency=self, is_published=True).aggregate(
            total=models.Sum("rating"), count=models.Count("id")
        )
        self.rating_sum = agg["total"] or 0
        self.rating_count = agg["count"] or 0
        self.save(update_fields=["rating_sum", "rating_count", "updated_at"])


class Membership(UUIDModel):
    """The join table that *is* the tenancy model.

    A user is not "in" an agency by having an `agency_id` column on the user —
    that would cap them at one agency forever and make ownership transfer a
    data migration. Membership is a row, so it can be added and revoked.
    """

    OWNER = "agency_owner"
    MANAGER = "agency_manager"
    AGENT = "agency_agent"
    ROLES = [(OWNER, "Owner"), (MANAGER, "Manager"), (AGENT, "Agent")]
    # Ranks, not a list of allowed roles per endpoint. A guard asks "is your
    # rank >= the rank this action needs", so adding a role later is one line
    # here instead of an edit at every call site.
    RANK = {AGENT: 1, MANAGER: 2, OWNER: 3}

    user = models.ForeignKey(User, on_delete=models.CASCADE, related_name="memberships")
    agency = models.ForeignKey(Agency, on_delete=models.CASCADE, related_name="memberships")
    role = models.CharField(max_length=20, choices=ROLES, default=AGENT)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["user", "agency"], name="unique_membership_per_agency")
        ]

    def __str__(self):
        # Username, never the phone number — this string ends up in the admin
        # log and in any exception report that mentions the object (Rule 4).
        return f"{self.user.username} @ {self.agency.name} ({self.role})"

    @property
    def rank(self):
        return self.RANK.get(self.role, 0)


class RefreshToken(UUIDModel):
    """A long-lived credential, stored hashed, rotated on every use.

    Three properties, each earning its column:

    * `token_hash` — the raw token is shown to the client once and never
      stored. A database dump does not hand over live sessions.
    * `family` — every refresh descends from one login. Reuse of an
      already-spent token can only mean two parties hold it, so the whole
      family is revoked and the thief and the victim are both logged out.
      The theft is detected by the victim's own normal activity.
    * `revoked_at` — nullable timestamp rather than a boolean, because "when"
      is the question you will actually ask.
    """

    user = models.ForeignKey(User, on_delete=models.CASCADE, related_name="refresh_tokens")
    token_hash = models.CharField(max_length=64, unique=True)
    family = models.UUIDField(default=uuid.uuid4, db_index=True)
    expires_at = models.DateTimeField()
    revoked_at = models.DateTimeField(null=True, blank=True)
    used_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        indexes = [models.Index(fields=["user", "revoked_at"])]

    def __str__(self):
        return f"refresh for {self.user.username} (family {self.family})"

    @property
    def is_live(self):
        return self.revoked_at is None and self.expires_at > timezone.now()


class AuditLog(models.Model):
    """Append-only: who changed what, in whose context, and what it was before.

    Deliberately NOT a UUIDModel — it has no `updated_at`, because nothing may
    update it. A log that can be edited is not evidence.
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    created_at = models.DateTimeField(auto_now_add=True, db_index=True)

    actor = models.ForeignKey(
        User, null=True, blank=True, on_delete=models.SET_NULL, related_name="audit_entries"
    )
    agency = models.ForeignKey(
        Agency, null=True, blank=True, on_delete=models.SET_NULL, related_name="audit_entries"
    )
    action = models.CharField(max_length=60, db_index=True)
    entity_type = models.CharField(max_length=40)
    entity_id = models.UUIDField(null=True, blank=True)
    before = models.JSONField(default=dict, blank=True)
    after = models.JSONField(default=dict, blank=True)
    # Ties an audit row to every application log line for the same request.
    # An agency quotes the id from a screenshot; you get both halves.
    request_id = models.CharField(max_length=32, blank=True)

    class Meta:
        ordering = ["-created_at"]
        indexes = [models.Index(fields=["agency", "-created_at"])]

    def __str__(self):
        return f"{self.action} on {self.entity_type} {self.entity_id}"

    def save(self, *args, **kwargs):
        if self.pk and AuditLog.objects.filter(pk=self.pk).exists():
            raise ValueError("Audit rows are append-only.")
        return super().save(*args, **kwargs)

    def delete(self, *args, **kwargs):
        raise ValueError("Audit rows are append-only.")


def generate_token():
    """32 bytes from the OS CSPRNG. `secrets`, never `random` — `random` is a
    Mersenne Twister, and observing a few outputs predicts the rest."""
    return secrets.token_urlsafe(32)
