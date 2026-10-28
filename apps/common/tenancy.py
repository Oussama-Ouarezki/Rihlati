"""Tenant isolation, in one place.

The whole idea: a request carries an `agency_id` in the URL, but the URL is
client-controlled, so it proves nothing. Before any query runs we check that the
*session's* user has a Membership row for that agency. Then every query is
filtered by that same agency id — so even a bug in a handler cannot reach across
tenants, because the queryset never contained another tenant's rows.

Read that once more, because it is the transferable idea: **the row is not
rejected, it never existed.**

Missing row and forbidden row both come back 404. A 403 would confirm "this id
exists, you just cannot have it" — a free enumeration oracle.

The one deliberate exception is `require_membership` itself: putting *another
agency's* id in the path returns 403, because agency ids are not secret (they
are in every agency's own URLs) and "you are not a member of this agency" is
what a real user sees when their access was revoked while a tab was open. The
rule protects rows, not the existence of agencies.
"""

from django.http import Http404
from django.shortcuts import get_object_or_404

from apps.accounts.models import Agency, AuditLog, Membership


class Forbidden(Exception):
    """Raised when the caller is authenticated but not entitled. Mapped to 403
    by the API error handler and by the page views."""


def get_membership(user, agency_id):
    if not getattr(user, "is_authenticated", False):
        return None
    return (
        Membership.objects.filter(user=user, agency_id=agency_id).select_related("agency").first()
    )


def require_membership(user, agency_id, minimum_role=Membership.AGENT):
    """The one gate. Returns the Agency, or raises.

    `minimum_role` is a rank comparison rather than a list of allowed roles.
    Adding a role later is one line in Membership.RANK instead of an edit at
    every call site — and, more importantly, a new role slots into the
    hierarchy instead of being silently absent from every allowlist.
    """
    membership = get_membership(user, agency_id)
    if membership is None:
        raise Forbidden("Not a member of this agency.")
    if membership.rank < Membership.RANK[minimum_role]:
        raise Forbidden("Insufficient role for this action.")
    return membership.agency


def require_membership_or_404(user, agency_id, minimum_role=Membership.AGENT):
    """Page-side variant: an outsider cannot tell an agency they do not belong
    to from one that does not exist, because a browser URL gets pasted around
    far more casually than an API call."""
    try:
        return require_membership(user, agency_id, minimum_role)
    except Forbidden as exc:
        raise Http404 from exc


def refuse_self_review(user, agency):
    """A staff member may not decide on an agency they are a member of.

    This is the one rule the membership gate cannot express, because it is the
    exact inverse: everywhere else, belonging to the agency is what *grants*
    access. Here it removes it.

    The reasoning is not that staff will cheat. It is that a badge granted by
    its own owner proves nothing to a traveler, and proving something is the
    badge's only function. Rihlati is small enough that the same person could
    plausibly hold both roles, which is precisely when a rule is worth writing
    down rather than trusting.

    403, not 404: the agency plainly exists — it is in the queue this person
    just opened — so hiding it would be theatre. See [[Agency Verification]].
    """
    if Membership.objects.filter(user=user, agency=agency).exists():
        raise Forbidden("You cannot decide the fate of your own agency.")
    return agency


def scoped(queryset, agency_id):
    """Every tenant query goes through here.

    Filtering *inside* the queryset rather than checking the row afterwards is
    the whole point. A check after the fetch can be refactored away, skipped by
    an early return, or missed when the query is reused. A condition inside the
    queryset cannot be accidentally skipped, because there is nothing to skip.
    """
    return queryset.filter(agency_id=agency_id)


def get_scoped_object(queryset, agency_id, **lookup):
    return get_object_or_404(scoped(queryset, agency_id), **lookup)


def get_agency(agency_id):
    # Safe to fetch unscoped: membership was proved before this is reached.
    return get_object_or_404(Agency, pk=agency_id)


def audit(request, action, entity, *, agency=None, before=None, after=None):
    """Write one append-only row saying who did what.

    Call this inside the same `transaction.atomic()` as the change it records.
    An audit row written after a successful save is a log missing exactly the
    entries from the requests that crashed in between — which are the ones you
    most want.
    """
    user = getattr(request, "user", None)
    return AuditLog.objects.create(
        actor=user if getattr(user, "is_authenticated", False) else None,
        agency=agency or getattr(entity, "agency", None),
        action=action,
        entity_type=type(entity).__name__,
        entity_id=getattr(entity, "pk", None),
        before=before or {},
        after=after or {},
        request_id=getattr(request, "request_id", "") or "",
    )
