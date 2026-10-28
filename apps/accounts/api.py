"""Accounts: signing in, and the agency verification workflow.

Two things live here that look unrelated and are not. Verification is what the
badge on an offer card *means*, and the badge is the only reason a traveler
sends their phone number to a stranger. So the queue below is not admin
plumbing — it is the product.
"""

from django.contrib.auth import authenticate
from django.db import transaction
from django.shortcuts import get_object_or_404
from django.utils import timezone
from ninja import Field, Router
from ninja.errors import HttpError

from apps.accounts.models import Agency, AuditLog, Membership, User
from apps.common.auth import (
    issue_access_token,
    issue_refresh_token,
    revoke_all_for_user,
    rotate_refresh_token,
)
from apps.common.schemas import Message, Strict
from apps.common.tenancy import audit, refuse_self_review, require_membership
from apps.common.throttling import LoginThrottle, RefreshThrottle
from apps.common.validators import validate_dz_phone, validate_wilaya_code

router = Router(tags=["accounts"])
admin_router = Router(tags=["admin"])


class LoginIn(Strict):
    username: str
    password: str


class TokenOut(Strict):
    access_token: str
    refresh_token: str
    expires_in: int


class RefreshIn(Strict):
    refresh_token: str


class MembershipOut(Strict):
    agency_id: str
    agency_name: str
    agency_status: str
    role: str


class MeOut(Strict):
    id: str
    username: str
    email: str
    preferred_language: str
    is_staff: bool
    memberships: list[MembershipOut]


class AgencyProfileIn(Strict):
    name: str = Field(min_length=2, max_length=200)
    description: str = ""
    city: str = Field(max_length=100)
    wilaya_code: str = ""
    phone: str = ""
    whatsapp: str = ""
    email: str = ""
    website_url: str = ""
    logo_url: str = ""
    # Absent on purpose: status, plan, credit_balance_centimes, ratings. An
    # agency that could PATCH its own `status` would verify itself.


class VerificationIn(Strict):
    registre_commerce: str = Field(min_length=3, max_length=50)
    nif: str = Field(min_length=3, max_length=50)
    tourism_licence: str = Field("", max_length=50)


class DecisionIn(Strict):
    approve: bool
    # Required either way. Approving without saying what you checked produces a
    # badge nobody can defend when it turns out to be wrong.
    note: str = Field(min_length=5, max_length=2000)
    rejection_reason: str = Field("", max_length=2000)


class AgencyOut(Strict):
    id: str
    name: str
    slug: str
    description: str
    city: str
    wilaya_code: str
    phone: str
    whatsapp: str
    email: str
    website_url: str
    logo_url: str
    status: str
    is_verified: bool
    plan: str
    rating_average: float | None
    rating_count: int
    submitted_for_review_at: str | None
    decided_at: str | None
    rejection_reason: str


class AuditOut(Strict):
    id: str
    action: str
    entity_type: str
    entity_id: str | None
    actor_id: str | None
    request_id: str
    before: dict
    after: dict
    created_at: str


def agency_out(agency):
    return {
        "id": str(agency.id),
        "name": agency.name,
        "slug": agency.slug,
        "description": agency.description,
        "city": agency.city,
        "wilaya_code": agency.wilaya_code,
        "phone": agency.phone,
        "whatsapp": agency.whatsapp,
        "email": agency.email,
        "website_url": agency.website_url,
        "logo_url": agency.logo_url,
        "status": agency.status,
        "is_verified": agency.is_verified,
        "plan": agency.plan,
        "rating_average": agency.rating_average,
        "rating_count": agency.rating_count,
        "submitted_for_review_at": (
            agency.submitted_for_review_at.isoformat() if agency.submitted_for_review_at else None
        ),
        "decided_at": agency.decided_at.isoformat() if agency.decided_at else None,
        "rejection_reason": agency.rejection_reason,
    }


# --------------------------------------------------------------------------
# Auth. The only routes in the whole API that may be called by a stranger with
# a payload they chose — hence the deliberately vague failure below.
# --------------------------------------------------------------------------


@router.post("/auth/login", response=TokenOut, auth=None, throttle=[LoginThrottle()])
def login(request, payload: LoginIn):
    user = authenticate(request, username=payload.username, password=payload.password)
    if user is None:
        # One message for "no such user" and "wrong password". Distinguishing
        # them is a free account-enumeration oracle, and knowing an address is
        # registered is half of a phishing email.
        raise HttpError(401, "Invalid credentials.")
    return {
        "access_token": issue_access_token(user),
        "refresh_token": issue_refresh_token(user),
        "expires_in": 15 * 60,
    }


@router.post("/auth/refresh", response=TokenOut, auth=None, throttle=[RefreshThrottle()])
def refresh(request, payload: RefreshIn):
    result = rotate_refresh_token(payload.refresh_token)
    if result is None:
        raise HttpError(401, "Session expired, please sign in again.")
    user, new_refresh = result
    return {
        "access_token": issue_access_token(user),
        "refresh_token": new_refresh,
        "expires_in": 15 * 60,
    }


@router.post("/auth/logout", response=Message)
def logout(request):
    """Revokes every refresh token, not just the one presented.

    "Log out" on a device the user is worried about should mean "log out", and
    a partial logout that leaves a stolen token alive is worse than none —
    because they will believe they are safe.
    """
    revoke_all_for_user(request.user)
    return {"detail": "Signed out."}


@router.get("/me", response=MeOut)
def me(request):
    memberships = (
        Membership.objects.filter(user=request.user)
        .select_related("agency")
        .order_by("agency__name")
    )
    return {
        "id": str(request.user.id),
        "username": request.user.username,
        "email": request.user.email,
        "preferred_language": request.user.preferred_language,
        "is_staff": request.user.is_staff,
        "memberships": [
            {
                "agency_id": str(m.agency_id),
                "agency_name": m.agency.name,
                "agency_status": m.agency.status,
                "role": m.role,
            }
            for m in memberships
        ],
    }


# --------------------------------------------------------------------------
# The agency's own profile, and its application for the badge.
# --------------------------------------------------------------------------


@router.get("/agencies/{uuid:agency_id}", response=AgencyOut)
def get_agency_profile(request, agency_id):
    agency = require_membership(request.user, agency_id)
    return agency_out(agency)


@router.put("/agencies/{uuid:agency_id}", response=AgencyOut)
def update_agency_profile(request, agency_id, payload: AgencyProfileIn):
    agency = require_membership(request.user, agency_id, Membership.OWNER)
    validate_wilaya_code(payload.wilaya_code)
    for field in ("phone", "whatsapp"):
        value = getattr(payload, field)
        if value:
            validate_dz_phone(value)

    before = {"name": agency.name, "city": agency.city}
    with transaction.atomic():
        for field, value in payload.dict().items():
            setattr(agency, field, value)
        agency.save()
        audit(request, "agency.updated", agency, agency=agency, before=before)
    return agency_out(agency)


@router.post("/agencies/{uuid:agency_id}/submit-for-review", response=AgencyOut)
def submit_for_review(request, agency_id, payload: VerificationIn):
    """The agency hands over its registration numbers and joins the queue.

    Owner only: this is a legal declaration about the company, and an agent
    hired last week should not be able to make it.
    """
    agency = require_membership(request.user, agency_id, Membership.OWNER)
    if not agency.can_transition_to(Agency.PENDING):
        raise HttpError(409, f"Not possible from the “{agency.get_status_display()}” state.")

    with transaction.atomic():
        agency.registre_commerce = payload.registre_commerce
        agency.nif = payload.nif
        agency.tourism_licence = payload.tourism_licence
        agency.status = Agency.PENDING
        # Set once per submission, and kept after the decision: it is how you
        # answer "how long did we make them wait?" honestly.
        agency.submitted_for_review_at = timezone.now()
        agency.rejection_reason = ""
        agency.save()
        audit(
            request,
            "agency.submitted_for_review",
            agency,
            agency=agency,
            after={"status": agency.status},
        )
    return agency_out(agency)


# --------------------------------------------------------------------------
# The review queue. Staff only — and `is_staff` is read from the database on
# every request, never from a token claim.
# --------------------------------------------------------------------------


def require_staff(request):
    if not request.user.is_staff:
        raise HttpError(403, "Reserved for the Rihlati team.")
    return request.user


@admin_router.get("/admin/verification-queue", response=list[AgencyOut])
def verification_queue(request):
    require_staff(request)
    # Oldest submission first. Not newest, not alphabetical: a queue that is not
    # FIFO quietly means whoever complains loudest gets reviewed first.
    queue = Agency.objects.filter(status=Agency.PENDING).order_by("submitted_for_review_at")
    return [agency_out(a) for a in queue]


@admin_router.post("/admin/agencies/{uuid:agency_id}/decision", response=AgencyOut)
def decide(request, agency_id, payload: DecisionIn):
    require_staff(request)
    agency = get_object_or_404(Agency, pk=agency_id)
    refuse_self_review(request.user, agency)
    target = Agency.VERIFIED if payload.approve else Agency.REJECTED
    if not agency.can_transition_to(target):
        raise HttpError(409, "This status transition is not allowed.")
    if not payload.approve and not payload.rejection_reason:
        # The owner reads this verbatim. "Rejected." with no reason produces a
        # support ticket, a resubmission of the same file, and a lost agency.
        raise HttpError(422, "A rejection reason is required.")

    before = {"status": agency.status}
    with transaction.atomic():
        agency.status = target
        agency.decided_at = timezone.now()
        agency.decided_by = request.user
        agency.decision_note = payload.note
        agency.rejection_reason = "" if payload.approve else payload.rejection_reason
        agency.save()
        # The name attached to the decision. Whoever grants a badge is on the
        # record for it, forever — that is what makes the badge worth anything.
        audit(
            request,
            "agency.verified" if payload.approve else "agency.rejected",
            agency,
            agency=agency,
            before=before,
            after={"status": agency.status, "by": request.user.username},
        )
    return agency_out(agency)


@admin_router.post("/admin/agencies/{uuid:agency_id}/suspend", response=AgencyOut)
def suspend(request, agency_id, payload: DecisionIn):
    """Pulls a verified agency's listings out of search immediately.

    Suspension, not deletion: the leads, the reservations and the audit trail
    all have to survive, because a suspension is frequently the beginning of a
    dispute rather than the end of one.
    """
    require_staff(request)
    agency = get_object_or_404(Agency, pk=agency_id)
    refuse_self_review(request.user, agency)
    if not agency.can_transition_to(Agency.SUSPENDED):
        raise HttpError(409, "This status transition is not allowed.")

    before = {"status": agency.status}
    with transaction.atomic():
        agency.status = Agency.SUSPENDED
        agency.decided_at = timezone.now()
        agency.decided_by = request.user
        agency.decision_note = payload.note
        agency.save()
        audit(request, "agency.suspended", agency, agency=agency, before=before)
    return agency_out(agency)


@admin_router.get("/agencies/{uuid:agency_id}/audit", response=list[AuditOut])
def agency_audit(request, agency_id):
    """An agency reads its own trail. Owner only — the audit log answers "who
    on my team changed this price", which is a management question."""
    require_membership(request.user, agency_id, Membership.OWNER)
    rows = AuditLog.objects.filter(agency_id=agency_id)[:200]
    return [
        {
            "id": str(r.id),
            "action": r.action,
            "entity_type": r.entity_type,
            "entity_id": str(r.entity_id) if r.entity_id else None,
            "actor_id": str(r.actor_id) if r.actor_id else None,
            "request_id": r.request_id,
            "before": r.before,
            "after": r.after,
            "created_at": r.created_at.isoformat(),
        }
        for r in rows
    ]


@admin_router.get("/admin/reconcile-ratings", response=Message)
def reconcile_ratings(request):
    """The other half of the denormalised counter on Agency.

    Any cached count eventually disagrees with the rows it summarises — a
    crashed request, a manual database edit, a bug fixed six months ago. This
    is the job that notices. Wired to an endpoint for now; it belongs on a
    schedule before launch.
    """
    require_staff(request)
    fixed = 0
    for agency in Agency.objects.all():
        before = (agency.rating_sum, agency.rating_count)
        agency.recompute_rating()
        if (agency.rating_sum, agency.rating_count) != before:
            fixed += 1
    return {"detail": f"{fixed} agenc{'y' if fixed == 1 else 'ies'} fixed."}


def user_agencies(user):
    """Used by the page views to answer "which agency am I acting for?"."""
    return Agency.objects.filter(memberships__user=user).order_by("name")


__all__ = ["router", "admin_router", "agency_out", "user_agencies", "User"]
