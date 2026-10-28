import hashlib
import re

from django.db import models
from django.utils import timezone

from apps.accounts.models import Agency, User, UUIDModel
from apps.offers.models import Offer

# The exact wording a traveler agreed to. Bumped — never edited in place —
# whenever the consent text changes, so an old lead still answers "what did
# this person actually agree to?". Storing `consent_given=True` alone makes
# that question unanswerable, and unanswerable is legally the same as no
# consent. VERIFY the wording itself against Algerian law 18-07 with a lawyer.
CONSENT_TEXT_VERSION = "2026-08-06.en.v1"
CONSENT_TEXT = (
    "I agree that my contact details may be shared with this agency so it can "
    "contact me about this offer."
)


class Lead(UUIDModel):
    """A traveler's inquiry on an offer — the row the CRM is built around.

    `agency` is denormalised from `offer.agency` on purpose: the tenant filter
    then never has to join, and an offer changing hands later cannot silently
    move a historical lead into another agency's inbox.
    """

    NEW, CONTACTED, QUOTED, NEGOTIATING = "new", "contacted", "quoted", "negotiating"
    BOOKED, TRAVELLED, LOST = "booked", "travelled", "lost"
    STATUSES = [
        (NEW, "New"),
        (CONTACTED, "Contacted"),
        (QUOTED, "Quote sent"),
        (NEGOTIATING, "Negotiating"),
        (BOOKED, "Booked"),
        (TRAVELLED, "Travelled"),
        (LOST, "Lost"),
    ]
    TERMINAL_STATUSES = {TRAVELLED, LOST}

    class Quality(models.TextChoices):
        """How serious the person is. Deliberately blunt words, because the
        agency using this at 9pm needs one glance, not a taxonomy."""

        UNRATED = "unrated", "Unrated"
        SPAM = "spam", "Spam"
        TROLL = "troll", "Troll"
        COLD = "cold", "Cold"
        WARM = "warm", "Warm"
        SERIOUS = "serious", "Serious"
        VIP = "vip", "VIP"

    class Source(models.TextChoices):
        """Where the lead came from — and therefore whether it is billable.

        Never charge an agency for a lead they brought themselves. If you do,
        they stop logging their own clients, and the pipeline data every future
        feature depends on becomes fiction.
        """

        MARKETPLACE = "marketplace_inquiry", "Marketplace"
        TRACKED_LINK = "tracked_link", "Campaign link"
        WALK_IN = "walk_in", "Walk-in"
        DIRECT_CALL = "direct_call", "Direct call"
        IMPORTED = "imported", "Import"

    BILLABLE_SOURCES = {Source.MARKETPLACE, Source.TRACKED_LINK}

    agency = models.ForeignKey(Agency, on_delete=models.CASCADE, related_name="leads")
    offer = models.ForeignKey(Offer, on_delete=models.PROTECT, related_name="leads")
    traveler = models.ForeignKey(
        User, null=True, blank=True, on_delete=models.SET_NULL, related_name="leads"
    )

    # Copied, not linked: an inquiry must work with no account, and the
    # agency's record of who inquired in March must survive that person
    # changing their number or deleting their profile.
    full_name = models.CharField(max_length=150)
    phone_e164 = models.CharField(max_length=20, db_index=True)
    message = models.TextField(blank=True)

    status = models.CharField(max_length=20, choices=STATUSES, default=NEW, db_index=True)
    quality = models.CharField(max_length=20, choices=Quality.choices, default=Quality.UNRATED)
    source = models.CharField(max_length=30, choices=Source.choices, default=Source.MARKETPLACE)
    lost_reason = models.CharField(max_length=200, blank=True)

    assigned_to = models.ForeignKey(
        User, null=True, blank=True, on_delete=models.SET_NULL, related_name="assigned_leads"
    )
    # Powers "due for a callback today" — in practice the screen an agency opens
    # every morning, and the reason they keep using this instead of a notebook.
    next_action_at = models.DateTimeField(null=True, blank=True)
    # Set once, on the first status change. Feeds "you reply in 12 minutes
    # en moyenne", which is the most persuasive number you can show an agency —
    # and a fairer search-ranking signal than recency.
    first_responded_at = models.DateTimeField(null=True, blank=True)

    estimated_value_centimes = models.BigIntegerField(null=True, blank=True)

    # --- the consent trail: written once, never updated ------------------
    consent_given_at = models.DateTimeField(null=True, blank=True)
    consent_text_version = models.CharField(max_length=40, blank=True)
    # Hashed, never the raw address (Rule 4).
    consent_ip_hash = models.CharField(max_length=64, blank=True)
    consent_user_agent = models.CharField(max_length=300, blank=True)

    tracked_link = models.ForeignKey(
        "offers.TrackedLink",
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="leads",
    )

    # The person this inquiry belongs to. Nullable because a client can be
    # deleted without deleting the record of what they asked — the same reason
    # `traveler` is SET_NULL. The snapshotted name and phone above stay the
    # authority for *this* inquiry; the client is the mutable "who they are
    # today".
    client = models.ForeignKey(
        "Client",
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="leads",
    )

    class Meta:
        ordering = ["-created_at"]
        indexes = [
            # Every index leads with `agency` because every query on this table
            # is tenant-scoped: there is no "find lead 123" without "belonging
            # to my agency".
            models.Index(fields=["agency", "status", "-created_at"]),
            models.Index(fields=["agency", "quality"]),
            models.Index(fields=["agency", "assigned_to", "next_action_at"]),
            models.Index(fields=["agency", "phone_e164"]),
        ]

    def __str__(self):
        # Rule 4: never render a full phone number into a log or a repr.
        return f"{self.full_name} → {self.offer.title_fr}"

    @property
    def is_billable(self):
        return self.source in self.BILLABLE_SOURCES

    @property
    def has_consent(self):
        return self.consent_given_at is not None

    def record_consent(self, request):
        self.consent_given_at = timezone.now()
        self.consent_text_version = CONSENT_TEXT_VERSION
        self.consent_ip_hash = hash_ip(request)
        self.consent_user_agent = (request.META.get("HTTP_USER_AGENT") or "")[:300]

    def touch_first_response(self):
        if self.first_responded_at is None and self.status != self.NEW:
            self.first_responded_at = timezone.now()


def hash_ip(request):
    """Salted with SECRET_KEY so the hash is useless outside this deployment,
    and irreversible so the log is not itself the leak it exists to prevent."""
    from django.conf import settings

    raw = request.META.get("REMOTE_ADDR") or ""
    if not raw:
        return ""
    return hashlib.sha256(f"{settings.SECRET_KEY}:{raw}".encode()).hexdigest()


class LeadNote(UUIDModel):
    """Free text from staff. Editable, because it is working memory."""

    agency = models.ForeignKey(Agency, on_delete=models.CASCADE, related_name="lead_notes")
    lead = models.ForeignKey(Lead, on_delete=models.CASCADE, related_name="notes")
    author = models.ForeignKey(
        User, null=True, blank=True, on_delete=models.SET_NULL, related_name="lead_notes"
    )
    body = models.TextField()

    class Meta:
        ordering = ["-created_at"]
        indexes = [models.Index(fields=["agency", "lead", "-created_at"])]

    def __str__(self):
        return f"note on {self.lead_id}"


class LeadActivity(models.Model):
    """Append-only timeline written by the system. Never edited.

    Separate from LeadNote deliberately: if staff could edit the activity
    timeline it would be worthless as evidence in a dispute, and if the system
    wrote into notes, real notes would drown in noise. One table for both looks
    simpler and destroys both purposes.
    """

    import uuid as _uuid

    id = models.UUIDField(primary_key=True, default=_uuid.uuid4, editable=False)
    created_at = models.DateTimeField(auto_now_add=True)

    agency = models.ForeignKey(Agency, on_delete=models.CASCADE, related_name="lead_activities")
    lead = models.ForeignKey(Lead, on_delete=models.CASCADE, related_name="activities")
    actor = models.ForeignKey(
        User, null=True, blank=True, on_delete=models.SET_NULL, related_name="lead_activities"
    )
    verb = models.CharField(max_length=40)
    detail = models.JSONField(default=dict, blank=True)

    class Meta:
        ordering = ["-created_at"]
        verbose_name_plural = "lead activities"
        indexes = [models.Index(fields=["agency", "lead", "-created_at"])]

    def __str__(self):
        return f"{self.verb} on {self.lead_id}"

    def delete(self, *args, **kwargs):
        raise ValueError("Lead activities are append-only.")


class Tag(UUIDModel):
    """An agency-invented label. A *table*, not `choices`, because the values
    are the agency's decision — unlike Lead.status, which is yours."""

    agency = models.ForeignKey(Agency, on_delete=models.CASCADE, related_name="tags")
    name = models.CharField(max_length=40)
    colour = models.CharField(max_length=7, default="#64748b")

    class Meta:
        ordering = ["name"]
        constraints = [
            models.UniqueConstraint(fields=["agency", "name"], name="unique_tag_name_per_agency")
        ]

    def __str__(self):
        return self.name


class LeadTag(UUIDModel):
    agency = models.ForeignKey(Agency, on_delete=models.CASCADE, related_name="lead_tags")
    lead = models.ForeignKey(Lead, on_delete=models.CASCADE, related_name="lead_tags")
    tag = models.ForeignKey(Tag, on_delete=models.CASCADE, related_name="lead_tags")

    class Meta:
        constraints = [models.UniqueConstraint(fields=["lead", "tag"], name="unique_tag_per_lead")]
        indexes = [models.Index(fields=["agency", "tag"])]

    def __str__(self):
        return f"{self.tag_id} on {self.lead_id}"


class ClientQuerySet(models.QuerySet):
    """Queries every client screen shares, so the page and the API cannot
    disagree about what "upcoming" or "repeat" means.

    Stats are annotated separately from filters on purpose: filtering on a
    joined reservation would silently change what `trip_count` counts. Only
    `upcoming` uses `Exists`, which leaves the annotation alone.
    """

    def with_stats(self):
        if "trip_count" in self.query.annotations:
            return self
        return self.annotate(
            lead_count=models.Count("leads", distinct=True),
            trip_count=models.Count("reservations", distinct=True),
            last_trip_on=models.Max("reservations__offer__departure_date"),
        )

    def upcoming(self):
        # Imported here rather than at module level: trips already references
        # leads. models. The statuses are the only thing needed, and a lazy
        # import keeps the model files importable in either order.
        from apps.trips.models import AttendanceStatus, Reservation

        return self.filter(
            models.Exists(
                Reservation.objects.filter(
                    client=models.OuterRef("pk"),
                    offer__departure_date__gte=timezone.localdate(),
                ).exclude(status=AttendanceStatus.CANCELLED)
            )
        )

    def for_filter(self, name):
        queryset = self.with_stats()
        if name == "upcoming":
            return queryset.upcoming()
        if name == "repeat":
            return queryset.filter(trip_count__gte=2)
        if name == "no_trip":
            return queryset.filter(trip_count=0)
        return queryset

    def search(self, term):
        """Name, or phone in whatever shape it was typed.

        `0555 12 34 56` has to find `+213555123456`; a plain `icontains` on the
        stored column never would, because the stored value has no leading zero.
        """
        term = (term or "").strip()
        if not term:
            return self
        digits = re.sub(r"\D", "", term)
        clauses = models.Q(full_name__icontains=term)
        if digits:
            clauses |= models.Q(phone_e164__icontains=digits)
            if digits.startswith("0"):
                clauses |= models.Q(phone_e164__icontains=digits[1:])
        else:
            clauses |= models.Q(phone_e164__icontains=term)
        return self.filter(clauses)


class Client(UUIDModel):
    """A person the agency knows, as opposed to one inquiry they received.

    Identity is the phone number, normalised to E.164 before it reaches here.
    The client is deliberately *small*: a name and a number. Status, quality
    and callbacks stay on the Lead because those describe a deal, not a human.
    Notes and labels — the things that really are about the person — live in
    the two join tables below.
    """

    FILTERS = [
        ("upcoming", "Upcoming"),
        ("repeat", "Repeat"),
        ("no_trip", "No trip"),
    ]

    agency = models.ForeignKey(Agency, on_delete=models.CASCADE, related_name="clients")
    # Mutable profile. The leads and reservations keep the name they were
    # given; correcting a spelling here does not rewrite March's record.
    full_name = models.CharField(max_length=150)
    phone_e164 = models.CharField(max_length=20)

    objects = ClientQuerySet.as_manager()

    class Meta:
        ordering = ["full_name"]
        constraints = [
            models.UniqueConstraint(
                fields=["agency", "phone_e164"], name="unique_client_phone_per_agency"
            )
        ]
        indexes = [models.Index(fields=["agency", "full_name"])]

    def __str__(self):
        # Rule 4: never render a phone number into a log or a repr.
        return self.full_name


class ClientNote(UUIDModel):
    """Free text about the person: preferences, family, the way they like to be
    called. Editable, because it is working memory — exactly like LeadNote,
    and separate for the same reason: an inquiry note answers a different
    question from a client note."""

    agency = models.ForeignKey(Agency, on_delete=models.CASCADE, related_name="client_notes")
    client = models.ForeignKey(Client, on_delete=models.CASCADE, related_name="notes")
    author = models.ForeignKey(
        User, null=True, blank=True, on_delete=models.SET_NULL, related_name="client_notes"
    )
    body = models.TextField()

    class Meta:
        ordering = ["-created_at"]
        indexes = [models.Index(fields=["agency", "client", "-created_at"])]

    def __str__(self):
        return f"note on {self.client_id}"


class ClientTag(UUIDModel):
    """The existing Tag vocabulary, applied to a person rather than an inquiry."""

    agency = models.ForeignKey(Agency, on_delete=models.CASCADE, related_name="client_tags")
    client = models.ForeignKey(Client, on_delete=models.CASCADE, related_name="client_tags")
    tag = models.ForeignKey(Tag, on_delete=models.CASCADE, related_name="client_tags")

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["client", "tag"], name="unique_tag_per_client")
        ]
        indexes = [models.Index(fields=["agency", "tag"])]

    def __str__(self):
        return f"{self.tag_id} on {self.client_id}"
