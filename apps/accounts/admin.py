"""The verification back office.

Django's admin is the one place this stack hands you an internal tool for free,
and verification is the thing that most needs one: a human reads a registre de
commerce and decides whether a stranger gets the badge that makes travelers
trust them.

What is deliberately *not* free is the decision itself. The obvious admin —
`list_filter = ["is_verified"]` and a bulk action doing `update(is_verified=True)`
— is wrong here twice over, and both mistakes are worth naming because the
first version of this file made them:

1. `is_verified` is a **property**, not a column. It reads `status ==
   VERIFIED`. `list_filter` and `queryset.update()` both speak SQL, so neither
   can see it; the first raises `admin.E116` at boot and the second would write
   a column that does not exist.
2. A bulk `update()` skips `Agency.STATUS_TRANSITIONS`, writes no `decided_by`,
   and leaves no audit row. That produces exactly the thing the model's
   comments argue against — a badge nobody had to justify, which means nothing.

So the action below goes through the same state machine and writes the same
`AuditLog` row as the API endpoint. The admin is a second door onto one rule,
never a way around it.
"""

from django.contrib import admin, messages
from django.db import transaction
from django.utils import timezone

from apps.accounts.models import Agency, AuditLog, Membership, User


@admin.register(Agency)
class AgencyAdmin(admin.ModelAdmin):
    list_display = ["name", "city", "status", "plan", "submitted_for_review_at", "created_at"]
    # `status`, not `is_verified` — see the module docstring. Ordering by
    # submission date is what makes this a queue rather than a table: the
    # agency that has waited longest is the one at the top.
    list_filter = ["status", "plan", "wilaya_code"]
    search_fields = ["name", "slug", "registre_commerce", "nif"]
    ordering = ["-submitted_for_review_at"]
    actions = ["verify_agencies", "reject_agencies"]

    # A reviewer reads these; they are never the reviewer's to type. Leaving
    # them editable would let a decision be backdated after the fact, which is
    # the one thing an audit trail exists to prevent.
    readonly_fields = ["decided_at", "decided_by", "submitted_for_review_at"]

    @admin.display(description="Verified", boolean=True)
    def verified(self, obj):
        # Safe here — a display callable runs in Python, per row.
        return obj.is_verified

    def _decide(self, request, queryset, *, target, note):
        """One code path for both actions, because approve and reject differ
        only in the state they aim at and the row they write."""
        moved, refused = 0, []
        for agency in queryset:
            if not agency.can_transition_to(target):
                # Not an error worth aborting the batch for: selecting twenty
                # rows and finding one already decided is normal. But it is
                # reported, because silently doing nothing to a row the
                # reviewer selected is how they believe work happened.
                refused.append(f"{agency.name} ({agency.get_status_display()})")
                continue

            with transaction.atomic():
                before = {"status": agency.status}
                agency.status = target
                agency.decided_at = timezone.now()
                agency.decided_by = request.user
                agency.decision_note = note
                agency.save(
                    update_fields=[
                        "status",
                        "decided_at",
                        "decided_by",
                        "decision_note",
                        "updated_at",
                    ]
                )
                AuditLog.objects.create(
                    actor=request.user,
                    agency=agency,
                    action=f"agency.{target}",
                    entity_type="Agency",
                    entity_id=agency.pk,
                    before=before,
                    after={"status": target, "via": "admin"},
                    request_id=getattr(request, "request_id", "") or "",
                )
            moved += 1

        if moved:
            label = f"{moved} agenc{'y' if moved == 1 else 'ies'}"
            self.message_user(request, f"{label} → {target}.", messages.SUCCESS)
        if refused:
            self.message_user(
                request,
                "Transition not possible from their current state: " + ", ".join(refused),
                messages.WARNING,
            )

    @admin.action(description="Verify selected agencies")
    def verify_agencies(self, request, queryset):
        self._decide(
            request,
            queryset,
            target=Agency.VERIFIED,
            # The API requires a typed justification. The admin cannot prompt
            # for one from a bulk action, so it records that the decision came
            # from here — an honest "reviewed in the admin" beats an empty
            # field that looks like nobody checked.
            note="Verified from Django admin.",
        )

    @admin.action(description="Reject selected agencies")
    def reject_agencies(self, request, queryset):
        self._decide(
            request,
            queryset,
            target=Agency.REJECTED,
            note="Rejected from Django admin.",
        )


@admin.register(AuditLog)
class AuditLogAdmin(admin.ModelAdmin):
    """Append-only, and enforced as such below.

    An audit log an admin can edit is not an audit log. Django has no
    "read-only model" switch, so it is three methods.
    """

    list_display = ["created_at", "action", "entity_type", "actor", "agency", "request_id"]
    list_filter = ["action", "entity_type"]
    search_fields = ["request_id", "entity_id"]
    ordering = ["-created_at"]

    def has_add_permission(self, request):
        return False

    def has_change_permission(self, request, obj=None):
        return False

    def has_delete_permission(self, request, obj=None):
        return False


admin.site.register([User, Membership])
