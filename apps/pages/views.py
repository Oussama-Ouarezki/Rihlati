"""The clickable, server-rendered half of Rihlati.

Every view here re-derives its own permissions. The navbar hiding a link is a
UX choice; `require_membership_or_404` is the actual security (Rule 2).

These pages and the JSON API are two doors onto the same models. Where a rule
could drift between them — what counts as publicly visible, what a valid phone
number is, how many offers a plan may publish — the rule lives in one module
that both import, never copied into a view. That shared module is this
project's answer to `packages/shared`.
"""

from django.conf import settings
from django.contrib import messages
from django.contrib.auth.decorators import login_required
from django.db import transaction
from django.db.models import Count, F, Q
from django.http import Http404
from django.shortcuts import get_object_or_404, redirect, render
from django.urls import reverse
from django.utils import timezone
from django.views.decorators.http import require_POST

from apps.accounts.models import Agency, Membership
from apps.chat.models import (
    MAX_FAQS,
    AgencyAssistant,
    assistant_is_enabled,
)
from apps.common.quotas import QuotaExceeded, assert_can_publish, quota_state
from apps.common.tenancy import (
    Forbidden,
    audit,
    refuse_self_review,
    require_membership_or_404,
    scoped,
)
from apps.common.wilayas import WILAYA_NAMES_FR
from apps.leads.models import Client, ClientNote, ClientTag, Lead, LeadActivity, LeadNote, Tag
from apps.leads.services import client_for_contact
from apps.offers.api import OfferFilters, apply_filters, record_metric
from apps.offers.models import CheckpointType, Offer, OfferMilestone, TrackedLink
from apps.pages.forms import (
    AgencyFaqForm,
    AgencyProfileForm,
    AssistantForm,
    ClientForm,
    InquiryForm,
    MilestoneForm,
    OfferAssistantForm,
    OfferForm,
    ReservationForm,
    TrackedLinkForm,
    VerificationForm,
)
from apps.pages.roadmap import build_phases
from apps.trips.models import (
    AttendanceStatus,
    MilestoneCheckIn,
    Reservation,
    current_milestone,
    default_status_for,
)

# ---------------------------------------------------------------- traveler side


def search(request):
    """A plain GET form, no JavaScript. Filters land in the URL, so a search is
    shareable and back-button friendly — someone pastes a link into a family
    WhatsApp group and everyone opens the same results."""
    raw = {
        "kind": request.GET.get("kind") or None,
        "wilaya": request.GET.get("wilaya") or None,
        "q": request.GET.get("q") or None,
        "sort": request.GET.get("sort") or "departure",
    }
    max_price = request.GET.get("max_price") or ""
    if max_price.isdigit():
        raw["price_max"] = int(max_price) * 100

    try:
        # The same schema the JSON API validates against. A bad `sort=` in the
        # URL bar therefore fails the same way in both places, instead of one
        # of them quietly accepting it and ordering by a column of its choice.
        filters = OfferFilters(**{k: v for k, v in raw.items() if v is not None})
    except Exception:
        filters = OfferFilters()

    offers = apply_filters(Offer.publicly_visible().select_related("agency"), filters)

    wilayas = (
        Offer.publicly_visible()
        .exclude(departure_wilaya_code="")
        .values_list("departure_wilaya_code", flat=True)
        .distinct()
        .order_by("departure_wilaya_code")
    )
    return render(
        request,
        "pages/search.html",
        {
            "offers": offers[:50],
            "wilayas": [(code, WILAYA_NAMES_FR.get(code, code)) for code in wilayas],
            "kinds": Offer.KINDS,
            "selected": {
                "kind": filters.kind or "",
                "wilaya": filters.wilaya or "",
                "q": filters.q or "",
                "sort": filters.sort,
                "max_price": max_price,
            },
            "total": offers.count(),
        },
    )


def tracked_link_redirect(request, code):
    """`/l/{code}` — the link an agency pastes under a Facebook post.

    It lives on the site's own domain, not an `api.` subdomain: a link that
    looks technical in a Facebook post looks like phishing, and travelers who
    have been scammed before do not tap it.

    **302, never 301.** A permanent redirect is cached by the browser, so from
    the second tap onwards the click never reaches this view — the counter
    silently stops and the agency concludes the post stopped working.
    """
    link = TrackedLink.resolve(code)
    if link is None:
        raise Http404
    link.count_click()

    if link.offer_id is None:
        return redirect("search")

    # Counted twice, on purpose, because the two counters answer different
    # questions. `TrackedLink.click_count` answers "did this Facebook post
    # work"; the offer's daily `link_clicks` answers "where did this offer's
    # traffic come from this week", which is the line on the analytics chart
    # that separates campaign traffic from people who found the offer in
    # search. One number cannot be both.
    if link.offer is not None:
        record_metric(link.offer, "link_clicks")

    # `?ref=` rather than a cookie: this is marketing metadata, it is not
    # needed on any other request, and a cookie here would drag a consent
    # banner into a page whose whole job is to load fast and be trusted.
    return redirect(f"{reverse('offer-detail', args=[link.offer_id])}?ref={link.code}")


def offer_detail(request, offer_id):
    # Scoped lookup again: a draft offer's id in the URL bar is still a 404.
    offer = get_object_or_404(
        Offer.publicly_visible().select_related("agency__assistant").prefetch_related("milestones"),
        pk=offer_id,
    )
    form = InquiryForm(request.POST or None)
    # Survives the POST through a hidden input. Trusting it is safe because
    # `resolve` is scoped to this offer's agency below: a traveler who edits it
    # can only credit a campaign belonging to the agency they are contacting.
    ref = request.POST.get("ref") or request.GET.get("ref") or ""

    if request.method == "POST":
        if form.is_valid():
            with transaction.atomic():
                lead = form.save(commit=False)
                lead.offer = offer
                lead.agency = offer.agency  # derived, never posted
                lead.traveler = request.user if request.user.is_authenticated else None
                # One person, many inquiries. The phone was normalised by the
                # form, so this is the same client every time.
                lead.client = client_for_contact(
                    agency=offer.agency,
                    full_name=lead.full_name,
                    phone_e164=lead.phone_e164,
                )
                link = TrackedLink.resolve(ref, agency_id=offer.agency_id)
                if link is not None:
                    lead.tracked_link = link
                    lead.source = Lead.Source.TRACKED_LINK
                # The checkbox was ticked (the form requires it); record *what*
                # was ticked, so the question "what did they agree to?" stays
                # answerable a year from now.
                lead.record_consent(request)
                lead.save()
                if link is not None:
                    # Same transaction as the lead, so "3 clients" and the
                    # inbox can never disagree.
                    TrackedLink.objects.filter(pk=link.pk).update(lead_count=F("lead_count") + 1)
                LeadActivity.objects.create(
                    agency=lead.agency, lead=lead, verb="created", detail={"source": lead.source}
                )
                record_metric(offer, "inquiries")
            messages.success(request, "Request sent. The agency will call you back shortly.")
            return redirect("offer-detail", offer_id=offer.id)
        messages.error(request, "Check the fields marked in red.")
    else:
        record_metric(offer, "views")

    return render(
        request,
        "pages/offer_detail.html",
        {
            "offer": offer,
            "form": form,
            "ref": ref,
            "programme": group_by_day(offer.milestones.all()),
            # Two switches: the deployment one and the agency's own. The widget
            # is absent unless both are on, rather than present and answering 503.
            "chat_enabled": settings.CHAT_ENABLED and assistant_is_enabled(offer.agency),
        },
    )


def offer_assistant(request, offer_id):
    """The full-page version of the assistant, for one offer.

    Same visibility rule as the offer page: a draft, an archived listing, or an
    unverified agency's offer is a 404. The widget is a preview; this page is
    what a traveler can bookmark or keep open on a phone while comparing.
    """
    offer = get_object_or_404(
        Offer.publicly_visible().select_related("agency__assistant").prefetch_related("milestones"),
        pk=offer_id,
    )
    if not settings.CHAT_ENABLED or not assistant_is_enabled(offer.agency):
        raise Http404
    return render(
        request,
        "pages/offer_assistant.html",
        {
            "offer": offer,
            "programme": group_by_day(offer.milestones.all()),
        },
    )


def my_trip(request, code):
    """No login. The link, sent by SMS, is the credential.

    Acceptable only because this page shows the reader's own booking and an
    already-public programme — never the passenger list, never what anyone
    paid, never a CRM note. See apps/trips/api.py.
    """
    if len(code) != 32:
        raise Http404
    reservation = get_object_or_404(
        Reservation.objects.select_related("offer", "agency"), public_code=code
    )
    offer = reservation.offer
    current = current_milestone(offer)
    return render(
        request,
        "pages/my_trip.html",
        {
            "reservation": reservation,
            "offer": offer,
            "agency": reservation.agency,
            "programme": group_by_day(offer.milestones.all(), current=current),
            "current": current,
            # Told to the template rather than left to a `<meta>` someone
            # deletes later: a capability URL that gets indexed is a leak.
            "noindex": True,
        },
    )


def roadmap(request):
    """The delivery map, drawn.

    The data lives in `apps.pages.roadmap`; this view only assembles the two
    totals the header shows. Public on purpose: it is the most honest
    description of what is *not* finished, and a preview build has nothing to
    gain from hiding it.
    """
    phases = build_phases()
    return render(
        request,
        "pages/roadmap.html",
        {
            "phases": phases,
            "done": sum(phase["done"] for phase in phases),
            "total": sum(phase["total"] for phase in phases),
        },
    )


def group_by_day(milestones, current=None):
    """Turn a flat list into [(day, date, [steps])].

    Grouping in Python rather than SQL because the list is at most a couple of
    hundred rows and already ordered by (day_offset, sort_order) — a GROUP BY
    here would buy nothing and cost the ordering.
    """
    days = []
    for milestone in milestones:
        if not days or days[-1]["day_offset"] != milestone.day_offset:
            days.append(
                {
                    "day_offset": milestone.day_offset,
                    "date": milestone.real_date,
                    "steps": [],
                }
            )
        days[-1]["steps"].append(
            {
                "milestone": milestone,
                "is_current": current is not None and milestone.pk == current.pk,
            }
        )
    return days


# ------------------------------------------------------------------ agency side


@login_required
def dashboard(request):
    memberships = request.user.memberships.select_related("agency")
    if not memberships:
        return render(request, "pages/no_agency.html")
    return redirect("agency-offers", agency_id=memberships[0].agency_id)


@login_required
def agency_offers(request, agency_id):
    agency = require_membership_or_404(request.user, agency_id)
    offers = agency.offers.annotate(lead_count=Count("leads"))
    # The CRM's two doors, with the numbers that make them worth opening. The
    # "due for a callback" count is the one that decides whether an agency taps
    # "Inquiries" at 9am or goes straight to the catalogue.
    crm = {
        "leads": agency.leads.count(),
        "clients": agency.clients.count(),
        "due": agency.leads.filter(next_action_at__lte=timezone.now())
        .exclude(status__in=Lead.TERMINAL_STATUSES)
        .count(),
    }
    return render(
        request,
        "pages/agency_offers.html",
        {
            "agency": agency,
            "offers": offers,
            "quota": quota_state(agency),
            "crm": crm,
            "tab": "offers",
        },
    )


@login_required
def agency_links(request, agency_id):
    """Which post actually brought clients.

    Creating a link is MANAGER-level: a link is a public URL carrying the
    agency's name, and the list is also the agency's marketing history.
    Reading it is member-level — an agent needs to know where a lead came from.
    """
    agency = require_membership_or_404(request.user, agency_id)
    form = TrackedLinkForm(request.POST or None, agency=agency)

    if request.method == "POST":
        require_membership_or_404(request.user, agency_id, Membership.MANAGER)
        if form.is_valid():
            link = TrackedLink.objects.create(
                agency=agency,
                offer=form.cleaned_data["offer"],
                label=form.cleaned_data["label"],
                # Server-generated. Letting the agency pick would mean
                # collisions, guessable codes, and a race on the unique index.
                code=TrackedLink.new_code(),
            )
            audit(request, "tracked_link.created", link, agency=agency, after={"label": link.label})
            messages.success(request, f"Link created: /l/{link.code}")
            return redirect("agency-links", agency_id=agency.id)
        messages.error(request, "Check the fields marked in red.")

    return render(
        request,
        "pages/agency_links.html",
        {
            "agency": agency,
            "links": agency.tracked_links.select_related("offer").order_by("-created_at"),
            "form": form,
            "can_create": request.user.memberships.filter(
                agency_id=agency_id, role__in=[Membership.MANAGER, Membership.OWNER]
            ).exists(),
            "tab": "links",
        },
    )


@login_required
def agency_offer_edit(request, agency_id, offer_id=None):
    agency = require_membership_or_404(request.user, agency_id, Membership.MANAGER)
    # Scoped fetch: an offer id belonging to another agency simply isn't here.
    offer = get_object_or_404(agency.offers, pk=offer_id) if offer_id else None

    form = OfferForm(request.POST or None, instance=offer)
    if request.method == "POST" and form.is_valid():
        wants_published = form.cleaned_data["status"] == Offer.PUBLISHED
        already_published = offer is not None and offer.status == Offer.PUBLISHED

        if wants_published and not agency.is_verified:
            form.add_error("status", "Your agency must be verified before you can publish.")
        elif wants_published and not already_published:
            try:
                assert_can_publish(agency, exclude_pk=offer.pk if offer else None)
            except QuotaExceeded as exc:
                form.add_error("status", str(exc))

        if not form.errors:
            with transaction.atomic():
                new_offer = form.save(commit=False)
                new_offer.agency = agency  # from the authorized URL, not the body
                new_offer.save()
                new_offer.quality_score = new_offer.compute_quality_score()
                new_offer.save(update_fields=["quality_score", "updated_at"])
                audit(request, "offer.saved", new_offer, agency=agency)
            messages.success(request, "Offer saved.")
            return redirect("agency-offers", agency_id=agency.id)

    return render(
        request,
        "pages/agency_offer_form.html",
        {"agency": agency, "form": form, "offer": offer, "tab": "offers"},
    )


@login_required
def agency_programme(request, agency_id, offer_id):
    """The programme editor — the screen this whole feature exists for.

    An Omra is not "a holiday", it is a schedule. Buyers compare programmes;
    "where do we meet?" gets asked once per family; during the trip nobody
    knows what is next. One structured list answers all three.
    """
    agency = require_membership_or_404(request.user, agency_id, Membership.MANAGER)
    offer = get_object_or_404(agency.offers, pk=offer_id)
    form = MilestoneForm(request.POST or None)

    if request.method == "POST" and form.is_valid():
        with transaction.atomic():
            milestone = form.save(commit=False)
            milestone.agency = agency
            milestone.offer = offer
            milestone.sort_order = (
                offer.milestones.filter(day_offset=milestone.day_offset).count() + 1
            )
            milestone.save()
            offer.quality_score = offer.compute_quality_score()
            offer.save(update_fields=["quality_score", "updated_at"])
            audit(request, "milestone.created", milestone, agency=agency)
        messages.success(request, "Step added.")
        return redirect("agency-programme", agency_id=agency.id, offer_id=offer.id)

    return render(
        request,
        "pages/agency_programme.html",
        {
            "agency": agency,
            "offer": offer,
            "form": form,
            "programme": group_by_day(offer.milestones.all()),
            "current": current_milestone(offer),
            # Only this agency's other offers: copying a programme from a
            # competitor would be reading the thing they compete on.
            "copy_sources": agency.offers.exclude(pk=offer.pk).order_by("-departure_date")[:20],
            "tab": "offers",
        },
    )


@login_required
def agency_milestone_delete(request, agency_id, offer_id, milestone_id):
    agency = require_membership_or_404(request.user, agency_id, Membership.MANAGER)
    milestone = get_object_or_404(scoped(OfferMilestone.objects, agency_id), pk=milestone_id)
    with transaction.atomic():
        audit(
            request,
            "milestone.deleted",
            milestone,
            agency=agency,
            before={"title": milestone.title},
        )
        milestone.delete()
    messages.success(request, "Step deleted.")
    return redirect("agency-programme", agency_id=agency_id, offer_id=offer_id)


@login_required
def agency_milestone_toggle(request, agency_id, offer_id, milestone_id):
    """Tick a step off, or untick it. Agent-level: the person holding the phone
    at the airport at 4am is the one who should be able to do this."""
    agency = require_membership_or_404(request.user, agency_id)
    milestone = get_object_or_404(scoped(OfferMilestone.objects, agency_id), pk=milestone_id)
    with transaction.atomic():
        if milestone.completed_at is None:
            milestone.completed_at = timezone.now()
            milestone.completed_by = request.user
        else:
            milestone.completed_at = None
            milestone.completed_by = None
        milestone.save(update_fields=["completed_at", "completed_by", "updated_at"])
        audit(request, "milestone.toggled", milestone, agency=agency)
    return redirect("agency-programme", agency_id=agency_id, offer_id=offer_id)


@login_required
def agency_programme_copy(request, agency_id, offer_id):
    """Reuse last season's programme on this season's departure.

    The payoff of storing `day_offset` instead of real dates: the same rows
    describe a March departure and a July one, with no date arithmetic.
    """
    agency = require_membership_or_404(request.user, agency_id, Membership.MANAGER)
    offer = get_object_or_404(agency.offers, pk=offer_id)
    source = get_object_or_404(agency.offers, pk=request.POST.get("source_offer_id"))

    with transaction.atomic():
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
                sort_order=m.sort_order,
                checkpoint_type=m.checkpoint_type,
                # completed_at deliberately not copied: a copy is a plan, not
                # something that already happened.
            )
            for m in source.milestones.all()
        ]
        OfferMilestone.objects.bulk_create(copies)
        audit(
            request,
            "milestone.programme_copied",
            offer,
            agency=agency,
            after={"from": str(source.pk), "count": len(copies)},
        )
    messages.success(request, f"{len(copies)} step(s) copied from “{source.title_fr}”.")
    return redirect("agency-programme", agency_id=agency_id, offer_id=offer_id)


@login_required
def agency_day_duplicate(request, agency_id, offer_id):
    """Copy one day's steps onto another. Days 3–9 of an Omra are frequently
    the same five steps with one changed, and retyping is where the mistakes
    get made — a mistake here is a family standing in the wrong place."""
    agency = require_membership_or_404(request.user, agency_id, Membership.MANAGER)
    offer = get_object_or_404(agency.offers, pk=offer_id)
    try:
        source_day = int(request.POST.get("day_offset", ""))
        target_day = int(request.POST.get("to_day_offset", ""))
    except ValueError:
        messages.error(request, "Invalid day.")
        return redirect("agency-programme", agency_id=agency_id, offer_id=offer_id)

    steps = list(offer.milestones.filter(day_offset=source_day))
    if not steps:
        messages.error(request, "No steps on that day.")
        return redirect("agency-programme", agency_id=agency_id, offer_id=offer_id)

    with transaction.atomic():
        OfferMilestone.objects.bulk_create(
            [
                OfferMilestone(
                    agency=agency,
                    offer=offer,
                    title=m.title,
                    description=m.description,
                    kind=m.kind,
                    day_offset=target_day,
                    time_of_day=m.time_of_day,
                    location_name=m.location_name,
                    meeting_point=m.meeting_point,
                    map_url=m.map_url,
                    sort_order=m.sort_order,
                    checkpoint_type=m.checkpoint_type,
                )
                for m in steps
            ]
        )
        audit(
            request,
            "milestone.day_duplicated",
            offer,
            agency=agency,
            after={"from_day": source_day, "to_day": target_day},
        )
    messages.success(request, f"Day {source_day} copied to day {target_day}.")
    return redirect("agency-programme", agency_id=agency_id, offer_id=offer_id)


@login_required
def agency_manifest(request, agency_id, offer_id):
    """Who is going, and who is here. Add a family, see the checkpoints."""
    agency = require_membership_or_404(request.user, agency_id)
    offer = get_object_or_404(agency.offers, pk=offer_id)
    form = ReservationForm(request.POST or None)

    if request.method == "POST" and form.is_valid():
        party = form.cleaned_data["party_size"]
        if party > offer.seats_left:
            form.add_error("party_size", f"Only {offer.seats_left} seat(s) left.")
        else:
            with transaction.atomic():
                reservation = Reservation.objects.create(
                    agency=agency,
                    offer=offer,
                    client=client_for_contact(
                        agency=agency,
                        full_name=form.cleaned_data["full_name"],
                        phone_e164=form.cleaned_data["phone_e164"],
                    ),
                    full_name=form.cleaned_data["full_name"],
                    phone_e164=form.cleaned_data["phone_e164"],
                    party_size=party,
                    note=form.cleaned_data["note"],
                )
                Offer.objects.filter(pk=offer.pk).update(seats_left=offer.seats_left - party)
                audit(request, "reservation.created", reservation, agency=agency)
            messages.success(request, "Booking added.")
            return redirect("agency-manifest", agency_id=agency_id, offer_id=offer_id)

    reservations = (
        scoped(Reservation.objects, agency_id).filter(offer=offer).select_related("client")
    )
    return render(
        request,
        "pages/agency_manifest.html",
        {
            "agency": agency,
            "offer": offer,
            "form": form,
            "reservations": reservations,
            "checkpoints": offer.milestones.exclude(checkpoint_type=CheckpointType.NONE),
            "tab": "offers",
        },
    )


@login_required
def agency_checkpoint(request, agency_id, offer_id, milestone_id):
    """The 4am screen: one row per family, one tap each.

    Rows are created here, lazily, so a checkpoint invented mid-trip needs no
    backfill and a booking made this morning just appears.
    """
    agency = require_membership_or_404(request.user, agency_id)
    milestone = get_object_or_404(
        scoped(OfferMilestone.objects.select_related("offer"), agency_id), pk=milestone_id
    )
    reservations = (
        scoped(Reservation.objects, agency_id)
        .filter(offer_id=milestone.offer_id)
        .exclude(status=AttendanceStatus.CANCELLED)
    )

    if request.method == "POST":
        reservation = get_object_or_404(reservations, pk=request.POST.get("reservation_id"))
        new_status = request.POST.get("status")
        if new_status not in AttendanceStatus.values:
            messages.error(request, "Unknown status.")
        else:
            row, _ = MilestoneCheckIn.objects.get_or_create(
                agency=agency, milestone=milestone, reservation=reservation
            )
            row.status = new_status
            row.checked_in_at = (
                timezone.now() if new_status == AttendanceStatus.CHECKED_IN else None
            )
            row.checked_in_by = request.user
            row.save(update_fields=["status", "checked_in_at", "checked_in_by", "updated_at"])
        return redirect(
            "agency-checkpoint",
            agency_id=agency_id,
            offer_id=offer_id,
            milestone_id=milestone_id,
        )

    existing = {c.reservation_id: c for c in MilestoneCheckIn.objects.filter(milestone=milestone)}
    rows = []
    for reservation in reservations:
        row = existing.get(reservation.pk)
        if row is None:
            row = MilestoneCheckIn.objects.create(
                agency=agency,
                milestone=milestone,
                reservation=reservation,
                status=default_status_for(milestone, reservation),
            )
        rows.append((reservation, row))

    return render(
        request,
        "pages/agency_checkpoint.html",
        {
            "agency": agency,
            "offer": milestone.offer,
            "milestone": milestone,
            "rows": rows,
            "statuses": AttendanceStatus.choices,
            "present": sum(1 for _r, c in rows if c.status == AttendanceStatus.CHECKED_IN),
            "tab": "offers",
        },
    )


@login_required
def agency_leads(request, agency_id):
    agency = require_membership_or_404(request.user, agency_id)
    leads = agency.leads.select_related("offer").prefetch_related("lead_tags__tag")

    status = request.GET.get("status") or ""
    quality = request.GET.get("quality") or ""
    if status:
        leads = leads.filter(status=status)
    if quality:
        leads = leads.filter(quality=quality)
    if request.GET.get("due"):
        leads = leads.filter(next_action_at__lte=timezone.now()).exclude(
            status__in=Lead.TERMINAL_STATUSES
        )

    # One aggregate query for every counter, rather than one round trip each.
    counts = agency.leads.aggregate(
        **{s: Count("id", filter=Q(status=s)) for s, _ in Lead.STATUSES}
    )
    due_count = (
        agency.leads.filter(next_action_at__lte=timezone.now())
        .exclude(status__in=Lead.TERMINAL_STATUSES)
        .count()
    )
    return render(
        request,
        "pages/agency_leads.html",
        {
            "agency": agency,
            "leads": leads,
            "statuses": Lead.STATUSES,
            "qualities": Lead.Quality.choices,
            "status": status,
            "quality": quality,
            "due_count": due_count,
            "chips": [(v, label, counts[v]) for v, label in Lead.STATUSES],
            "tab": "leads",
        },
    )


@login_required
def agency_lead_detail(request, agency_id, lead_id):
    agency = require_membership_or_404(request.user, agency_id)
    lead = get_object_or_404(agency.leads.select_related("offer", "client"), pk=lead_id)

    if request.method == "POST" and request.POST.get("note"):
        LeadNote.objects.create(
            agency=agency, lead=lead, author=request.user, body=request.POST["note"]
        )
        LeadActivity.objects.create(
            agency=agency, lead=lead, actor=request.user, verb="note_added", detail={}
        )
        return redirect("agency-lead-detail", agency_id=agency_id, lead_id=lead_id)

    return render(
        request,
        "pages/agency_lead_detail.html",
        {
            "agency": agency,
            "lead": lead,
            "notes": lead.notes.all(),
            "activities": lead.activities.all(),
            "statuses": Lead.STATUSES,
            "qualities": Lead.Quality.choices,
            "tab": "leads",
        },
    )


@login_required
def agency_lead_status(request, agency_id, lead_id):
    agency = require_membership_or_404(request.user, agency_id)
    lead = get_object_or_404(agency.leads, pk=lead_id)

    new_status = request.POST.get("status")
    new_quality = request.POST.get("quality")

    if new_status and new_status not in dict(Lead.STATUSES):
        messages.error(request, "Unknown status.")
    elif new_quality and new_quality not in Lead.Quality.values:
        messages.error(request, "Unknown quality.")
    else:
        before = {"status": lead.status, "quality": lead.quality}
        with transaction.atomic():
            if new_status:
                lead.status = new_status
            if new_quality:
                lead.quality = new_quality
            lead.touch_first_response()
            lead.save()
            if new_status and new_status != before["status"]:
                LeadActivity.objects.create(
                    agency=agency,
                    lead=lead,
                    actor=request.user,
                    verb="status_changed",
                    detail={"from": before["status"], "to": lead.status},
                )
            audit(request, "lead.updated", lead, agency=agency, before=before)
        messages.success(request, f"« {lead.full_name} » → {lead.get_status_display()}")

    # Deliberately not honouring a `next` parameter from the body: a
    # client-supplied redirect target is an open-redirect waiting to happen.
    url = reverse("agency-leads", args=[agency.id])
    if filter_status := request.POST.get("filter"):
        url = f"{url}?status={filter_status}"
    return redirect(url)


@login_required
def agency_clients(request, agency_id):
    """The client directory: people, not inquiries.

    The count on every chip is four aggregate queries, not one per row. The
    list itself carries its stats as annotations, so rendering a client never
    turns into a query per client.
    """
    agency = require_membership_or_404(request.user, agency_id)
    form = ClientForm(request.POST or None, agency=agency, include_note=True)

    if request.method == "POST":
        if form.is_valid():
            with transaction.atomic():
                client = form.save(commit=False)
                client.agency = agency
                client.save()
                note = form.cleaned_data.get("note")
                if note:
                    ClientNote.objects.create(
                        agency=agency, client=client, author=request.user, body=note
                    )
                audit(request, "client.created", client, agency=agency)
            messages.success(request, f"“{client.full_name}” added.")
            return redirect("agency-client-detail", agency_id=agency_id, client_id=client.id)
        messages.error(request, "Check the fields marked in red.")

    q = (request.GET.get("q") or "").strip()
    selected_filter = request.GET.get("filter") or ""
    clients = agency.clients.with_stats().search(q)
    if selected_filter:
        clients = clients.for_filter(selected_filter)

    total = agency.clients.count()
    chips = [("", "All", total)]
    for value, label in Client.FILTERS:
        chips.append((value, label, agency.clients.for_filter(value).count()))

    return render(
        request,
        "pages/agency_clients.html",
        {
            "agency": agency,
            "clients": clients,
            "form": form,
            "q": q,
            "filter": selected_filter,
            "chips": chips,
            "tab": "clients",
        },
    )


def _client_timeline(client):
    """A read-only merged history.

    Deliberately computed rather than stored: the lead timeline is already
    append-only, notes are already dated, and a second activity table would
    only be a third place for the same facts to disagree. This is the screen
    that answers "what happened with this person?" without asking anyone to
    remember.
    """

    def lead_label(activity):
        if activity.verb == "status_changed":
            labels = dict(Lead.STATUSES)
            detail = activity.detail or {}
            before = labels.get(detail.get("from"), detail.get("from", "?"))
            after = labels.get(detail.get("to"), detail.get("to", "?"))
            return f"Status: {before} → {after}"
        return {
            "created": "Inquiry received",
            "quality_changed": "Quality changed",
            "note_added": "Note added",
        }.get(activity.verb, activity.verb)

    events = []
    for activity in LeadActivity.objects.filter(lead__client=client).select_related(
        "lead__offer", "actor"
    ):
        events.append(
            {
                "at": activity.created_at,
                "label": lead_label(activity),
                "detail": activity.lead.offer.title_fr,
                "actor": activity.actor.username if activity.actor else "system",
                "kind": "lead",
            }
        )
    for reservation in client.reservations.select_related("offer"):
        events.append(
            {
                "at": reservation.created_at,
                "label": "Booking created",
                "detail": (
                    f"{reservation.offer.title_fr} · {reservation.party_size} "
                    f"traveller{'s' if reservation.party_size != 1 else ''}"
                ),
                "actor": "system",
                "kind": "trip",
            }
        )
    for note in client.notes.select_related("author"):
        events.append(
            {
                "at": note.created_at,
                "label": "Note",
                "detail": note.body,
                "actor": note.author.username if note.author else "—",
                "kind": "note",
            }
        )
    return sorted(events, key=lambda event: event["at"], reverse=True)


@login_required
def agency_client_detail(request, agency_id, client_id):
    """One person: contact, preferences, every inquiry, every trip."""
    agency = require_membership_or_404(request.user, agency_id)
    client = get_object_or_404(agency.clients.prefetch_related("client_tags__tag"), pk=client_id)
    role = (
        request.user.memberships.filter(agency_id=agency_id).values_list("role", flat=True).first()
    )
    can_manage = role is not None and (
        Membership.RANK.get(role, 0) >= Membership.RANK[Membership.MANAGER]
    )

    profile_form = ClientForm(instance=client, agency=agency)

    if request.method == "POST":
        action = request.POST.get("action")
        if action == "note" and request.POST.get("note"):
            with transaction.atomic():
                ClientNote.objects.create(
                    agency=agency, client=client, author=request.user, body=request.POST["note"]
                )
                audit(request, "client.note_added", client, agency=agency)
            messages.success(request, "Note added.")
            return redirect("agency-client-detail", agency_id=agency_id, client_id=client_id)

        if action == "profile":
            profile_form = ClientForm(request.POST, instance=client, agency=agency)
            if profile_form.is_valid():
                with transaction.atomic():
                    profile_form.save()

                    # Tags are a shared agency vocabulary. Sync rather than
                    # toggle: one POST describes the whole set, so a stale tab
                    # cannot re-add a tag someone just removed.
                    valid_tag_ids = {
                        str(tag_id)
                        for tag_id in Tag.objects.filter(agency=agency).values_list("id", flat=True)
                    }
                    selected = set(request.POST.getlist("tags")) & valid_tag_ids
                    ClientTag.objects.filter(agency=agency, client=client).exclude(
                        tag_id__in=selected
                    ).delete()
                    for tag_id in selected:
                        ClientTag.objects.get_or_create(agency=agency, client=client, tag_id=tag_id)

                    new_tag = (request.POST.get("new_tag") or "").strip()
                    if new_tag and can_manage:
                        tag, _created = Tag.objects.get_or_create(
                            agency=agency, name=new_tag, defaults={"colour": "#64748b"}
                        )
                        ClientTag.objects.get_or_create(agency=agency, client=client, tag=tag)
                    audit(request, "client.updated", client, agency=agency)
                messages.success(request, "Client profile saved.")
                return redirect("agency-client-detail", agency_id=agency_id, client_id=client_id)
            messages.error(request, "Check the fields marked in red.")

    return render(
        request,
        "pages/agency_client_detail.html",
        {
            "agency": agency,
            "client": client,
            "profile_form": profile_form,
            "leads": client.leads.select_related("offer").order_by("-created_at"),
            "reservations": client.reservations.select_related("offer").order_by(
                "-offer__departure_date"
            ),
            "notes": client.notes.select_related("author"),
            "timeline": _client_timeline(client),
            "tags": agency.tags.all(),
            "selected_tags": {ct.tag_id for ct in client.client_tags.all()},
            "can_manage": can_manage,
            "tab": "clients",
        },
    )


@login_required
def agency_assistant(request, agency_id):
    """The agency's own policy and global Q&A for its assistant.

    Manager-only for the same reason the profile is: these sentences are spoken
    to travelers under the agency's name. The view never accepts an agency id
    from the form — `require_membership_or_404` already authorized the one in
    the URL, and the forms have no `agency` field to forge.
    """
    agency = require_membership_or_404(request.user, agency_id, Membership.MANAGER)
    assistant = AgencyAssistant.objects.filter(agency=agency).first()
    form = AssistantForm(instance=assistant)
    faq_form = AgencyFaqForm(agency=agency)

    if request.method == "POST":
        action = request.POST.get("action", "policy")
        if action == "faq_add":
            if agency.assistant_faqs.count() >= MAX_FAQS:
                faq_form = AgencyFaqForm(request.POST, agency=agency)
                faq_form.add_error(None, f"Keep at most {MAX_FAQS} questions.")
            else:
                faq_form = AgencyFaqForm(request.POST, agency=agency)
                if faq_form.is_valid():
                    with transaction.atomic():
                        faq = faq_form.save()
                        audit(
                            request,
                            "assistant.faq_added",
                            faq,
                            agency=agency,
                            after=_faq_snapshot(faq),
                        )
                    messages.success(request, "Question saved.")
                    return redirect("agency-assistant", agency_id=agency.id)
            messages.error(request, "Check the question marked in red.")
        else:
            instance = assistant or AgencyAssistant(agency=agency)
            form = AssistantForm(request.POST, instance=instance)
            if form.is_valid():
                with transaction.atomic():
                    before = _assistant_snapshot(instance)
                    saved = form.save()
                    audit(
                        request,
                        "assistant.updated",
                        saved,
                        agency=agency,
                        before=before,
                        after=_assistant_snapshot(saved),
                    )
                messages.success(request, "Assistant instructions saved.")
                return redirect("agency-assistant", agency_id=agency.id)
            messages.error(request, "Check the fields marked in red.")

    return render(
        request,
        "pages/agency_assistant.html",
        {
            "agency": agency,
            "form": form,
            "assistant": form.instance,
            "faqs": agency.assistant_faqs.all(),
            "faq_form": faq_form,
            "max_faqs": MAX_FAQS,
            # Only offers a traveler can actually reach — a test link to a draft
            # or an expired listing would 404 and look like the assistant is broken.
            "offers": Offer.publicly_visible().filter(agency=agency).order_by("departure_date"),
            "tab": "assistant",
        },
    )


@login_required
def agency_faq_edit(request, agency_id, faq_id):
    agency = require_membership_or_404(request.user, agency_id, Membership.MANAGER)
    faq = get_object_or_404(agency.assistant_faqs, pk=faq_id)
    form = AgencyFaqForm(request.POST or None, instance=faq, agency=agency)

    if request.method == "POST" and form.is_valid():
        with transaction.atomic():
            before = _faq_snapshot(faq)
            saved = form.save()
            audit(
                request,
                "assistant.faq_updated",
                saved,
                agency=agency,
                before=before,
                after=_faq_snapshot(saved),
            )
        messages.success(request, "Question updated.")
        return redirect("agency-assistant", agency_id=agency.id)
    if request.method == "POST":
        messages.error(request, "Check the question marked in red.")

    return render(
        request,
        "pages/agency_faq_form.html",
        {"agency": agency, "faq": faq, "form": form, "tab": "assistant"},
    )


@login_required
@require_POST
def agency_faq_delete(request, agency_id, faq_id):
    agency = require_membership_or_404(request.user, agency_id, Membership.MANAGER)
    faq = get_object_or_404(agency.assistant_faqs, pk=faq_id)
    with transaction.atomic():
        audit(
            request,
            "assistant.faq_deleted",
            faq,
            agency=agency,
            before=_faq_snapshot(faq),
        )
        faq.delete()
    messages.success(request, "Question deleted.")
    return redirect("agency-assistant", agency_id=agency.id)


@login_required
def agency_offer_assistant(request, agency_id, offer_id):
    agency = require_membership_or_404(request.user, agency_id, Membership.MANAGER)
    offer = get_object_or_404(agency.offers, pk=offer_id)
    assistant = getattr(offer, "assistant_config", None)
    form = OfferAssistantForm(request.POST or None, instance=assistant)

    if request.method == "POST" and form.is_valid():
        with transaction.atomic():
            before = _offer_assistant_snapshot(assistant)
            saved = form.save(commit=False)
            saved.agency = agency
            saved.offer = offer
            saved.save()
            audit(
                request,
                "offer_assistant.updated",
                saved,
                agency=agency,
                before=before,
                after=_offer_assistant_snapshot(saved),
            )
        messages.success(request, "Offer instructions saved.")
        return redirect("agency-offer-assistant", agency_id=agency.id, offer_id=offer.id)
    if request.method == "POST":
        messages.error(request, "Check the field marked in red.")

    return render(
        request,
        "pages/agency_offer_assistant.html",
        {
            "agency": agency,
            "offer": offer,
            "form": form,
            "assistant": form.instance,
            "tab": "offers",
        },
    )


def _assistant_snapshot(assistant):
    """What the audit row needs: the state, and how much text — not the text."""
    return {
        "is_enabled": assistant.is_enabled,
        "instructions_chars": len((assistant.instructions or "").strip()),
    }


def _faq_snapshot(faq):
    return {
        "question": faq.question,
        "answer_chars": len((faq.answer or "").strip()),
        "is_active": faq.is_active,
    }


def _offer_assistant_snapshot(assistant):
    if assistant is None:
        return {"instructions_chars": 0}
    return {"instructions_chars": len((assistant.instructions or "").strip())}


@login_required
def agency_settings(request, agency_id):
    """Profile, plus the verification application.

    Two different bars on one page, on purpose. Editing the public profile is
    ordinary manager work. Submitting the verification file is a legal
    declaration about the company, so it is owner-only — an agent hired last
    week should not be able to make it.

    The template hides the verification form from a manager, which is UX. The
    check below is the security (Rule 2).
    """
    agency = require_membership_or_404(request.user, agency_id, Membership.MANAGER)
    is_owner = request.user.memberships.filter(agency_id=agency_id, role=Membership.OWNER).exists()
    profile_form = AgencyProfileForm(instance=agency)
    verification_form = VerificationForm(instance=agency)

    if request.method == "POST":
        if request.POST.get("form") == "verification":
            if not is_owner:
                raise Http404
            verification_form = VerificationForm(request.POST, instance=agency)
            if not agency.can_transition_to(Agency.PENDING):
                messages.error(
                    request, f"Not possible from the “{agency.get_status_display()}” state."
                )
            elif verification_form.is_valid():
                with transaction.atomic():
                    updated = verification_form.save(commit=False)
                    updated.status = Agency.PENDING
                    updated.submitted_for_review_at = timezone.now()
                    updated.rejection_reason = ""
                    updated.save()
                    audit(request, "agency.submitted_for_review", updated, agency=updated)
                messages.success(request, "Application submitted. We will get back to you shortly.")
                return redirect("agency-settings", agency_id=agency_id)
        else:
            profile_form = AgencyProfileForm(request.POST, instance=agency)
            if profile_form.is_valid():
                with transaction.atomic():
                    profile_form.save()
                    audit(request, "agency.updated", agency, agency=agency)
                messages.success(request, "Profile saved.")
                return redirect("agency-settings", agency_id=agency_id)

    return render(
        request,
        "pages/agency_settings.html",
        {
            "agency": agency,
            "profile_form": profile_form,
            "verification_form": verification_form,
            "is_owner": is_owner,
            "quota": quota_state(agency),
            "tab": "settings",
        },
    )


# ------------------------------------------------------------------- staff side


@login_required
def verification_queue(request):
    """Staff only. `is_staff` is read from the database on every request —
    never from a token claim, so revoking it bites immediately."""
    if not request.user.is_staff:
        raise Http404

    if request.method == "POST":
        agency = get_object_or_404(Agency, pk=request.POST.get("agency_id"))
        approve = request.POST.get("decision") == "approve"
        note = (request.POST.get("note") or "").strip()
        reason = (request.POST.get("rejection_reason") or "").strip()
        target = Agency.VERIFIED if approve else Agency.REJECTED

        try:
            # The rule lives in `apps/common/tenancy.py`, not here. Both doors
            # call the same function; this one turns the refusal into a message
            # because a page answers in French, not in status codes.
            refuse_self_review(request.user, agency)
            self_review = None
        except Forbidden as exc:
            self_review = str(exc)

        if self_review:
            messages.error(request, self_review)
        elif len(note) < 5:
            messages.error(request, "Say what you checked.")
        elif not approve and not reason:
            # The owner reads this verbatim. "Rejected." with no reason produces
            # a support ticket, a resubmission of the same file, and a lost
            # agency.
            messages.error(request, "A rejection reason is required.")
        elif not agency.can_transition_to(target):
            messages.error(request, "This status transition is not allowed.")
        else:
            before = {"status": agency.status}
            with transaction.atomic():
                agency.status = target
                agency.decided_at = timezone.now()
                agency.decided_by = request.user
                agency.decision_note = note
                agency.rejection_reason = "" if approve else reason
                agency.save()
                audit(
                    request,
                    "agency.verified" if approve else "agency.rejected",
                    agency,
                    agency=agency,
                    before=before,
                    after={"status": agency.status, "by": request.user.username},
                )
            messages.success(request, f"{agency.name} → {agency.get_status_display()}")
        return redirect("verification-queue")

    return render(
        request,
        "pages/verification_queue.html",
        {
            # Oldest first. Not newest, not alphabetical: a queue that is not
            # FIFO quietly means whoever complains loudest gets reviewed first.
            "queue": Agency.objects.filter(status=Agency.PENDING).order_by(
                "submitted_for_review_at"
            ),
            "recent": Agency.objects.exclude(decided_at=None).order_by("-decided_at")[:10],
        },
    )
