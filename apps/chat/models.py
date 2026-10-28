"""Conversations with the per-offer assistant.

Three decisions are encoded here, and each one is the answer to a question the
first version of a chatbot usually gets wrong:

* **The token is the credential, not the user.** Travelers have no account, and
  requiring one to ask "is the visa included?" would kill the only reason the
  assistant exists. `token` is 128 random bits — the same capability-URL pattern
  as `Reservation.public_code` — so it names exactly one conversation and cannot
  be guessed or swapped for a neighbour's.

* **Rows, not a transcript in the browser.** The next question needs the
  previous turn, and a client that sends its own history can inject an assistant
  turn ("the price is 1 DZD"). The server rebuilds history from these rows, so
  the only thing the browser controls is the newest user message.

* **An expiry, not an archive.** A conversation contains whatever a traveler
  typed, which can include a phone number. Keeping it forever is a liability
  with no product upside: the unanswered-question queue needs days, not years.
  `purge_chat` deletes expired rows; running it is an operator's job until there
  is somewhere to run cron (see obsidian/Backend/Agency Chatbot.md).

The model itself is not stored: `ChatMessage.content` is what was said, and the
provider is an implementation detail (`apps/chat/llm.py`).
"""

import secrets
from datetime import timedelta

from django.conf import settings
from django.db import models
from django.utils import timezone

from apps.accounts.models import UUIDModel


class AgencyAssistant(UUIDModel):
    """What one agency wants its assistant to say beyond the offer data.

    Two fields, and both are policy rather than data:

    * `instructions` is the agency's own prose about booking, deposits,
      documents and cancellation. It belongs in the prompt, not in a new
      structured schema — reservation terms differ enough between agencies that
      a fixed set of fields would either fit nobody or be ignored.
    * `is_enabled` lets an agency turn the assistant off without deleting its
      text or its conversation history. Absence of a row means "on, no extra
      instructions", so existing agencies need no backfill.

    The instructions are injected *after* the platform rules in
    `apps/chat/prompts.py`. They can narrow what the bot says about this agency;
    they cannot override the rules that protect the traveler or the marketplace.
    """

    agency = models.OneToOneField(
        "accounts.Agency", on_delete=models.CASCADE, related_name="assistant"
    )
    is_enabled = models.BooleanField(default=True)
    instructions = models.TextField(max_length=2000, blank=True)

    class Meta:
        verbose_name = "agency assistant"
        verbose_name_plural = "agency assistants"

    def __str__(self):
        state = "enabled" if self.is_enabled else "disabled"
        return f"{self.agency_id} · {state}"


def assistant_config(agency):
    """The agency's config, or `None`. One query, and a missing row is normal.

    `getattr` is deliberate: a reverse one-to-one raises an exception that
    subclasses `AttributeError`, so this is the documented way to ask "does this
    agency have a config?" without a `try/except` around every call site.
    """
    return getattr(agency, "assistant", None)


def instructions_for(agency):
    config = assistant_config(agency)
    return config.instructions.strip() if config else ""


def assistant_is_enabled(agency):
    """Missing row means enabled — the feature existed before this model did."""
    config = assistant_config(agency)
    return config.is_enabled if config else True


class ChatConversation(UUIDModel):
    """One traveler talking about one offer.

    `agency` is denormalised from the offer on purpose (rule 3): the tenant
    filter never needs a join, and an offer that changes hands cannot silently
    move its old conversations with it.
    """

    # Rule 3: non-null tenant column on every tenant-scoped table.
    agency = models.ForeignKey(
        "accounts.Agency", on_delete=models.CASCADE, related_name="chat_conversations"
    )
    offer = models.ForeignKey(
        "offers.Offer", on_delete=models.CASCADE, related_name="chat_conversations"
    )

    token = models.CharField(max_length=64, unique=True, db_index=True)
    # The language the traveler arrived in. Recorded, not enforced: the bot
    # answers in whatever language the message is written in.
    locale = models.CharField(max_length=2, default="fr")

    # Exchanges, not messages: one question and one answer is turn 1. Counting
    # messages would make the cap twice as large as the number written in
    # settings, which is the sort of off-by-two that looks like a working limit.
    turn_count = models.PositiveIntegerField(default=0)
    # Token spend is the feature's COGS even when the model is local: it is the
    # number that says how much machine time one agency's travelers consume.
    prompt_tokens = models.PositiveIntegerField(default=0)
    completion_tokens = models.PositiveIntegerField(default=0)

    expires_at = models.DateTimeField(db_index=True)

    class Meta:
        ordering = ["-created_at"]
        indexes = [
            models.Index(fields=["offer", "-created_at"]),
            models.Index(fields=["agency", "-created_at"]),
        ]

    def __str__(self):
        return f"{self.offer_id} · {self.turn_count} turn(s)"

    @classmethod
    def start(cls, offer, locale="fr"):
        """An unsaved conversation. Saved only once the model has answered.

        Not saving first is deliberate: a request that fails because the model
        is down should leave no half-conversation behind for the traveler to
        retry into.
        """
        return cls(
            agency=offer.agency,
            offer=offer,
            token=secrets.token_hex(16),
            locale=locale,
            expires_at=timezone.now() + timedelta(days=settings.CHAT_CONVERSATION_TTL_DAYS),
        )


class ChatMessage(UUIDModel):
    USER, ASSISTANT = "user", "assistant"
    ROLES = [(USER, "Traveller"), (ASSISTANT, "Assistant")]

    conversation = models.ForeignKey(
        ChatConversation, on_delete=models.CASCADE, related_name="messages"
    )
    role = models.CharField(max_length=10, choices=ROLES)
    content = models.TextField()
    # Wall-clock time the model spent on the answer that followed this message.
    # Zero on user messages. Kept so "it feels slow" becomes a number instead of
    # an argument, and so a bad prompt change is visible without a profiler.
    latency_ms = models.PositiveIntegerField(default=0)

    class Meta:
        ordering = ["created_at"]
        indexes = [models.Index(fields=["conversation", "created_at"])]

    def __str__(self):
        return f"{self.role}: {self.content[:40]}"
