"""Plan limits — how many offers an agency may have published at once.

The rule that matters is **where the number comes from**: the database and this
table, never the request. Rule 6 is written about money, but a quota is money
wearing a different hat — an agency that can send its own limit is an agency on
the Business plan for free.

Nothing is charged in v1. The limits exist now anyway, because retrofitting a
quota onto agencies who already published two hundred offers means either
breaking them or grandfathering them forever.

Draft and archived offers are deliberately unlimited. The scarce thing is
visibility on the marketplace, not rows in a table, and an agency that cannot
prepare next season's catalogue in draft will prepare it in a spreadsheet
instead — and then never move it here.
"""

from apps.accounts.models import Agency

PUBLISHED_OFFER_LIMITS = {
    Agency.FREE: 5,
    Agency.PRO: 30,
    Agency.BUSINESS: 200,
}

# Seats an agency may hold across all published offers. Not enforced anywhere
# yet — recorded here so the eventual limit lands in this file with the others
# rather than as a magic number in a handler.
SEAT_LIMITS = {
    Agency.FREE: None,
    Agency.PRO: None,
    Agency.BUSINESS: None,
}


class QuotaExceeded(Exception):
    """Mapped to 409 by the API. Not 403: the caller is entitled to do this,
    just not this many times, and the fix is a different action (unpublish
    something, or upgrade) rather than a different identity."""


def published_offer_limit(agency):
    """An explicit override beats the plan.

    The escape hatch is intentional and admin-only: a real marketplace always
    has one agency with a negotiated arrangement, and without a column for it
    somebody eventually edits the limits table for one tenant.
    """
    if agency.published_offer_limit_override is not None:
        return agency.published_offer_limit_override
    return PUBLISHED_OFFER_LIMITS.get(agency.plan, PUBLISHED_OFFER_LIMITS[Agency.FREE])


def published_offer_count(agency, exclude_pk=None):
    from apps.offers.models import Offer

    qs = Offer.objects.filter(agency=agency, status=Offer.PUBLISHED)
    if exclude_pk is not None:
        qs = qs.exclude(pk=exclude_pk)
    return qs.count()


def quota_state(agency):
    limit = published_offer_limit(agency)
    used = published_offer_count(agency)
    return {"plan": agency.plan, "limit": limit, "used": used, "remaining": max(limit - used, 0)}


def assert_can_publish(agency, exclude_pk=None):
    """Called before any transition *into* published — creating a published
    offer, or publishing a draft. Re-saving an already-published offer excludes
    itself, so editing a title never trips the quota."""
    limit = published_offer_limit(agency)
    if published_offer_count(agency, exclude_pk=exclude_pk) >= limit:
        raise QuotaExceeded(
            f"You have reached your published offer limit ({limit}). "
            "Archive an offer or change your plan."
        )
