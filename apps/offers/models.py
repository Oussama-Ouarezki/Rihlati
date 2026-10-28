import uuid

from django.db import models
from django.utils import timezone
from django.utils.text import slugify

from apps.accounts.models import Agency, User, UUIDModel
from apps.common.wilayas import WILAYA_CHOICES


class Offer(UUIDModel):
    OMRA = "omra"
    HAJJ = "hajj"
    TRIP = "organized_trip"
    VISA = "visa_assistance"
    KINDS = [(OMRA, "Omra"), (HAJJ, "Hajj"), (TRIP, "Organized trip"), (VISA, "Visa")]

    DRAFT, PUBLISHED, ARCHIVED = "draft", "published", "archived"
    STATUSES = [(DRAFT, "Draft"), (PUBLISHED, "Published"), (ARCHIVED, "Archived")]

    CLEAN, SUSPECTED, CONFIRMED_DUPLICATE = "clean", "suspected", "confirmed_duplicate"
    DUPLICATE_STATUSES = [
        (CLEAN, "Clean"),
        (SUSPECTED, "Suspected duplicate"),
        (CONFIRMED_DUPLICATE, "Confirmed duplicate"),
    ]

    # Rule 3: non-null tenant column on every tenant-scoped table.
    agency = models.ForeignKey(Agency, on_delete=models.CASCADE, related_name="offers")

    title_fr = models.CharField(max_length=200)
    title_ar = models.CharField(max_length=200)
    slug = models.SlugField(max_length=220, unique=True, blank=True)
    # Short prose intro. The schedule itself lives in OfferMilestone, which is
    # comparable between agencies in a way a wall of text never is.
    description = models.TextField(blank=True)
    kind = models.CharField(max_length=20, choices=KINDS)

    # A URL, not an upload: agency photos live on arbitrary hosts until uploads
    # move to our own bucket. See obsidian/Backend/Image Uploads.md.
    cover_image_url = models.URLField(max_length=500, blank=True)

    # Money is integer centimes of DZD. A float price is a rounding bug waiting
    # for a large booking — 349000.00 is not exactly representable in binary.
    price_centimes = models.BigIntegerField()
    # "from X" needs a second number to mean anything.
    price_to_centimes = models.BigIntegerField(null=True, blank=True)

    departure_date = models.DateField()
    return_date = models.DateField(null=True, blank=True)
    # "Departures every week during Ramadan" — search must not treat this as one
    # fixed date, or it hides an offer that is available the week you asked for.
    is_flexible_dates = models.BooleanField(default=False)
    departure_wilaya_code = models.CharField(
        max_length=2, choices=WILAYA_CHOICES, blank=True, db_index=True
    )
    destination_country = models.CharField(max_length=80, blank=True)
    destination_city = models.CharField(max_length=80, blank=True)

    seats_total = models.PositiveIntegerField()
    seats_left = models.PositiveIntegerField()
    status = models.CharField(max_length=20, choices=STATUSES, default=DRAFT)
    # Stale listings are the top complaint on every marketplace. Past this,
    # `expire_stale_offers` archives the row.
    expires_at = models.DateTimeField(null=True, blank=True)

    # Kind-specific fields that nothing filters on.
    #
    # NOT YET VALIDATED. `OfferIn` types this `dict`, so any JSON object is
    # accepted and a typo like `nightsInMaccah` is stored silently. A JSONField
    # with no schema is a table with no rules — the per-kind schemas belong in
    # apps/common/validators.py, enforced from both OfferIn and OfferForm.
    attributes = models.JSONField(default=dict, blank=True)

    # --- server-owned. Never in an input schema, never in a form. --------
    is_featured = models.BooleanField(default=False)
    featured_until = models.DateTimeField(null=True, blank=True)
    quality_score = models.PositiveSmallIntegerField(default=0)
    fingerprint = models.CharField(max_length=64, blank=True, db_index=True)
    duplicate_status = models.CharField(max_length=20, choices=DUPLICATE_STATUSES, default=CLEAN)
    duplicate_of = models.ForeignKey(
        "self", null=True, blank=True, on_delete=models.SET_NULL, related_name="duplicates"
    )
    report_count = models.PositiveIntegerField(default=0)

    class Meta:
        ordering = ["departure_date"]
        indexes = [
            # Every public search filters on status and duplicate_status, so
            # they lead. An index helps only if the query uses a prefix of its
            # columns, left to right.
            models.Index(fields=["status", "duplicate_status", "kind", "departure_date"]),
            models.Index(fields=["status", "duplicate_status", "departure_wilaya_code"]),
            models.Index(fields=["status", "duplicate_status", "price_centimes"]),
            models.Index(fields=["agency", "status"]),
        ]
        constraints = [
            # The database refuses, rather than every caller remembering.
            models.CheckConstraint(
                condition=models.Q(seats_left__lte=models.F("seats_total")),
                name="seats_left_within_total",
            ),
            models.CheckConstraint(
                condition=models.Q(price_centimes__gt=0), name="price_is_positive"
            ),
        ]

    def __str__(self):
        return f"{self.title_fr} ({self.agency.name})"

    def save(self, *args, **kwargs):
        if not self.slug:
            self.slug = self._unique_slug()
        return super().save(*args, **kwargs)

    def _unique_slug(self):
        """Generated server-side, never accepted from a client: an agency that
        picks its own slug can claim `omra-pas-cher`, or a competitor's name."""
        base = slugify(f"{self.title_fr}-{self.agency.city}")[:200] or "offer"
        candidate, n = base, 1
        while Offer.objects.filter(slug=candidate).exclude(pk=self.pk).exists():
            n += 1
            candidate = f"{base}-{n}"
        return candidate

    @property
    def price_dzd(self):
        return self.price_centimes / 100

    @property
    def is_expired(self):
        return self.expires_at is not None and self.expires_at <= timezone.now()

    @classmethod
    def publicly_visible(cls):
        """The one queryset travelers are allowed to see.

        Published, from a verified agency, and not a confirmed duplicate. Named
        once with four callers — the API list, the API detail, the search page
        and the inquiry endpoint — because the fifth caller written inline is
        the one that forgets a condition, and the bug is an unverified agency
        quietly receiving real leads.
        """
        return cls.objects.filter(
            status=cls.PUBLISHED,
            agency__status=Agency.VERIFIED,
        ).exclude(duplicate_status=cls.CONFIRMED_DUPLICATE)

    def compute_quality_score(self):
        """Listing completeness, 0–100. Rewards agencies that fill in real
        detail, and gives search something fairer than recency to rank on."""
        checks = [
            bool(self.cover_image_url),
            len(self.description) >= 200,
            bool(self.destination_city),
            bool(self.departure_wilaya_code),
            bool(self.return_date),
            self.price_to_centimes is not None,
            self.milestones.count() >= 3,
            bool(self.title_ar.strip()),
        ]
        return round(100 * sum(checks) / len(checks))


class MilestoneKind(models.TextChoices):
    MEETING = "meeting", "Meeting"
    TRANSPORT = "transport", "Transport"
    FLIGHT = "flight", "Flight"
    HOTEL = "hotel", "Hotel"
    RITUAL = "ritual", "Ritual"
    ZIYARA = "ziyara", "Ziyara"
    MEAL = "meal", "Meal"
    FREE_TIME = "free_time", "Free time"
    OTHER = "other", "Other"


class CheckpointType(models.TextChoices):
    NONE = "none", "No checkpoint"
    MANDATORY = "mandatory", "Mandatory checkpoint"
    OPTIONAL = "optional", "Optional checkpoint"


# A title that needs truncating is a title nobody can read while walking
# through an airport. The limit is a schema decision, not a style one, and the
# form shows a live counter so the cost is visible while typing.
MILESTONE_TITLE_MAX = 60
MILESTONE_MAX_PER_OFFER = 200


class OfferMilestone(UUIDModel):
    """One stop in a trip's programme.

    Why this exists at all: Omra and Hajj are not "a holiday", they are a
    schedule. Buyers compare programmes, not prices alone; "where do we meet?"
    is the single most repeated question in the business and gets asked once
    per family; and during the trip nobody knows what is next.

    One structured list answers all three, from the same rows.
    """

    # Denormalised tenant key (rule 3): the tenant filter never has to join,
    # so the safe query is also the lazy query.
    agency = models.ForeignKey(Agency, on_delete=models.CASCADE, related_name="milestones")
    offer = models.ForeignKey(Offer, on_delete=models.CASCADE, related_name="milestones")

    title = models.CharField(max_length=MILESTONE_TITLE_MAX)
    description = models.TextField(blank=True)
    kind = models.CharField(
        max_length=20, choices=MilestoneKind.choices, default=MilestoneKind.OTHER
    )

    # Day of the trip, 0 = departure day. Combined with Offer.departure_date
    # this renders a real date WITHOUT storing one — so a programme is a
    # reusable template, and moving a departure by three days edits one field
    # instead of twelve rows.
    day_offset = models.PositiveSmallIntegerField(default=0)
    # "04:30", local to wherever the traveler is standing. Never converted: a
    # programme that says 04:30 must say 04:30 to everyone reading it, and
    # quietly shifting by an hour is how people miss the bus.
    time_of_day = models.CharField(max_length=5, blank=True)

    location_name = models.CharField(max_length=150, blank=True)
    # The sentence a traveler reads at 4am. "Terminal 1, gate 3, next to the
    # café" — not "the airport".
    meeting_point = models.CharField(max_length=300, blank=True)
    map_url = models.URLField(max_length=500, blank=True)

    sort_order = models.PositiveSmallIntegerField(default=0)
    checkpoint_type = models.CharField(
        max_length=20, choices=CheckpointType.choices, default=CheckpointType.NONE
    )

    # Ticked by the agency when the step actually happens. Drives the public
    # "you are here" marker.
    completed_at = models.DateTimeField(null=True, blank=True)
    completed_by = models.ForeignKey(
        User, null=True, blank=True, on_delete=models.SET_NULL, related_name="milestones_ticked"
    )

    class Meta:
        ordering = ["day_offset", "sort_order", "created_at"]
        indexes = [
            models.Index(fields=["offer", "day_offset", "sort_order"]),
            models.Index(fields=["agency"]),
        ]

    def __str__(self):
        return f"D{self.day_offset} · {self.title}"

    @property
    def real_date(self):
        return self.offer.departure_date + timezone.timedelta(days=self.day_offset)

    @property
    def tracks_attendance(self):
        return self.checkpoint_type != CheckpointType.NONE


class OfferReport(UUIDModel):
    """A traveler flags a listing. Feeds a review queue; deletes nothing."""

    SPAM, MISLEADING, DUPLICATE, OTHER = "spam", "misleading", "duplicate", "other"
    REASONS = [
        (SPAM, "Spam"),
        (MISLEADING, "Misleading information"),
        (DUPLICATE, "Duplicate"),
        (OTHER, "Other"),
    ]

    offer = models.ForeignKey(Offer, on_delete=models.CASCADE, related_name="reports")
    reporter = models.ForeignKey(
        User, null=True, blank=True, on_delete=models.SET_NULL, related_name="offer_reports"
    )
    # Anonymous reporters are identified by a hash, so one person cannot file
    # the same complaint fifty times without an account — and so the raw IP is
    # never stored (Rule 4).
    reporter_fingerprint = models.CharField(max_length=64, blank=True, db_index=True)
    reason = models.CharField(max_length=20, choices=REASONS)
    note = models.TextField(blank=True)
    resolved_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["offer", "reporter"],
                condition=models.Q(reporter__isnull=False),
                name="one_report_per_user_per_offer",
            ),
            models.UniqueConstraint(
                fields=["offer", "reporter_fingerprint"],
                condition=~models.Q(reporter_fingerprint=""),
                name="one_report_per_fingerprint_per_offer",
            ),
        ]

    def __str__(self):
        return f"{self.reason} on {self.offer_id}"


class TrackedLink(UUIDModel):
    """A short code an agency pastes into a Facebook post or a WhatsApp status.

    The point is answering "which channel actually brings buyers?" without any
    third-party analytics script — so no cookie banner, no data leaving the
    country, and nothing to block.
    """

    agency = models.ForeignKey(Agency, on_delete=models.CASCADE, related_name="tracked_links")
    offer = models.ForeignKey(
        Offer, null=True, blank=True, on_delete=models.CASCADE, related_name="tracked_links"
    )
    code = models.CharField(max_length=12, unique=True, db_index=True)
    label = models.CharField(max_length=80)
    click_count = models.PositiveIntegerField(default=0)
    lead_count = models.PositiveIntegerField(default=0)

    class Meta:
        indexes = [models.Index(fields=["agency", "-created_at"])]

    def __str__(self):
        return f"{self.label} (/l/{self.code})"

    @staticmethod
    def new_code():
        return uuid.uuid4().hex[:8]

    @classmethod
    def resolve(cls, code, agency_id=None):
        """A `?ref=` from a form, or a `/l/{code}` in a Facebook post.

        Returns the link or `None` — never raises. A stale code in a shared
        post is the normal case, not an error: the traveler still wants to see
        the offer, and losing the attribution is the right thing to lose.

        `agency_id` is passed when the caller already knows which agency the
        offer belongs to. Without it, a traveler could hand back a *competitor's*
        code and pad their click-to-client numbers with leads they never earned.
        """
        if not code:
            return None
        queryset = cls.objects.filter(code=code)
        if agency_id is not None:
            queryset = queryset.filter(agency_id=agency_id)
        return queryset.first()

    def count_click(self):
        """`F()`, not read-modify-write.

        Two people tapping the same Facebook post in the same second is the
        normal case for this feature, and `link.click_count += 1; link.save()`
        loses one of them. The database does the addition.
        """
        type(self).objects.filter(pk=self.pk).update(click_count=models.F("click_count") + 1)


class OfferDailyMetric(models.Model):
    """One row per offer per day, incremented in place.

    Storing a row per *view* would mean millions of rows to answer "how many
    views last week", and would hold a visit trail per person for no product
    reason. Counters per day answer every question an agency actually asks and
    are anonymous by construction — the privacy-preserving option is also the
    cheap one, which is rare enough to notice.
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    agency = models.ForeignKey(Agency, on_delete=models.CASCADE, related_name="daily_metrics")
    offer = models.ForeignKey(Offer, on_delete=models.CASCADE, related_name="daily_metrics")
    day = models.DateField(db_index=True)
    views = models.PositiveIntegerField(default=0)
    inquiries = models.PositiveIntegerField(default=0)
    link_clicks = models.PositiveIntegerField(default=0)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["offer", "day"], name="one_metric_row_per_offer_day")
        ]
        indexes = [models.Index(fields=["agency", "-day"])]

    def __str__(self):
        return f"{self.offer_id} on {self.day}"
