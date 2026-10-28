"""Agency ratings.

The design question that matters here is not "how do we store five stars" — it
is **who is allowed to leave one**. An open review box on a marketplace where
agencies know each other by name in the same wilaya is a weapon, not a signal.
"""

from django.db import models

from apps.accounts.models import Agency, User, UUIDModel
from apps.leads.models import Lead


class Review(UUIDModel):
    """A rating, tied to a lead that actually reached a terminal state.

    `lead` is what makes a review *verifiable* rather than fiction: the person
    leaving it demonstrably contacted this agency through Rihlati. That is a
    weaker claim than "they travelled" and a far stronger one than "someone on
    the internet typed five stars".
    """

    agency = models.ForeignKey(Agency, on_delete=models.CASCADE, related_name="reviews")
    lead = models.OneToOneField(
        Lead, null=True, blank=True, on_delete=models.SET_NULL, related_name="review"
    )
    author = models.ForeignKey(
        User, null=True, blank=True, on_delete=models.SET_NULL, related_name="reviews"
    )
    author_name = models.CharField(max_length=150)

    rating = models.PositiveSmallIntegerField()
    comment = models.TextField(blank=True)

    # Not a boolean `is_hidden`: moderation needs to survive the moderator.
    is_published = models.BooleanField(default=True)
    hidden_reason = models.TextField(blank=True)
    # An agency answering a bad review publicly is the single most useful
    # feature for the agency and the most trusted signal for the reader.
    agency_reply = models.TextField(blank=True)
    agency_replied_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ["-created_at"]
        constraints = [
            models.CheckConstraint(
                condition=models.Q(rating__gte=1) & models.Q(rating__lte=5),
                name="rating_between_1_and_5",
            )
        ]
        indexes = [models.Index(fields=["agency", "is_published", "-created_at"])]

    def __str__(self):
        return f"{self.rating}★ for {self.agency.name}"

    def save(self, *args, **kwargs):
        super().save(*args, **kwargs)
        # The reconciliation half of the denormalised counter on Agency. Any
        # cached count without something like this eventually lies.
        self.agency.recompute_rating()
