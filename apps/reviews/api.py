"""Ratings.

The design question is not "how do we store five stars", it is **who may leave
one**. An open review box on a marketplace where agencies in the same wilaya
know each other by name is a weapon. So a review requires a lead that reached a
terminal state — proof the person actually contacted this agency here.

That is a weaker claim than "they travelled" and a far stronger one than
"someone on the internet typed one star".
"""

from django.db import transaction
from django.shortcuts import get_object_or_404
from django.utils import timezone
from ninja import Field, Router
from ninja.errors import HttpError

from apps.accounts.models import Agency, Membership
from apps.common.schemas import Strict
from apps.common.tenancy import audit, require_membership, scoped
from apps.leads.models import Lead
from apps.reviews.models import Review

public_router = Router(tags=["reviews"])
agency_router = Router(tags=["reviews"])


class ReviewIn(Strict):
    lead_id: str
    rating: int = Field(ge=1, le=5)
    comment: str = Field("", max_length=2000)
    author_name: str = Field(min_length=2, max_length=150)
    # No `agency_id`: it comes from the lead. A client that names the agency it
    # is rating can rate one it never dealt with.


class ReviewOut(Strict):
    id: str
    rating: int
    comment: str
    author_name: str
    agency_reply: str
    created_at: str


class ReplyIn(Strict):
    reply: str = Field(min_length=1, max_length=2000)


def review_out(review):
    return {
        "id": str(review.id),
        "rating": review.rating,
        "comment": review.comment,
        "author_name": review.author_name,
        "agency_reply": review.agency_reply,
        "created_at": review.created_at.isoformat(),
    }


@public_router.get("/agencies/{uuid:agency_id}/reviews", response=list[ReviewOut], auth=None)
def list_reviews(request, agency_id):
    agency = get_object_or_404(Agency, pk=agency_id, status=Agency.VERIFIED)
    return [review_out(r) for r in agency.reviews.filter(is_published=True)]


@public_router.post("/reviews", response={201: ReviewOut}, auth=None)
def create_review(request, payload: ReviewIn):
    lead = get_object_or_404(Lead, pk=payload.lead_id)
    if lead.status not in Lead.TERMINAL_STATUSES:
        raise HttpError(409, "You can review this agency once your trip is complete.")
    if Review.objects.filter(lead=lead).exists():
        raise HttpError(409, "A review already exists for this trip.")

    with transaction.atomic():
        review = Review.objects.create(
            agency=lead.agency,
            lead=lead,
            author=lead.traveler,
            author_name=payload.author_name.strip(),
            rating=payload.rating,
            comment=payload.comment,
        )
    return 201, review_out(review)


@agency_router.put("/agencies/{uuid:agency_id}/reviews/{uuid:review_id}/reply", response=ReviewOut)
def reply_to_review(request, agency_id, review_id, payload: ReplyIn):
    """A public answer to a bad review is the single most useful thing an agency
    can do here, and the most trusted signal a reader gets: a calm reply says
    more than the complaint does. Hence a reply, and no ability to delete."""
    agency = require_membership(request.user, agency_id, Membership.MANAGER)
    review = get_object_or_404(scoped(Review.objects, agency_id), pk=review_id)
    with transaction.atomic():
        review.agency_reply = payload.reply
        review.agency_replied_at = timezone.now()
        review.save(update_fields=["agency_reply", "agency_replied_at", "updated_at"])
        audit(request, "review.replied", review, agency=agency)
    return review_out(review)
