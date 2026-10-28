"""Leads: the public inquiry endpoint, and the agency's CRM.

The asymmetry here is the whole design. **Creating** a lead is open to the
world — a traveler with no account, on a borrowed phone, must be able to ask a
question. **Reading** one is the most tightly scoped thing in the codebase: a
lead is a name and a phone number, which is exactly what a competitor wants and
exactly what the person trusted us with.

So: one `auth=None` POST that writes, and everything else behind membership.
"""

from django.db import models, transaction
from django.shortcuts import get_object_or_404
from django.utils import timezone
from ninja import Field, Query, Router
from ninja.errors import HttpError

from apps.accounts.models import Membership, User
from apps.common.schemas import Message, Strict
from apps.common.tenancy import audit, require_membership, scoped
from apps.common.throttling import InquiryThrottle
from apps.common.validators import validate_dz_phone
from apps.leads.models import (
    CONSENT_TEXT,
    Client,
    ClientNote,
    ClientTag,
    Lead,
    LeadActivity,
    LeadNote,
    LeadTag,
    Tag,
)
from apps.leads.services import client_for_contact
from apps.offers.api import record_metric
from apps.offers.models import Offer, TrackedLink

public_router = Router(tags=["inquiries"])
agency_router = Router(tags=["crm"])


class LeadIn(Strict):
    """What a traveler sends. Note what is absent: `agency_id`, `status`,
    `quality`, `source`. The agency is derived from the offer, and everything
    else is the agency's own judgement — a client that could set `quality: vip`
    would be writing into someone else's CRM."""

    offer_id: str
    full_name: str = Field(min_length=2, max_length=150)
    phone_e164: str
    message: str = Field("", max_length=2000)
    # Unchecked box → no lead. Not a default-true field, and not something the
    # server assumes: the whole point is that it was a deliberate act.
    consent: bool
    tracked_link_code: str | None = None


class LeadOut(Strict):
    id: str
    offer_id: str
    offer_title: str
    full_name: str
    phone_e164: str
    message: str
    status: str
    quality: str
    source: str
    lost_reason: str
    assigned_to_id: str | None
    next_action_at: str | None
    first_responded_at: str | None
    estimated_value_centimes: int | None
    has_consent: bool
    is_billable: bool
    tags: list[str]
    created_at: str


class LeadUpdate(Strict):
    """Every field optional: this is a PATCH, and the CRM is edited one control
    at a time — a status dropdown here, a callback date there."""

    status: str | None = None
    quality: str | None = None
    lost_reason: str | None = Field(None, max_length=200)
    assigned_to_id: str | None = None
    next_action_at: str | None = None
    estimated_value_centimes: int | None = Field(None, ge=0)


class LeadFilters(Strict):
    status: str | None = None
    quality: str | None = None
    assigned_to_id: str | None = None
    q: str | None = None
    due: bool = False
    limit: int = Field(50, ge=1, le=100)
    offset: int = Field(0, ge=0)


class NoteIn(Strict):
    body: str = Field(min_length=1, max_length=4000)


class NoteOut(Strict):
    id: str
    body: str
    author_id: str | None
    created_at: str


class ActivityOut(Strict):
    id: str
    verb: str
    detail: dict
    actor_id: str | None
    created_at: str


class TagIn(Strict):
    name: str = Field(min_length=1, max_length=40)
    colour: str = Field("#64748b", pattern="^#[0-9a-fA-F]{6}$")


class TagOut(Strict):
    id: str
    name: str
    colour: str


class ClientIn(Strict):
    """What an agency types to add someone who never filled the public form."""

    full_name: str = Field(min_length=2, max_length=150)
    phone_e164: str
    note: str = Field("", max_length=4000)


class ClientUpdate(Strict):
    full_name: str | None = Field(None, min_length=2, max_length=150)
    phone_e164: str | None = None


class ClientFilters(Strict):
    q: str | None = None
    filter: str | None = None
    limit: int = Field(50, ge=1, le=100)
    offset: int = Field(0, ge=0)


class ClientOut(Strict):
    id: str
    full_name: str
    phone_e164: str
    lead_count: int
    trip_count: int
    last_trip_on: str | None
    created_at: str


class ClientTripOut(Strict):
    id: str
    offer_id: str
    offer_title: str
    departure_date: str
    party_size: int
    status: str
    created_at: str


class ClientDetailOut(ClientOut):
    leads: list[LeadOut]
    reservations: list[ClientTripOut]
    notes: list[NoteOut]
    tags: list[str]


class PipelineOut(Strict):
    status: str
    count: int
    value_centimes: int


class ConsentOut(Strict):
    version: str
    text: str


def lead_out(lead):
    return {
        "id": str(lead.id),
        "offer_id": str(lead.offer_id),
        "offer_title": lead.offer.title_fr,
        "full_name": lead.full_name,
        "phone_e164": lead.phone_e164,
        "message": lead.message,
        "status": lead.status,
        "quality": lead.quality,
        "source": lead.source,
        "lost_reason": lead.lost_reason,
        "assigned_to_id": str(lead.assigned_to_id) if lead.assigned_to_id else None,
        "next_action_at": lead.next_action_at.isoformat() if lead.next_action_at else None,
        "first_responded_at": (
            lead.first_responded_at.isoformat() if lead.first_responded_at else None
        ),
        "estimated_value_centimes": lead.estimated_value_centimes,
        "has_consent": lead.has_consent,
        "is_billable": lead.is_billable,
        "tags": [lt.tag.name for lt in lead.lead_tags.all()],
        "created_at": lead.created_at.isoformat(),
    }


def client_out(client):
    return {
        "id": str(client.id),
        "full_name": client.full_name,
        "phone_e164": client.phone_e164,
        # Present only when the queryset was annotated. A freshly created
        # client genuinely has zero of both, so the defaults are true rather
        # than a convenient lie.
        "lead_count": getattr(client, "lead_count", 0),
        "trip_count": getattr(client, "trip_count", 0),
        "last_trip_on": (
            client.last_trip_on.isoformat() if getattr(client, "last_trip_on", None) else None
        ),
        "created_at": client.created_at.isoformat(),
    }


def client_detail_out(client):
    data = client_out(client)
    data.update(
        {
            "leads": [lead_out(lead) for lead in client.leads.all()],
            "reservations": [
                {
                    "id": str(reservation.id),
                    "offer_id": str(reservation.offer_id),
                    "offer_title": reservation.offer.title_fr,
                    "departure_date": reservation.offer.departure_date.isoformat(),
                    "party_size": reservation.party_size,
                    "status": reservation.status,
                    "created_at": reservation.created_at.isoformat(),
                }
                for reservation in client.reservations.all()
            ],
            "notes": [
                {
                    "id": str(note.id),
                    "body": note.body,
                    "author_id": str(note.author_id) if note.author_id else None,
                    "created_at": note.created_at.isoformat(),
                }
                for note in client.notes.all()
            ],
            "tags": [client_tag.tag.name for client_tag in client.client_tags.all()],
        }
    )
    return data


# --------------------------------------------------------------------------
# The public half: one endpoint, write-only.
# --------------------------------------------------------------------------


@public_router.get("/consent-text", response=ConsentOut, auth=None)
def consent_text(request):
    """The form fetches the wording it is about to record agreement to, so the
    checkbox label and the stored version can never drift apart."""
    from apps.leads.models import CONSENT_TEXT_VERSION

    return {"version": CONSENT_TEXT_VERSION, "text": CONSENT_TEXT}


@public_router.post("/inquiries", response={201: Message}, auth=None, throttle=[InquiryThrottle()])
def create_inquiry(request, payload: LeadIn):
    """Deliberately returns a bare confirmation, not the lead.

    Echoing the created row back would let anyone POST a plausible payload and
    read an id they can then try elsewhere. The traveler has no use for it; the
    agency reads it from their inbox.
    """
    if not payload.consent:
        raise HttpError(422, "Consent is required before we can share your contact details.")
    validate_dz_phone(payload.phone_e164)

    # publicly_visible(), not `Offer.objects` — an inquiry on a draft, archived,
    # or unverified-agency offer must 404, or the "verified only" promise is
    # decorative.
    offer = get_object_or_404(
        Offer.publicly_visible().select_related("agency"), pk=payload.offer_id
    )

    link = None
    source = Lead.Source.MARKETPLACE
    if payload.tracked_link_code:
        link = TrackedLink.objects.filter(
            code=payload.tracked_link_code, agency_id=offer.agency_id
        ).first()
        if link is not None:
            source = Lead.Source.TRACKED_LINK

    with transaction.atomic():
        lead = Lead(
            agency=offer.agency,
            offer=offer,
            traveler=request.user if getattr(request.user, "is_authenticated", False) else None,
            full_name=payload.full_name.strip(),
            phone_e164=payload.phone_e164,
            message=payload.message,
            source=source,
            tracked_link=link,
            client=client_for_contact(
                agency=offer.agency,
                full_name=payload.full_name,
                phone_e164=payload.phone_e164,
            ),
        )
        lead.record_consent(request)
        lead.save()

        LeadActivity.objects.create(
            agency=lead.agency, lead=lead, verb="created", detail={"source": source}
        )
        if link is not None:
            TrackedLink.objects.filter(pk=link.pk).update(lead_count=models.F("lead_count") + 1)
        record_metric(offer, "inquiries")

    return 201, {"detail": "Your request has been sent to the agency."}


# --------------------------------------------------------------------------
# The CRM. Everything below proves membership, then scopes.
# --------------------------------------------------------------------------


@agency_router.get("/agencies/{uuid:agency_id}/leads", response=list[LeadOut])
def list_leads(request, agency_id, filters: Query[LeadFilters]):
    require_membership(request.user, agency_id)
    queryset = scoped(
        Lead.objects.select_related("offer").prefetch_related("lead_tags__tag"), agency_id
    )
    if filters.status:
        queryset = queryset.filter(status=filters.status)
    if filters.quality:
        queryset = queryset.filter(quality=filters.quality)
    if filters.assigned_to_id:
        queryset = queryset.filter(assigned_to_id=filters.assigned_to_id)
    if filters.due:
        # "due for a callback" — the screen an agency opens first every morning.
        queryset = queryset.filter(next_action_at__lte=timezone.now()).exclude(
            status__in=Lead.TERMINAL_STATUSES
        )
    if filters.q:
        queryset = queryset.filter(
            models.Q(full_name__icontains=filters.q)
            | models.Q(phone_e164__icontains=filters.q)
            | models.Q(message__icontains=filters.q)
        )
    window = queryset[filters.offset : filters.offset + filters.limit]
    return [lead_out(lead) for lead in window]


@agency_router.get("/agencies/{uuid:agency_id}/leads/{uuid:lead_id}", response=LeadOut)
def get_lead(request, agency_id, lead_id):
    require_membership(request.user, agency_id)
    lead = get_object_or_404(
        scoped(Lead.objects.select_related("offer").prefetch_related("lead_tags__tag"), agency_id),
        pk=lead_id,
    )
    return lead_out(lead)


@agency_router.patch("/agencies/{uuid:agency_id}/leads/{uuid:lead_id}", response=LeadOut)
def update_lead(request, agency_id, lead_id, payload: LeadUpdate):
    agency = require_membership(request.user, agency_id)
    lead = get_object_or_404(scoped(Lead.objects.select_related("offer"), agency_id), pk=lead_id)

    changes = payload.dict(exclude_unset=True)
    if "status" in changes and changes["status"] not in dict(Lead.STATUSES):
        raise HttpError(422, "Unknown status.")
    if "quality" in changes and changes["quality"] not in Lead.Quality.values:
        raise HttpError(422, "Unknown quality.")
    if "assigned_to_id" in changes and changes["assigned_to_id"]:
        # Membership-scoped: assigning a lead to a user outside the agency
        # would hand them an inbox they have no right to.
        assignee = User.objects.filter(
            pk=changes["assigned_to_id"], memberships__agency_id=agency_id
        ).first()
        if assignee is None:
            raise HttpError(422, "This user is not a member of the agency.")

    before = {"status": lead.status, "quality": lead.quality}
    with transaction.atomic():
        for field, value in changes.items():
            setattr(lead, field, value)
        lead.touch_first_response()
        lead.save()

        if "status" in changes and changes["status"] != before["status"]:
            LeadActivity.objects.create(
                agency=lead.agency,
                lead=lead,
                actor=request.user,
                verb="status_changed",
                detail={"from": before["status"], "to": lead.status},
            )
        if "quality" in changes and changes["quality"] != before["quality"]:
            LeadActivity.objects.create(
                agency=lead.agency,
                lead=lead,
                actor=request.user,
                verb="quality_changed",
                detail={"from": before["quality"], "to": lead.quality},
            )
        audit(request, "lead.updated", lead, agency=agency, before=before, after=changes)
    return lead_out(lead)


@agency_router.get("/agencies/{uuid:agency_id}/pipeline", response=list[PipelineOut])
def pipeline(request, agency_id):
    """Counts and money per status — the dashboard number an owner actually
    looks at. Aggregated in SQL, because doing it in Python means loading every
    lead an agency has ever had to render one row of a summary."""
    require_membership(request.user, agency_id)
    rows = {
        r["status"]: r
        for r in scoped(Lead.objects, agency_id)
        .values("status")
        .annotate(count=models.Count("id"), value=models.Sum("estimated_value_centimes"))
    }
    return [
        {
            "status": status,
            "count": rows.get(status, {}).get("count", 0),
            "value_centimes": rows.get(status, {}).get("value") or 0,
        }
        for status, _label in Lead.STATUSES
    ]


@agency_router.get("/agencies/{uuid:agency_id}/clients", response=list[ClientOut])
def list_clients(request, agency_id, filters: Query[ClientFilters]):
    require_membership(request.user, agency_id)
    queryset = scoped(Client.objects, agency_id).with_stats()
    if filters.q:
        queryset = queryset.search(filters.q)
    if filters.filter:
        queryset = queryset.for_filter(filters.filter)
    window = queryset[filters.offset : filters.offset + filters.limit]
    return [client_out(client) for client in window]


@agency_router.post("/agencies/{uuid:agency_id}/clients", response={201: ClientOut})
def create_client(request, agency_id, payload: ClientIn):
    agency = require_membership(request.user, agency_id)
    validate_dz_phone(payload.phone_e164)
    if Client.objects.filter(agency=agency, phone_e164=payload.phone_e164).exists():
        raise HttpError(409, "A client already has this number.")

    with transaction.atomic():
        client = Client.objects.create(
            agency=agency,
            full_name=payload.full_name.strip(),
            phone_e164=payload.phone_e164,
        )
        if payload.note:
            ClientNote.objects.create(
                agency=agency, client=client, author=request.user, body=payload.note
            )
        audit(request, "client.created", client, agency=agency)
    return 201, client_out(client)


@agency_router.get("/agencies/{uuid:agency_id}/clients/{uuid:client_id}", response=ClientDetailOut)
def get_client(request, agency_id, client_id):
    require_membership(request.user, agency_id)
    client = get_object_or_404(
        scoped(
            Client.objects.with_stats().prefetch_related(
                "leads__offer",
                "leads__lead_tags__tag",
                "reservations__offer",
                "notes",
                "client_tags__tag",
            ),
            agency_id,
        ),
        pk=client_id,
    )
    return client_detail_out(client)


@agency_router.patch("/agencies/{uuid:agency_id}/clients/{uuid:client_id}", response=ClientOut)
def update_client(request, agency_id, client_id, payload: ClientUpdate):
    agency = require_membership(request.user, agency_id)
    client = get_object_or_404(scoped(Client.objects, agency_id), pk=client_id)

    changes = payload.dict(exclude_unset=True)
    if "phone_e164" in changes:
        validate_dz_phone(changes["phone_e164"])
        # Scoped by agency: the same number in another tenant is a different
        # client, not a conflict.
        duplicate = (
            Client.objects.filter(agency=agency, phone_e164=changes["phone_e164"])
            .exclude(pk=client.pk)
            .exists()
        )
        if duplicate:
            raise HttpError(409, "Another client already has this number.")
    if "full_name" in changes:
        changes["full_name"] = changes["full_name"].strip()

    with transaction.atomic():
        for field, value in changes.items():
            setattr(client, field, value)
        client.save()
        audit(request, "client.updated", client, agency=agency, after=changes)

    client = scoped(Client.objects.with_stats(), agency_id).get(pk=client.pk)
    return client_out(client)


@agency_router.get(
    "/agencies/{uuid:agency_id}/clients/{uuid:client_id}/notes", response=list[NoteOut]
)
def list_client_notes(request, agency_id, client_id):
    require_membership(request.user, agency_id)
    client = get_object_or_404(scoped(Client.objects, agency_id), pk=client_id)
    return [
        {
            "id": str(note.id),
            "body": note.body,
            "author_id": str(note.author_id) if note.author_id else None,
            "created_at": note.created_at.isoformat(),
        }
        for note in client.notes.all()
    ]


@agency_router.post(
    "/agencies/{uuid:agency_id}/clients/{uuid:client_id}/notes", response={201: NoteOut}
)
def add_client_note(request, agency_id, client_id, payload: NoteIn):
    agency = require_membership(request.user, agency_id)
    client = get_object_or_404(scoped(Client.objects, agency_id), pk=client_id)
    note = ClientNote.objects.create(
        agency=agency, client=client, author=request.user, body=payload.body
    )
    audit(request, "client.note_added", client, agency=agency)
    return 201, {
        "id": str(note.id),
        "body": note.body,
        "author_id": str(note.author_id) if note.author_id else None,
        "created_at": note.created_at.isoformat(),
    }


@agency_router.post(
    "/agencies/{uuid:agency_id}/clients/{uuid:client_id}/tags/{uuid:tag_id}",
    response={201: Message},
)
def attach_client_tag(request, agency_id, client_id, tag_id):
    agency = require_membership(request.user, agency_id)
    client = get_object_or_404(scoped(Client.objects, agency_id), pk=client_id)
    tag = get_object_or_404(scoped(Tag.objects, agency_id), pk=tag_id)
    ClientTag.objects.get_or_create(agency=agency, client=client, tag=tag)
    return 201, {"detail": "Label added."}


@agency_router.delete(
    "/agencies/{uuid:agency_id}/clients/{uuid:client_id}/tags/{uuid:tag_id}",
    response={200: Message},
)
def detach_client_tag(request, agency_id, client_id, tag_id):
    require_membership(request.user, agency_id)
    scoped(ClientTag.objects, agency_id).filter(client_id=client_id, tag_id=tag_id).delete()
    return {"detail": "Label removed."}


@agency_router.get("/agencies/{uuid:agency_id}/leads/{uuid:lead_id}/notes", response=list[NoteOut])
def list_notes(request, agency_id, lead_id):
    require_membership(request.user, agency_id)
    lead = get_object_or_404(scoped(Lead.objects, agency_id), pk=lead_id)
    return [
        {
            "id": str(n.id),
            "body": n.body,
            "author_id": str(n.author_id) if n.author_id else None,
            "created_at": n.created_at.isoformat(),
        }
        for n in lead.notes.all()
    ]


@agency_router.post(
    "/agencies/{uuid:agency_id}/leads/{uuid:lead_id}/notes", response={201: NoteOut}
)
def add_note(request, agency_id, lead_id, payload: NoteIn):
    agency = require_membership(request.user, agency_id)
    lead = get_object_or_404(scoped(Lead.objects, agency_id), pk=lead_id)
    note = LeadNote.objects.create(agency=agency, lead=lead, author=request.user, body=payload.body)
    LeadActivity.objects.create(
        agency=agency, lead=lead, actor=request.user, verb="note_added", detail={}
    )
    return 201, {
        "id": str(note.id),
        "body": note.body,
        "author_id": str(note.author_id) if note.author_id else None,
        "created_at": note.created_at.isoformat(),
    }


@agency_router.get(
    "/agencies/{uuid:agency_id}/leads/{uuid:lead_id}/activity", response=list[ActivityOut]
)
def list_activity(request, agency_id, lead_id):
    require_membership(request.user, agency_id)
    lead = get_object_or_404(scoped(Lead.objects, agency_id), pk=lead_id)
    return [
        {
            "id": str(a.id),
            "verb": a.verb,
            "detail": a.detail,
            "actor_id": str(a.actor_id) if a.actor_id else None,
            "created_at": a.created_at.isoformat(),
        }
        for a in lead.activities.all()
    ]


@agency_router.get("/agencies/{uuid:agency_id}/tags", response=list[TagOut])
def list_tags(request, agency_id):
    require_membership(request.user, agency_id)
    return [
        {"id": str(t.id), "name": t.name, "colour": t.colour}
        for t in scoped(Tag.objects, agency_id)
    ]


@agency_router.post("/agencies/{uuid:agency_id}/tags", response={201: TagOut})
def create_tag(request, agency_id, payload: TagIn):
    agency = require_membership(request.user, agency_id, Membership.MANAGER)
    tag, created = Tag.objects.get_or_create(
        agency=agency, name=payload.name.strip(), defaults={"colour": payload.colour}
    )
    return (201 if created else 200), {
        "id": str(tag.id),
        "name": tag.name,
        "colour": tag.colour,
    }


@agency_router.post(
    "/agencies/{uuid:agency_id}/leads/{uuid:lead_id}/tags/{uuid:tag_id}",
    response={201: Message},
)
def attach_tag(request, agency_id, lead_id, tag_id):
    agency = require_membership(request.user, agency_id)
    lead = get_object_or_404(scoped(Lead.objects, agency_id), pk=lead_id)
    # Both looked up inside the tenant. Either id alone crossing the boundary
    # would let one agency label another's lead with its own tag.
    tag = get_object_or_404(scoped(Tag.objects, agency_id), pk=tag_id)
    LeadTag.objects.get_or_create(agency=agency, lead=lead, tag=tag)
    return 201, {"detail": "Label added."}


@agency_router.delete(
    "/agencies/{uuid:agency_id}/leads/{uuid:lead_id}/tags/{uuid:tag_id}",
    response={200: Message},
)
def detach_tag(request, agency_id, lead_id, tag_id):
    require_membership(request.user, agency_id)
    scoped(LeadTag.objects, agency_id).filter(lead_id=lead_id, tag_id=tag_id).delete()
    return {"detail": "Label removed."}
