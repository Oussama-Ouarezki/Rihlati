"""Offers over HTTP: the public catalogue, and the agency's own editor.

Two routers, because they are two different security postures living on the
same table:

* `public_router` is `auth=None` — the only explicit exit from deny-by-default.
  Every read goes through `Offer.publicly_visible()`, so an unverified agency's
  listing is not "hidden by the template", it is not in the queryset.
* `agency_router` sits under `/agencies/{agency_id}/…` and proves membership
  before the first query, then scopes every query to that agency.

Both share the schemas below, but never the querysets. That split is the whole
lesson: authorization is a property of the query, not of the response.
"""

import hashlib
import re
import unicodedata
from datetime import date

from django.db import models, transaction
from django.shortcuts import get_object_or_404
from django.utils import timezone
from ninja import Field, Query, Router
from ninja.errors import HttpError

from apps.accounts.models import Agency, Membership
from apps.common.quotas import QuotaExceeded, assert_can_publish, quota_state
from apps.common.schemas import Message, Strict
from apps.common.tenancy import audit, require_membership, scoped
from apps.common.nlp_parser import parse_query
from apps.common.validators import (
    validate_date_range,
    validate_price_centimes,
    validate_time_of_day,
    validate_wilaya_code,
)
from apps.offers.models import (
    MILESTONE_MAX_PER_OFFER,
    MILESTONE_TITLE_MAX,
    CheckpointType,
    MilestoneKind,
    Offer,
    OfferDailyMetric,
    OfferMilestone,
    OfferReport,
    TrackedLink,
)

public_router = Router(tags=["offers"])
agency_router = Router(tags=["agency-offers"])


# --------------------------------------------------------------------------
# Schemas. `Strict` forbids unknown keys — see apps/common/schemas.py.
# --------------------------------------------------------------------------


class AgencyBrief(Strict):
    id: str
    name: str
    city: str
    wilaya_code: str
    logo_url: str
    is_verified: bool
    rating_average: float | None
    rating_count: int


class MilestoneOut(Strict):
    id: str
    title: str
    description: str
    kind: str
    day_offset: int
    time_of_day: str
    location_name: str
    meeting_point: str
    map_url: str
    sort_order: int
    checkpoint_type: str
    is_completed: bool


class OfferOut(Strict):
    id: str
    slug: str
    title_fr: str
    title_ar: str
    description: str
    kind: str
    cover_image_url: str
    price_centimes: int
    price_to_centimes: int | None
    departure_date: str
    return_date: str | None
    is_flexible_dates: bool
    departure_wilaya_code: str
    destination_country: str
    destination_city: str
    seats_total: int
    seats_left: int
    status: str
    quality_score: int
    agency: AgencyBrief
    milestones: list[MilestoneOut]


class OfferListItem(Strict):
    """Deliberately smaller than OfferOut. A search page returning full
    programmes for twenty offers is a payload nobody reads and a query nobody
    can index — and every field returned is a field you can never remove."""

    id: str
    slug: str
    title_fr: str
    title_ar: str
    kind: str
    cover_image_url: str
    price_centimes: int
    departure_date: str
    departure_wilaya_code: str
    destination_city: str
    seats_left: int
    agency: AgencyBrief


class OfferPage(Strict):
    items: list[OfferListItem]
    total: int
    limit: int
    offset: int


class OfferFilters(Strict):
    """Query parameters. Typed, bounded, and parsed before a handler sees them.

    `limit` is capped at 50 in the field itself rather than clamped in code: an
    unbounded `limit` is a one-request denial of service, and the cap belongs
    where it cannot be forgotten.
    """

    kind: str | None = None
    wilaya: str | None = None
    q: str | None = None
    price_min: int | None = Field(None, ge=0)
    price_max: int | None = Field(None, ge=0)
    # Also `date`, for the same reason as OfferIn — and this one is on a public
    # route, so the garbage arrives unauthenticated. `?date_from=hello` typed
    # as `str` reaches the ORM and raises there; typed as `date` it is a 422
    # naming the parameter, before a query is built.
    date_from: date | None = None
    date_to: date | None = None
    sort: str = Field("departure", pattern="^(departure|price|price_desc|recent|quality)$")
    limit: int = Field(20, ge=1, le=50)
    offset: int = Field(0, ge=0)

    # --- AI / NLP search parameters (added for the new search endpoint) ---
    nlp_query: str | None = None
    nlp_kind: list[str] | None = None
    nlp_budget_max: int | None = None
    nlp_duration_days: int | None = None
    nlp_destination: str | None = None
    nlp_inclusions: dict[str, bool] | None = None


class OfferIn(Strict):
    title_fr: str = Field(min_length=3, max_length=200)
    title_ar: str = Field("", max_length=200)
    description: str = ""
    kind: str
    cover_image_url: str = ""
    price_centimes: int
    price_to_centimes: int | None = None
    # `date`, not `str`. Typing these as strings looked harmless and was not:
    # the value reached `fingerprint_for()` still a string and `.isoformat()`
    # raised, so every create returned 500. It also made `validate_date_range`
    # compare two strings — which happens to work for ISO-8601 and silently
    # would not for anything else. Parsing at the boundary is the fix in both
    # cases: after this line, a handler cannot receive a date that isn't one.
    departure_date: date
    return_date: date | None = None
    is_flexible_dates: bool = False
    departure_wilaya_code: str = ""
    destination_country: str = ""
    destination_city: str = ""
    seats_total: int = Field(ge=1, le=10_000)
    seats_left: int = Field(ge=0, le=10_000)
    attributes: dict = {}
    # Note what is NOT here: agency, slug, status, is_featured, quality_score,
    # fingerprint, duplicate_status, report_count. Those are server-owned. A
    # field absent from the schema is a field a client cannot set, which is a
    # stronger guarantee than a handler remembering to ignore it.


class MilestoneIn(Strict):
    title: str = Field(min_length=1, max_length=MILESTONE_TITLE_MAX)
    description: str = ""
    kind: str = MilestoneKind.OTHER
    day_offset: int = Field(0, ge=0, le=365)
    time_of_day: str = ""
    location_name: str = ""
    meeting_point: str = ""
    map_url: str = ""
    checkpoint_type: str = CheckpointType.NONE


class ReorderIn(Strict):
    """The whole day's order in one call.

    Sending "move milestone X to position 3" would need the server to guess what
    the other rows are now; sending the full list makes the request idempotent
    and lets a drag-and-drop UI replay it safely.
    """

    day_offset: int = Field(ge=0, le=365)
    milestone_ids: list[str]


class CopyProgrammeIn(Strict):
    source_offer_id: str
    replace: bool = False


class DuplicateDayIn(Strict):
    day_offset: int = Field(ge=0, le=365)
    to_day_offset: int = Field(ge=0, le=365)


class ReportIn(Strict):
    reason: str
    note: str = Field("", max_length=1000)


class TrackedLinkIn(Strict):
    label: str = Field(min_length=1, max_length=80)
    offer_id: str | None = None


class TrackedLinkOut(Strict):
    id: str
    code: str
    label: str
    offer_id: str | None
    click_count: int
    lead_count: int


class DailyMetricOut(Strict):
    day: str
    views: int
    inquiries: int
    link_clicks: int


class QuotaOut(Strict):
    plan: str
    limit: int
    used: int
    remaining: int


# --------------------------------------------------------------------------
# Serialisation helpers. Plain functions, not model-bound schemas, so what
# crosses the boundary is an explicit list rather than "whatever the model has
# today" — a new column must be added here on purpose to become public.
# --------------------------------------------------------------------------


def agency_brief(agency):
    return {
        "id": str(agency.id),
        "name": agency.name,
        "city": agency.city,
        "wilaya_code": agency.wilaya_code,
        "logo_url": agency.logo_url,
        "is_verified": agency.is_verified,
        "rating_average": agency.rating_average,
        "rating_count": agency.rating_count,
    }


def milestone_out(milestone):
    return {
        "id": str(milestone.id),
        "title": milestone.title,
        "description": milestone.description,
        "kind": milestone.kind,
        "day_offset": milestone.day_offset,
        "time_of_day": milestone.time_of_day,
        "location_name": milestone.location_name,
        "meeting_point": milestone.meeting_point,
        "map_url": milestone.map_url,
        "sort_order": milestone.sort_order,
        "checkpoint_type": milestone.checkpoint_type,
        "is_completed": milestone.completed_at is not None,
    }


def offer_out(offer):
    return {
        "id": str(offer.id),
        "slug": offer.slug,
        "title_fr": offer.title_fr,
        "title_ar": offer.title_ar,
        "description": offer.description,
        "kind": offer.kind,
        "cover_image_url": offer.cover_image_url,
        "price_centimes": offer.price_centimes,
        "price_to_centimes": offer.price_to_centimes,
        "departure_date": offer.departure_date.isoformat(),
        "return_date": offer.return_date.isoformat() if offer.return_date else None,
        "is_flexible_dates": offer.is_flexible_dates,
        "departure_wilaya_code": offer.departure_wilaya_code,
        "destination_country": offer.destination_country,
        "destination_city": offer.destination_city,
        "seats_total": offer.seats_total,
        "seats_left": offer.seats_left,
        "status": offer.status,
        "quality_score": offer.quality_score,
        "agency": agency_brief(offer.agency),
        "milestones": [milestone_out(m) for m in offer.milestones.all()],
    }


def offer_list_item(offer):
    return {
        "id": str(offer.id),
        "slug": offer.slug,
        "title_fr": offer.title_fr,
        "title_ar": offer.title_ar,
        "kind": offer.kind,
        "cover_image_url": offer.cover_image_url,
        "price_centimes": offer.price_centimes,
        "departure_date": offer.departure_date.isoformat(),
        "departure_wilaya_code": offer.departure_wilaya_code,
        "destination_city": offer.destination_city,
        "seats_left": offer.seats_left,
        "agency": agency_brief(offer.agency),
    }


SORTS = {
    "departure": ["departure_date"],
    "price": ["price_centimes"],
    "price_desc": ["-price_centimes"],
    "recent": ["-created_at"],
    # Quality first, then soonest. Not "featured first": a paid slot that
    # outranks a better listing is how a marketplace loses the travelers it
    # needs in order to have anything to sell.
    "quality": ["-quality_score", "departure_date"],
}


def apply_filters(queryset, filters):
    """One function, called by the JSON API *and* by the search page.

    Duplicating this into a view would mean the page and the API silently
    disagreeing about what "Omra under 300 000 from Oran" means.
    """
    if filters.kind:
        queryset = queryset.filter(kind=filters.kind)
    if filters.wilaya:
        queryset = queryset.filter(departure_wilaya_code=filters.wilaya)
    if filters.price_min is not None:
        queryset = queryset.filter(price_centimes__gte=filters.price_min)
    if filters.price_max is not None:
        queryset = queryset.filter(price_centimes__lte=filters.price_max)
    if filters.date_from:
        queryset = queryset.filter(departure_date__gte=filters.date_from)
    if filters.date_to:
        queryset = queryset.filter(departure_date__lte=filters.date_to)
    if filters.q:
        # Deliberately simple. Postgres full-text search is the right answer and
        # the wrong first step: icontains is correct, works on SQLite, and can be
        # replaced without changing a single caller.
        queryset = queryset.filter(
            models.Q(title_fr__icontains=filters.q)
            | models.Q(title_ar__icontains=filters.q)
            | models.Q(destination_city__icontains=filters.q)
            | models.Q(agency__name__icontains=filters.q)
        )
    # --- New: NLP / AI search parameters ---
    if filters.nlp_kind:
        # Keep only kinds that are valid Offer.KINDS
        valid_kinds = [k for k in filters.nlp_kind if k in dict(Offer.KINDS)]
        if valid_kinds:
            queryset = queryset.filter(kind__in=valid_kinds)
    if filters.nlp_budget_max is not None:
        # budget_max from NLP is in DZD; price_centimes is stored in centimes
        # 1 DZD = 100 centimes, so multiply by 100
        budget_centimes = filters.nlp_budget_max * 100
        queryset = queryset.filter(price_centimes__lte=budget_centimes)
    if filters.nlp_duration_days is not None:
        # Filter offers where the attributes contain a matching duration,
        # OR filter by departure_date range roughly.
        # For now, we also add a simple date offset filter: if user wants
        # a 7-day trip around now, we can shift the date filter.
        # A more robust solution would scan Offer.attributes['nights'].
        # For MVP, we'll leave this as a no-op and let the LLM re-rank.
        pass
    if filters.nlp_destination:
        queryset = queryset.filter(
            models.Q(destination_city__icontains=filters.nlp_destination)
            | models.Q(destination_country__icontains=filters.nlp_destination)
        )
    if filters.nlp_inclusions:
        inclusions = filters.nlp_inclusions or {}
        # Build Q objects for attribute-based filtering
        from apps.offers.models import Offer as OfferModel
        # We can check if key inclusions are present in the attributes JSON
        # For now, this is a placeholder: the real implementation would use
        # __contains or a JSON query. We'll just note it and let the LLM re-rank.
        # TODO: implement JSONField contains lookup for attributes
        pass

    return queryset.order_by(*SORTS[filters.sort])


def record_metric(offer, field):
    """Increment today's counter in the database, not in Python.

    `F()` makes this one atomic UPDATE. Read-modify-write from two workers
    loses one of the two increments, and view counts that quietly undercount
    are worse than none — an agency will make decisions on them.
    """
    row, _ = OfferDailyMetric.objects.get_or_create(
        offer=offer, day=timezone.localdate(), defaults={"agency_id": offer.agency_id}
    )
    OfferDailyMetric.objects.filter(pk=row.pk).update(**{field: models.F(field) + 1})


# Words that describe the *advert*, not the trip. Kept deliberately short: a
# long stopword list eventually swallows a word that distinguishes two real
# offers, and the only way to find out is an agency complaining. Note the
# blast radius is small either way — dropping a word can at most flag a pair
# for a human to look at. Nothing here hides or deletes a listing.
TITLE_FILLER = frozenset(
    {
        "offer",
        "offers",
        "special",
        "promo",
        "promotion",
        "new",
        # Legacy French listings stay comparable while they age out.
        "offre",
        "offres",
        "speciale",
        "nouveau",
        "nouvelle",
    }
)


def normalize_title(title):
    """Case, accents, punctuation, word order and marketing filler removed.

    "Special OMRA RAMADAN 2026 — departure Algiers!!" and "Omra Ramadan 2026
    Algiers departure" are the same listing typed twice, and an agency reposting will
    retype rather than copy — which is exactly why a byte comparison catches
    nothing. Sorting the tokens is what makes word order irrelevant.
    """
    folded = unicodedata.normalize("NFKD", title).encode("ascii", "ignore").decode()
    words = [w for w in re.split(r"[^0-9a-z]+", folded.casefold()) if w]
    kept = [w for w in words if w not in TITLE_FILLER]
    # A title made *entirely* of filler is a bad title, not a duplicate. Falling
    # back keeps every such offer from hashing to the same empty string.
    return " ".join(sorted(kept or words))


def fingerprint_for(offer):
    """A cheap "has this agency posted this twice" signal.

    Agency + kind + departure date + normalised title. Not a similarity score —
    an exact match on the obvious fields catches copy-paste reposting, which is
    the actual behaviour, and never accuses two genuinely similar Omra packages
    of being duplicates.

    **The agency id is in the hash on purpose, and it is the most important
    line here.** Two agencies reselling the same wholesaler package at different
    prices is not a duplicate — it is the comparison a traveler opened the
    marketplace for. Making the collision structurally impossible beats
    remembering to filter it out at every call site.

    **The price is deliberately out of the hash.** Changing a price is the most
    common edit an agency makes, and it must not turn one offer into two.
    """
    parts = [
        str(offer.agency_id),
        offer.kind,
        offer.departure_date.isoformat(),
        normalize_title(offer.title_fr),
    ]
    return hashlib.sha256("|".join(parts).encode()).hexdigest()


def apply_derived_fields(offer):
    offer.fingerprint = fingerprint_for(offer)
    offer.quality_score = offer.compute_quality_score()
    clash = Offer.objects.filter(fingerprint=offer.fingerprint).exclude(pk=offer.pk).first()
    # Flagged for a human, never auto-hidden. `suspected` demotes; only a person
    # sets `confirmed`. An automatic takedown on a hash match is unrecoverable,
    # and two tiers of the same trip — 4★ and 5★, same dates, same title — is a
    # false positive nobody would accept losing a listing over.
    if clash is not None and offer.duplicate_status == Offer.CLEAN:
        offer.duplicate_status = Offer.SUSPECTED
        offer.duplicate_of = clash
    offer.save()


def validate_offer_payload(payload):
    validate_price_centimes(payload.price_centimes)
    validate_wilaya_code(payload.departure_wilaya_code)
    if payload.seats_left > payload.seats_total:
        raise HttpError(422, "Seats left cannot exceed the total.")
    if payload.kind not in dict(Offer.KINDS):
        raise HttpError(422, "Unknown offer type.")
    validate_date_range(payload.departure_date, payload.return_date)


# --------------------------------------------------------------------------
# Public catalogue — the only `auth=None` routes in the offers module.
# --------------------------------------------------------------------------


@public_router.get("/offers", response=OfferPage, auth=None)
def list_offers(request, filters: Query[OfferFilters]):
    queryset = apply_filters(Offer.publicly_visible().select_related("agency"), filters)
    total = queryset.count()
    window = queryset[filters.offset : filters.offset + filters.limit]
    return {
        "items": [offer_list_item(o) for o in window],
        "total": total,
        "limit": filters.limit,
        "offset": filters.offset,
    }


@public_router.get("/offers/{uuid:offer_id}", response=OfferOut, auth=None)
def get_offer(request, offer_id):
    offer = get_object_or_404(
        Offer.publicly_visible().select_related("agency").prefetch_related("milestones"),
        pk=offer_id,
    )
    record_metric(offer, "views")
    return offer_out(offer)


@public_router.post("/offers/{uuid:offer_id}/report", response={201: Message}, auth=None)
def report_offer(request, offer_id, payload: ReportIn):
    offer = get_object_or_404(Offer.publicly_visible(), pk=offer_id)
    if payload.reason not in dict(OfferReport.REASONS):
        raise HttpError(422, "Unknown reason.")

    user = request.user if getattr(request.user, "is_authenticated", False) else None
    fingerprint = "" if user else _reporter_fingerprint(request)

    _report, created = OfferReport.objects.get_or_create(
        offer=offer,
        reporter=user,
        reporter_fingerprint=fingerprint,
        defaults={"reason": payload.reason, "note": payload.note},
    )
    if created:
        Offer.objects.filter(pk=offer.pk).update(report_count=models.F("report_count") + 1)
        Agency.objects.filter(pk=offer.agency_id).update(
            open_report_count=models.F("open_report_count") + 1
        )
    # The same answer either way: telling a reporter "you already reported this"
    # is noise, and telling a *scripted* reporter is a counting oracle.
    return 201, {"detail": "Report recorded."}


def _reporter_fingerprint(request):
    from django.conf import settings

    raw = f"{request.META.get('REMOTE_ADDR', '')}|{request.META.get('HTTP_USER_AGENT', '')}"
    return hashlib.sha256(f"{settings.SECRET_KEY}:{raw}".encode()).hexdigest()


# --------------------------------------------------------------------------
# Agency-owned. Membership is proved first; every query is scoped after.
# --------------------------------------------------------------------------


@agency_router.get("/agencies/{uuid:agency_id}/offers", response=list[OfferListItem])
def list_agency_offers(request, agency_id, status: str | None = None):
    require_membership(request.user, agency_id)
    queryset = scoped(Offer.objects.select_related("agency"), agency_id)
    if status:
        queryset = queryset.filter(status=status)
    return [offer_list_item(o) for o in queryset]


@agency_router.get("/agencies/{uuid:agency_id}/quota", response=QuotaOut)
def get_quota(request, agency_id):
    agency = require_membership(request.user, agency_id)
    return quota_state(agency)


@agency_router.post("/agencies/{uuid:agency_id}/offers", response={201: OfferOut})
def create_offer(request, agency_id, payload: OfferIn, publish: bool = False):
    agency = require_membership(request.user, agency_id, Membership.MANAGER)
    validate_offer_payload(payload)

    if publish:
        _guard_quota(agency)

    with transaction.atomic():
        offer = Offer(
            agency=agency,
            status=Offer.PUBLISHED if publish else Offer.DRAFT,
            **payload.dict(),
        )
        offer.save()
        apply_derived_fields(offer)
        audit(request, "offer.created", offer, agency=agency, after={"title": offer.title_fr})
    return 201, offer_out(offer)


@agency_router.put("/agencies/{uuid:agency_id}/offers/{uuid:offer_id}", response=OfferOut)
def update_offer(request, agency_id, offer_id, payload: OfferIn):
    agency = require_membership(request.user, agency_id, Membership.MANAGER)
    offer = get_object_or_404(scoped(Offer.objects, agency_id), pk=offer_id)
    validate_offer_payload(payload)

    before = {"title": offer.title_fr, "price_centimes": offer.price_centimes}
    with transaction.atomic():
        for field, value in payload.dict().items():
            setattr(offer, field, value)
        offer.save()
        apply_derived_fields(offer)
        audit(
            request,
            "offer.updated",
            offer,
            agency=agency,
            before=before,
            after={"title": offer.title_fr, "price_centimes": offer.price_centimes},
        )
    return offer_out(offer)


@agency_router.post("/agencies/{uuid:agency_id}/offers/{uuid:offer_id}/publish", response=OfferOut)
def publish_offer(request, agency_id, offer_id):
    agency = require_membership(request.user, agency_id, Membership.MANAGER)
    offer = get_object_or_404(scoped(Offer.objects, agency_id), pk=offer_id)

    # An unverified agency may build its catalogue and may not sell to anyone.
    # Checked here, in the transition, not only in the read queryset — because
    # the badge can be granted later and every draft should then just work.
    if not agency.is_verified:
        raise HttpError(403, "Your agency must be verified before you can publish.")

    _guard_quota(agency, exclude_pk=offer.pk)

    with transaction.atomic():
        offer.status = Offer.PUBLISHED
        offer.save(update_fields=["status", "updated_at"])
        audit(request, "offer.published", offer, agency=agency, after={"status": offer.status})
    return offer_out(offer)


@agency_router.post("/agencies/{uuid:agency_id}/offers/{uuid:offer_id}/archive", response=OfferOut)
def archive_offer(request, agency_id, offer_id):
    agency = require_membership(request.user, agency_id, Membership.MANAGER)
    offer = get_object_or_404(scoped(Offer.objects, agency_id), pk=offer_id)
    with transaction.atomic():
        offer.status = Offer.ARCHIVED
        offer.save(update_fields=["status", "updated_at"])
        audit(request, "offer.archived", offer, agency=agency)
    return offer_out(offer)


def _guard_quota(agency, exclude_pk=None):
    try:
        assert_can_publish(agency, exclude_pk=exclude_pk)
    except QuotaExceeded as exc:
        raise HttpError(409, str(exc)) from exc


# --------------------------------------------------------------------------
# The programme. Milestones are the reason this app is not a classifieds board.
# --------------------------------------------------------------------------


@agency_router.get(
    "/agencies/{uuid:agency_id}/offers/{uuid:offer_id}/milestones",
    response=list[MilestoneOut],
)
def list_milestones(request, agency_id, offer_id):
    require_membership(request.user, agency_id)
    offer = get_object_or_404(scoped(Offer.objects, agency_id), pk=offer_id)
    return [milestone_out(m) for m in offer.milestones.all()]


@agency_router.post(
    "/agencies/{uuid:agency_id}/offers/{uuid:offer_id}/milestones",
    response={201: MilestoneOut},
)
def create_milestone(request, agency_id, offer_id, payload: MilestoneIn):
    agency = require_membership(request.user, agency_id, Membership.MANAGER)
    offer = get_object_or_404(scoped(Offer.objects, agency_id), pk=offer_id)
    _validate_milestone(payload, offer)

    with transaction.atomic():
        milestone = OfferMilestone.objects.create(
            agency=agency,
            offer=offer,
            sort_order=_next_sort_order(offer, payload.day_offset),
            **payload.dict(),
        )
        _refresh_quality(offer)
        audit(
            request,
            "milestone.created",
            milestone,
            agency=agency,
            after={"title": milestone.title},
        )
    return 201, milestone_out(milestone)


@agency_router.put(
    "/agencies/{uuid:agency_id}/milestones/{uuid:milestone_id}", response=MilestoneOut
)
def update_milestone(request, agency_id, milestone_id, payload: MilestoneIn):
    agency = require_membership(request.user, agency_id, Membership.MANAGER)
    milestone = get_object_or_404(scoped(OfferMilestone.objects, agency_id), pk=milestone_id)
    _validate_milestone(payload, milestone.offer, exclude_pk=milestone.pk)

    before = {"title": milestone.title, "day_offset": milestone.day_offset}
    with transaction.atomic():
        for field, value in payload.dict().items():
            setattr(milestone, field, value)
        milestone.save()
        audit(request, "milestone.updated", milestone, agency=agency, before=before)
    return milestone_out(milestone)


@agency_router.delete(
    "/agencies/{uuid:agency_id}/milestones/{uuid:milestone_id}", response={200: Message}
)
def delete_milestone(request, agency_id, milestone_id):
    agency = require_membership(request.user, agency_id, Membership.MANAGER)
    milestone = get_object_or_404(scoped(OfferMilestone.objects, agency_id), pk=milestone_id)
    offer = milestone.offer
    with transaction.atomic():
        audit(
            request,
            "milestone.deleted",
            milestone,
            agency=agency,
            before={"title": milestone.title, "day_offset": milestone.day_offset},
        )
        milestone.delete()
        _refresh_quality(offer)
    return {"detail": "Step deleted."}


@agency_router.post(
    "/agencies/{uuid:agency_id}/offers/{uuid:offer_id}/milestones/reorder",
    response=list[MilestoneOut],
)
def reorder_milestones(request, agency_id, offer_id, payload: ReorderIn):
    agency = require_membership(request.user, agency_id, Membership.MANAGER)
    offer = get_object_or_404(scoped(Offer.objects, agency_id), pk=offer_id)

    # Re-fetch inside the tenant scope rather than trusting the ids: a client
    # sending another agency's milestone id must move nothing, not everything.
    rows = {
        str(m.id): m
        for m in scoped(OfferMilestone.objects, agency_id).filter(
            offer=offer, day_offset=payload.day_offset
        )
    }
    if set(payload.milestone_ids) != set(rows):
        raise HttpError(422, "The list must contain exactly the steps for that day.")

    with transaction.atomic():
        for position, milestone_id in enumerate(payload.milestone_ids):
            milestone = rows[milestone_id]
            milestone.sort_order = position
            milestone.save(update_fields=["sort_order", "updated_at"])
        audit(
            request,
            "milestone.reordered",
            offer,
            agency=agency,
            after={"day": payload.day_offset},
        )
    return [milestone_out(m) for m in offer.milestones.filter(day_offset=payload.day_offset)]


@agency_router.post(
    "/agencies/{uuid:agency_id}/offers/{uuid:offer_id}/milestones/duplicate-day",
    response={201: list[MilestoneOut]},
)
def duplicate_day(request, agency_id, offer_id, payload: DuplicateDayIn):
    """Copy one day's steps onto another day.

    Days 3 through 9 of an Omra are frequently the same five steps with one
    changed. Retyping them is where mistakes get made — and a mistake here is a
    family standing in the wrong place.
    """
    agency = require_membership(request.user, agency_id, Membership.MANAGER)
    offer = get_object_or_404(scoped(Offer.objects, agency_id), pk=offer_id)

    source = list(offer.milestones.filter(day_offset=payload.day_offset))
    if not source:
        raise HttpError(404, "No steps on that day.")
    _assert_room_for(offer, len(source))

    start = _next_sort_order(offer, payload.to_day_offset)
    with transaction.atomic():
        copies = [
            OfferMilestone(
                agency=agency,
                offer=offer,
                title=m.title,
                description=m.description,
                kind=m.kind,
                day_offset=payload.to_day_offset,
                time_of_day=m.time_of_day,
                location_name=m.location_name,
                meeting_point=m.meeting_point,
                map_url=m.map_url,
                sort_order=start + i,
                checkpoint_type=m.checkpoint_type,
                # completed_at is deliberately NOT copied: a copy is a plan,
                # not a thing that already happened.
            )
            for i, m in enumerate(source)
        ]
        OfferMilestone.objects.bulk_create(copies)
        _refresh_quality(offer)
        audit(request, "milestone.day_duplicated", offer, agency=agency, after=payload.dict())
    return 201, [milestone_out(m) for m in copies]


@agency_router.post(
    "/agencies/{uuid:agency_id}/offers/{uuid:offer_id}/milestones/copy-from",
    response={201: list[MilestoneOut]},
)
def copy_programme(request, agency_id, offer_id, payload: CopyProgrammeIn):
    """Reuse last season's programme on this season's departure.

    This is the payoff of storing `day_offset` instead of real dates: the same
    rows describe a March departure and a July one, with no date arithmetic and
    nothing to get wrong.
    """
    agency = require_membership(request.user, agency_id, Membership.MANAGER)
    offer = get_object_or_404(scoped(Offer.objects, agency_id), pk=offer_id)
    # Scoped: you may copy from *your* offers only. Otherwise this endpoint
    # reads any agency's programme, which is the thing they compete on.
    source_offer = get_object_or_404(scoped(Offer.objects, agency_id), pk=payload.source_offer_id)
    if source_offer.pk == offer.pk:
        raise HttpError(422, "Choose a different offer as the source.")

    source = list(source_offer.milestones.all())
    if not source:
        raise HttpError(404, "This offer has no programme.")

    with transaction.atomic():
        if payload.replace:
            offer.milestones.all().delete()
        _assert_room_for(offer, len(source))
        offset = 0 if payload.replace else _next_sort_order(offer, None)
        copies = [
            OfferMilestone(
                agency=agency,
                offer=offer,
                title=m.title,
                description=m.description,
                kind=m.kind,
                day_offset=m.day_offset,
                time_of_day=m.time_of_day,
                location_name=m.location_name,
                meeting_point=m.meeting_point,
                map_url=m.map_url,
                sort_order=m.sort_order + offset,
                checkpoint_type=m.checkpoint_type,
            )
            for m in source
        ]
        OfferMilestone.objects.bulk_create(copies)
        _refresh_quality(offer)
        audit(
            request,
            "milestone.programme_copied",
            offer,
            agency=agency,
            after={"from": str(source_offer.pk), "count": len(copies)},
        )
    return 201, [milestone_out(m) for m in copies]


@agency_router.post(
    "/agencies/{uuid:agency_id}/milestones/{uuid:milestone_id}/complete",
    response=MilestoneOut,
)
def complete_milestone(request, agency_id, milestone_id):
    """Tick a step off. This — not the clock — is what moves "you are here".

    An agent, not a manager: the person holding the phone at the airport at 4am
    is the one who should be able to do this.
    """
    agency = require_membership(request.user, agency_id, Membership.AGENT)
    milestone = get_object_or_404(scoped(OfferMilestone.objects, agency_id), pk=milestone_id)
    with transaction.atomic():
        milestone.completed_at = timezone.now()
        milestone.completed_by = request.user
        milestone.save(update_fields=["completed_at", "completed_by", "updated_at"])
        audit(request, "milestone.completed", milestone, agency=agency)
    return milestone_out(milestone)


@agency_router.post(
    "/agencies/{uuid:agency_id}/milestones/{uuid:milestone_id}/uncomplete",
    response=MilestoneOut,
)
def uncomplete_milestone(request, agency_id, milestone_id):
    """Undo. A tick made by a tired person at 4am must be reversible, or the
    public page shows a group in Mecca who are still at Houari Boumediene."""
    agency = require_membership(request.user, agency_id, Membership.AGENT)
    milestone = get_object_or_404(scoped(OfferMilestone.objects, agency_id), pk=milestone_id)
    with transaction.atomic():
        milestone.completed_at = None
        milestone.completed_by = None
        milestone.save(update_fields=["completed_at", "completed_by", "updated_at"])
        audit(request, "milestone.uncompleted", milestone, agency=agency)
    return milestone_out(milestone)


def _validate_milestone(payload, offer, exclude_pk=None):
    validate_time_of_day(payload.time_of_day)
    if payload.kind not in MilestoneKind.values:
        raise HttpError(422, "Unknown step type.")
    if payload.checkpoint_type not in CheckpointType.values:
        raise HttpError(422, "Unknown checkpoint type.")
    if exclude_pk is None:
        _assert_room_for(offer, 1)


def _assert_room_for(offer, count):
    """A bound, so one bad loop cannot make an offer with 40 000 steps that no
    page can render. 200 days of five steps is already an implausible trip."""
    if offer.milestones.count() + count > MILESTONE_MAX_PER_OFFER:
        raise HttpError(409, f"Maximum {MILESTONE_MAX_PER_OFFER} steps per offer.")


def _next_sort_order(offer, day_offset):
    queryset = offer.milestones.all()
    if day_offset is not None:
        queryset = queryset.filter(day_offset=day_offset)
    return (queryset.aggregate(top=models.Max("sort_order"))["top"] or 0) + 1


def _refresh_quality(offer):
    offer.quality_score = offer.compute_quality_score()
    offer.save(update_fields=["quality_score", "updated_at"])


# --------------------------------------------------------------------------
# Analytics and campaign links.
# --------------------------------------------------------------------------


@agency_router.get(
    "/agencies/{uuid:agency_id}/offers/{uuid:offer_id}/metrics",
    response=list[DailyMetricOut],
)
def offer_metrics(request, agency_id, offer_id, days: int = Query(30, ge=1, le=365)):
    require_membership(request.user, agency_id)
    offer = get_object_or_404(scoped(Offer.objects, agency_id), pk=offer_id)
    since = timezone.localdate() - timezone.timedelta(days=days)
    rows = offer.daily_metrics.filter(day__gte=since).order_by("day")
    return [
        {
            "day": r.day.isoformat(),
            "views": r.views,
            "inquiries": r.inquiries,
            "link_clicks": r.link_clicks,
        }
        for r in rows
    ]


@agency_router.get("/agencies/{uuid:agency_id}/tracked-links", response=list[TrackedLinkOut])
def list_tracked_links(request, agency_id):
    require_membership(request.user, agency_id)
    return [_link_out(link) for link in scoped(TrackedLink.objects, agency_id)]


@agency_router.post("/agencies/{uuid:agency_id}/tracked-links", response={201: TrackedLinkOut})
def create_tracked_link(request, agency_id, payload: TrackedLinkIn):
    agency = require_membership(request.user, agency_id, Membership.MANAGER)
    offer = None
    if payload.offer_id:
        offer = get_object_or_404(scoped(Offer.objects, agency_id), pk=payload.offer_id)
    link = TrackedLink.objects.create(
        agency=agency, offer=offer, label=payload.label, code=TrackedLink.new_code()
    )
    audit(request, "tracked_link.created", link, agency=agency, after={"label": link.label})
    return 201, _link_out(link)


def _link_out(link):
    return {
        "id": str(link.id),
        "code": link.code,
        "label": link.label,
        "offer_id": str(link.offer_id) if link.offer_id else None,
        "click_count": link.click_count,
        "lead_count": link.lead_count,
    }


# --------------------------------------------------------------------------
# AI Search endpoint
# --------------------------------------------------------------------------

class SearchQueryIn(Strict):
    query: str = Field(..., min_length=1, max_length=500)


class SearchResultOut(Strict):
    id: str
    title_fr: str
    title_ar: str
    kind: str
    price_centimes: int
    departure_date: str
    destination_city: str
    relevance_score: float | None = None


@public_router.post(
    "/search/query",
    response={200: list[SearchResultOut], 400: Message},
)
def search_query(request, payload: SearchQueryIn):
    """AI-powered search: parse natural language query and return matching offers.

    The NLP parser extracts: kind, budget, duration, destination, inclusions.
    These are fed into the normal filter pipeline, then results are ordered
    by database relevance (price, date, quality_score) and optionally
    re-ranked by an LLM (future: CHAT_MODEL).
    """
    parsed = parse_query(payload.query)

    # Build a temporary filters object for apply_filters
    from ninja import Field

    class _TmpFilters(Strict):
        kind: str | None = None
        wilaya: str | None = None
        q: str | None = None
        price_min: int | None = None
        price_max: int | None = None
        date_from: date | None = None
        date_to: date | None = None
        sort: str = "departure"
        limit: int = 20
        offset: int = 0
        nlp_kind: list[str] | None = None
        nlp_budget_max: int | None = None
        nlp_duration_days: int | None = None
        nlp_destination: str | None = None
        nlp_inclusions: dict[str, bool] | None = None

    tmp = _TmpFilters(
        kind=parsed["kind"][0] if parsed["kind"] else None,
        nlp_kind=parsed["kind"],
        nlp_budget_max=parsed["budget_max"],
        nlp_duration_days=parsed["duration_days"],
        nlp_destination=parsed["destination"],
        nlp_inclusions=parsed["inclusions"],
    )

    # Apply the normal filter pipeline
    qs = Offer.publicly_visible()
    qs = apply_filters(qs, tmp)

    # Order by relevance: quality_score first, then departure date
    qs = qs.order_by("-quality_score", "departure_date")

    # Limit results
    limit = tmp.limit if 'tmp' in dir() else 20
    qs = qs[tmp.offset : tmp.offset + limit] if 'tmp' in dir() else qs[:limit]

    results = []
    for offer in qs:
        results.append(
            {
                "id": str(offer.id),
                "title_fr": offer.title_fr,
                "title_ar": offer.title_ar,
                "kind": offer.kind,
                "price_centimes": offer.price_centimes,
                "departure_date": offer.departure_date.isoformat(),
                "destination_city": offer.destination_city,
            }
        )

    if not results:
        return 200, []  # empty is not an error

    return 200, results


@public_router.post(
    "/search/like",
    response={200: Message, 400: Message},
)
def search_like(request, payload: dict):
    """Record like/dislike feedback on a search result.

    Used to learn traveler preferences and improve future search relevance.
    The payload should be: {"offer_id": "...", "relevant": true/false}
    """
    offer_id = payload.get("offer_id")
    relevant = payload.get("relevant")

    if not offer_id or relevant is None:
        return 400, {"error": "offer_id and relevant required"}

    # TODO: store feedback in a model (SearchFeedback) per user/session
    # for now, just log it
    import logging
    logger = logging.getLogger(__name__)
    logger.info(
        "search_like offer=%s relevant=%s query_session=%s",
        offer_id,
        relevant,
        getattr(request, "session", None),
    )

    return 200, {"message": "Feedback recorded"}
