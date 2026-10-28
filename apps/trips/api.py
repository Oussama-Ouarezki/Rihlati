"""Reservations, attendance, and the one page a traveler sees during the trip.

The interesting security object here is `public_code`. `/my-trip/<code>` has
no login: the family gets the link by SMS, opens it on a phone that may belong
to a nephew, and it must just work. That is a **capability URL** — holding the
URL *is* the credential.

It is acceptable here for one reason only: the page shows their own booking and
a programme that is already public. It must never show the passenger list, what
anyone paid, or a CRM note. If that ever changes, this endpoint needs a real
login, not a longer code.
"""

from django.db import transaction
from django.shortcuts import get_object_or_404
from django.utils import timezone
from ninja import Field, Router
from ninja.errors import HttpError

from apps.accounts.models import Membership
from apps.common.schemas import Message, Strict
from apps.common.tenancy import audit, require_membership, scoped
from apps.common.validators import validate_dz_phone
from apps.leads.models import Lead
from apps.leads.services import client_for_contact
from apps.offers.api import milestone_out
from apps.offers.models import CheckpointType, Offer, OfferMilestone
from apps.trips.models import (
    AttendanceStatus,
    MilestoneCheckIn,
    Reservation,
    current_milestone,
    default_status_for,
)

public_router = Router(tags=["my-trip"])
agency_router = Router(tags=["manifest"])


class ReservationIn(Strict):
    offer_id: str
    full_name: str = Field(min_length=2, max_length=150)
    phone_e164: str
    party_size: int = Field(1, ge=1, le=50)
    note: str = Field("", max_length=1000)
    lead_id: str | None = None


class ReservationOut(Strict):
    id: str
    offer_id: str
    offer_title: str
    full_name: str
    phone_e164: str
    party_size: int
    note: str
    status: str
    public_code: str
    created_at: str


class StatusIn(Strict):
    status: str


class CheckInOut(Strict):
    reservation_id: str
    full_name: str
    party_size: int
    status: str
    checked_in_at: str | None


class CheckpointOut(Strict):
    milestone_id: str
    title: str
    day_offset: int
    checkpoint_type: str
    expected: int
    checked_in: int
    no_show: int
    rows: list[CheckInOut]


class PublicMilestoneOut(Strict):
    """The traveler's view of a step. Same rows as MilestoneOut, minus
    `sort_order` and plus the one thing they came to find out: is this next?"""

    title: str
    description: str
    kind: str
    day_offset: int
    date: str
    time_of_day: str
    location_name: str
    meeting_point: str
    map_url: str
    is_completed: bool
    is_current: bool


class MyTripOut(Strict):
    full_name: str
    party_size: int
    offer_title: str
    agency_name: str
    agency_phone: str
    agency_whatsapp: str
    departure_date: str
    milestones: list[PublicMilestoneOut]
    # Explicitly NOT here: phone_e164 of other passengers, price paid, lead
    # status, CRM notes, the manifest. See the module docstring.


def reservation_out(reservation):
    return {
        "id": str(reservation.id),
        "offer_id": str(reservation.offer_id),
        "offer_title": reservation.offer.title_fr,
        "full_name": reservation.full_name,
        "phone_e164": reservation.phone_e164,
        "party_size": reservation.party_size,
        "note": reservation.note,
        "status": reservation.status,
        "public_code": reservation.public_code,
        "created_at": reservation.created_at.isoformat(),
    }


# --------------------------------------------------------------------------
# The manifest, from the agency's side.
# --------------------------------------------------------------------------


@agency_router.get(
    "/agencies/{uuid:agency_id}/offers/{uuid:offer_id}/reservations",
    response=list[ReservationOut],
)
def list_reservations(request, agency_id, offer_id):
    require_membership(request.user, agency_id)
    offer = get_object_or_404(scoped(Offer.objects, agency_id), pk=offer_id)
    rows = scoped(Reservation.objects.select_related("offer"), agency_id).filter(offer=offer)
    return [reservation_out(r) for r in rows]


@agency_router.post("/agencies/{uuid:agency_id}/reservations", response={201: ReservationOut})
def create_reservation(request, agency_id, payload: ReservationIn):
    agency = require_membership(request.user, agency_id)
    validate_dz_phone(payload.phone_e164)
    offer = get_object_or_404(scoped(Offer.objects, agency_id), pk=payload.offer_id)

    lead = None
    if payload.lead_id:
        lead = get_object_or_404(scoped(Lead.objects, agency_id), pk=payload.lead_id)

    if payload.party_size > offer.seats_left:
        raise HttpError(409, f"Only {offer.seats_left} seat(s) left.")

    # A booking made from a lead belongs to the same person; a walk-in gets a
    # client created from the phone they gave at the desk.
    if lead is not None and lead.client_id:
        client = lead.client
    else:
        client = client_for_contact(
            agency=agency,
            full_name=payload.full_name.strip(),
            phone_e164=payload.phone_e164,
        )

    with transaction.atomic():
        reservation = Reservation.objects.create(
            agency=agency,
            offer=offer,
            lead=lead,
            client=client,
            full_name=payload.full_name.strip(),
            phone_e164=payload.phone_e164,
            party_size=payload.party_size,
            note=payload.note,
        )
        # Seats move here, not on the lead. An inquiry is a question; only a
        # reservation removes a seat from the marketplace.
        Offer.objects.filter(pk=offer.pk).update(seats_left=offer.seats_left - payload.party_size)
        if lead is not None and lead.status != Lead.BOOKED:
            lead.status = Lead.BOOKED
            lead.touch_first_response()
            lead.save(update_fields=["status", "first_responded_at", "updated_at"])
        audit(request, "reservation.created", reservation, agency=agency)
    return 201, reservation_out(reservation)


@agency_router.patch(
    "/agencies/{uuid:agency_id}/reservations/{uuid:reservation_id}", response=ReservationOut
)
def set_reservation_status(request, agency_id, reservation_id, payload: StatusIn):
    agency = require_membership(request.user, agency_id)
    reservation = get_object_or_404(
        scoped(Reservation.objects.select_related("offer"), agency_id), pk=reservation_id
    )
    if payload.status not in AttendanceStatus.values:
        raise HttpError(422, "Unknown status.")

    before = {"status": reservation.status}
    with transaction.atomic():
        # Cancelling gives the seats back; un-cancelling takes them again.
        # Both directions, because a cancellation gets reversed often enough
        # that a one-way rule leaves offers permanently short of seats.
        was_cancelled = reservation.status == AttendanceStatus.CANCELLED
        now_cancelled = payload.status == AttendanceStatus.CANCELLED
        if now_cancelled and not was_cancelled:
            _adjust_seats(reservation.offer, +reservation.party_size)
        elif was_cancelled and not now_cancelled:
            _adjust_seats(reservation.offer, -reservation.party_size)

        reservation.status = payload.status
        reservation.save(update_fields=["status", "updated_at"])
        audit(request, "reservation.status_changed", reservation, agency=agency, before=before)
    return reservation_out(reservation)


def _adjust_seats(offer, delta):
    from django.db import models

    new_value = offer.seats_left + delta
    if new_value > offer.seats_total:
        new_value = offer.seats_total
    if new_value < 0:
        raise HttpError(409, "No seats left.")
    Offer.objects.filter(pk=offer.pk).update(seats_left=models.Value(new_value))


# --------------------------------------------------------------------------
# Attendance at a checkpoint. The 4am screen.
# --------------------------------------------------------------------------


@agency_router.get(
    "/agencies/{uuid:agency_id}/milestones/{uuid:milestone_id}/checkpoint",
    response=CheckpointOut,
)
def checkpoint(request, agency_id, milestone_id):
    """The list a guide opens, with a row per family.

    Rows are created here, lazily, rather than when the milestone is added. A
    checkpoint invented mid-trip therefore needs no backfill, and a reservation
    made this morning appears without anyone re-running anything.
    """
    require_membership(request.user, agency_id)
    milestone = get_object_or_404(
        scoped(OfferMilestone.objects.select_related("offer"), agency_id), pk=milestone_id
    )
    if not milestone.tracks_attendance:
        raise HttpError(409, "This step does not have a checkpoint.")

    reservations = (
        scoped(Reservation.objects, agency_id)
        .filter(offer_id=milestone.offer_id)
        .exclude(status=AttendanceStatus.CANCELLED)
    )

    existing = {c.reservation_id: c for c in MilestoneCheckIn.objects.filter(milestone=milestone)}
    rows = []
    to_create = []
    for reservation in reservations:
        row = existing.get(reservation.pk)
        if row is None:
            row = MilestoneCheckIn(
                agency_id=agency_id,
                milestone=milestone,
                reservation=reservation,
                status=default_status_for(milestone, reservation),
            )
            to_create.append(row)
        rows.append((reservation, row))
    if to_create:
        MilestoneCheckIn.objects.bulk_create(to_create)

    return {
        "milestone_id": str(milestone.id),
        "title": milestone.title,
        "day_offset": milestone.day_offset,
        "checkpoint_type": milestone.checkpoint_type,
        "expected": sum(1 for _r, c in rows if c.status == AttendanceStatus.EXPECTED),
        "checked_in": sum(1 for _r, c in rows if c.status == AttendanceStatus.CHECKED_IN),
        "no_show": sum(1 for _r, c in rows if c.status == AttendanceStatus.NO_SHOW),
        "rows": [
            {
                "reservation_id": str(r.id),
                "full_name": r.full_name,
                "party_size": r.party_size,
                "status": c.status,
                "checked_in_at": c.checked_in_at.isoformat() if c.checked_in_at else None,
            }
            for r, c in rows
        ],
    }


@agency_router.post(
    "/agencies/{uuid:agency_id}/milestones/{uuid:milestone_id}/checkpoint/{uuid:reservation_id}",
    response=CheckInOut,
)
def set_check_in(request, agency_id, milestone_id, reservation_id, payload: StatusIn):
    """One tap. Agent-level, and no state machine: see AttendanceStatus."""
    require_membership(request.user, agency_id, Membership.AGENT)
    milestone = get_object_or_404(scoped(OfferMilestone.objects, agency_id), pk=milestone_id)
    reservation = get_object_or_404(scoped(Reservation.objects, agency_id), pk=reservation_id)
    if payload.status not in AttendanceStatus.values:
        raise HttpError(422, "Unknown status.")

    row, _created = MilestoneCheckIn.objects.get_or_create(
        agency_id=agency_id, milestone=milestone, reservation=reservation
    )
    row.status = payload.status
    row.checked_in_at = timezone.now() if payload.status == AttendanceStatus.CHECKED_IN else None
    row.checked_in_by = request.user
    row.save(update_fields=["status", "checked_in_at", "checked_in_by", "updated_at"])
    return {
        "reservation_id": str(reservation.id),
        "full_name": reservation.full_name,
        "party_size": reservation.party_size,
        "status": row.status,
        "checked_in_at": row.checked_in_at.isoformat() if row.checked_in_at else None,
    }


@agency_router.get(
    "/agencies/{uuid:agency_id}/offers/{uuid:offer_id}/checkpoints",
    response=list[CheckpointOut],
)
def list_checkpoints(request, agency_id, offer_id):
    require_membership(request.user, agency_id)
    offer = get_object_or_404(scoped(Offer.objects, agency_id), pk=offer_id)
    milestones = offer.milestones.exclude(checkpoint_type=CheckpointType.NONE)
    return [checkpoint(request, agency_id, m.pk) for m in milestones]


# --------------------------------------------------------------------------
# The traveler's page. No login, one secret in the URL, nothing else exposed.
# --------------------------------------------------------------------------


@public_router.get("/my-trip/{code}", response=MyTripOut, auth=None)
def my_trip(request, code: str):
    if len(code) != 32:
        # Fail on shape before touching the database: a code of the wrong
        # length is never a real one, and this keeps a scanner from turning the
        # endpoint into a query generator.
        raise HttpError(404, "Introuvable.")

    reservation = get_object_or_404(
        Reservation.objects.select_related("offer", "agency"), public_code=code
    )
    offer = reservation.offer
    current = current_milestone(offer)
    return {
        "full_name": reservation.full_name,
        "party_size": reservation.party_size,
        "offer_title": offer.title_fr,
        "agency_name": reservation.agency.name,
        "agency_phone": reservation.agency.phone,
        "agency_whatsapp": reservation.agency.whatsapp,
        "departure_date": offer.departure_date.isoformat(),
        "milestones": [
            {
                "title": m.title,
                "description": m.description,
                "kind": m.kind,
                "day_offset": m.day_offset,
                "date": m.real_date.isoformat(),
                "time_of_day": m.time_of_day,
                "location_name": m.location_name,
                "meeting_point": m.meeting_point,
                "map_url": m.map_url,
                "is_completed": m.completed_at is not None,
                "is_current": current is not None and m.pk == current.pk,
            }
            for m in offer.milestones.all()
        ],
    }


__all__ = ["public_router", "agency_router", "milestone_out", "Message"]
