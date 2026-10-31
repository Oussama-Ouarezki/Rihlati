"""One public route: ask a question about one offer.

Why the route is public and why it still has a capability token:

* **Public** because travelers do not have accounts, and the whole reason this
  feature exists is the question asked at 23h by someone comparing two Omra
  packages. Requiring a login here would produce zero conversations.
* **Token** because the conversation is the only state, and the traveler is not
  a user. `token` names exactly one conversation; a token from another offer is
  the same 404 as an offer that does not exist, so it cannot be used to probe.
  This is the same capability-URL reasoning as `Reservation.public_code`.

The handler never sends the client's transcript to the model. It rebuilds the
last few turns from `ChatMessage` rows, so the only thing a browser can influence
is the newest question — not a fake assistant turn claiming a lower price.
"""

import logging
import time

from django.conf import settings
from django.db import transaction
from django.db.models import F
from django.http import Http404
from django.shortcuts import get_object_or_404
from django.utils import timezone
from ninja import Field, Router
from ninja.errors import HttpError

from apps.chat import discovery
from apps.chat.context import facts_json, related_offer_cards
from apps.chat.llm import LLMUnavailable, complete
from apps.chat.models import (
    ChatConversation,
    ChatMessage,
    assistant_is_enabled,
    faqs_for,
    instructions_for,
    offer_instructions_for,
)
from apps.chat.prompts import system_prompt
from apps.common.schemas import Strict
from apps.common.throttling import ChatThrottle
from apps.offers.models import Offer

logger = logging.getLogger(__name__)

public_router = Router(tags=["chat"])

# Same message for "token does not exist" and "token belongs to another offer".
# A distinguishable pair would turn the endpoint into an oracle for whether a
# guessed capability is real.
TOKEN_NOT_FOUND = "Conversation not found."  # noqa: S105  # a message, not a secret


class ChatIn(Strict):
    """What a browser may say. Nothing else.

    There is deliberately no `system`, no `agency_id`, no `offer_id` in the body
    and no price: the offer comes from the URL, the agency from the offer, and
    the facts from the database. A field absent from this schema is a field a
    client cannot set — the same reasoning as `OfferIn` in apps/offers/api.py.
    """

    message: str = Field(min_length=1, max_length=800)
    # Opaque capability from the first response. Absent means "start a new
    # conversation"; `None` is the only absent value, because an empty string is
    # a client mistake worth a 422 rather than a silent new conversation.
    token: str | None = Field(None, min_length=32, max_length=64)


class RelatedOfferOut(Strict):
    id: str
    url: str
    title: str
    price_centimes: int
    departure_date: str
    seats_left: int


class ChatOut(Strict):
    token: str
    reply: str
    related_offers: list[RelatedOfferOut]


class DiscoverIn(Strict):
    """A discovery message. There is no agency or offer id: this surface
    searches every verified agency's public listings, not one tenant's row."""

    message: str = Field(min_length=1, max_length=500)
    reset: bool = False


class DiscoverOfferOut(Strict):
    id: str
    url: str
    title: str
    kind: str
    kind_code: str
    price_centimes: int
    price_dzd: int
    departure_date: str
    destination: str
    agency: str
    verified: bool
    seats_left: int
    cover_image_url: str = ""


class DiscoverOut(Strict):
    reply: str
    summary: str
    search_url: str
    intent: dict
    parsed: dict
    reset: bool
    offers: list[DiscoverOfferOut]
    suggestions: list[str]
    total: int


@public_router.post(
    "/discover",
    response=DiscoverOut,
    auth=None,
    throttle=[ChatThrottle()],
)
def discover(request, payload: DiscoverIn):
    """Marketplace search in plain language.

    Public like the search page, because the traveller comparing three Omra
    packages at 23h does not have an account. The only thing kept between
    turns is the parsed intent in the session — never the message text — so a
    phone number typed into the chat does not outlive the request.
    """
    previous = None if payload.reset else request.session.get(discovery.SESSION_KEY)
    result = discovery.build_response(payload.message, previous)
    request.session[discovery.SESSION_KEY] = result["intent"]
    return result


@public_router.post(
    "/offers/{uuid:offer_id}",
    response=ChatOut,
    auth=None,
    throttle=[ChatThrottle()],
)
def chat_about_offer(request, offer_id, payload: ChatIn):
    # The same queryset the offer page uses: a draft, an archived listing, or an
    # unverified agency's offer is a 404 here too. The assistant cannot become a
    # side door onto a listing the marketplace is hiding.
    offer = get_object_or_404(
        Offer.publicly_visible()
        .select_related("agency__assistant", "assistant_config")
        .prefetch_related("milestones"),
        pk=offer_id,
    )

    # `CHAT_ENABLED` is the deployment switch; the agency's own toggle is a
    # product setting. Both answer 503, and neither writes anything: a traveler
    # retrying into a disabled assistant should not leave empty conversations.
    if not settings.CHAT_ENABLED or not assistant_is_enabled(offer.agency):
        raise HttpError(503, "The assistant is disabled.")

    conversation = _conversation_for(payload.token, offer)
    if conversation is not None and conversation.turn_count >= settings.CHAT_MAX_TURNS:
        # 409, not 403: the caller is allowed to use the assistant, this
        # conversation is simply finished. The fix is a new conversation or a
        # phone call, not a different identity.
        raise HttpError(409, "This conversation is over. Leave your number to continue.")

    question = payload.message.strip()
    if not question:
        raise HttpError(422, "Message vide.")

    messages = [
        {
            "role": "system",
            "content": system_prompt(
                offer,
                facts_json(offer),
                instructions_for(offer.agency),
                faqs=faqs_for(offer.agency),
                offer_instructions=offer_instructions_for(offer),
            ),
        }
    ]
    messages += _history(conversation)
    messages.append({"role": "user", "content": question})

    started = time.monotonic()
    try:
        reply, usage = complete(messages)
    except LLMUnavailable as exc:
        # One log line, no question text: the message may contain a phone
        # number, and rule 4 applies to the assistant's inbox like any other.
        logger.warning("chat unavailable offer=%s reason=%s", offer.id, exc)
        raise HttpError(503, "The assistant is temporarily unavailable.") from exc

    latency_ms = int((time.monotonic() - started) * 1000)

    # Persist the question and the answer together. A failure above leaves no
    # half-conversation, so the traveler's retry starts from a clean turn rather
    # than a duplicate question with no answer.
    if conversation is None:
        conversation = ChatConversation.start(offer, locale=_locale(request))
    with transaction.atomic():
        if conversation._state.adding:
            conversation.save()
        ChatMessage.objects.create(
            conversation=conversation, role=ChatMessage.USER, content=question
        )
        ChatMessage.objects.create(
            conversation=conversation,
            role=ChatMessage.ASSISTANT,
            content=reply,
            latency_ms=latency_ms,
        )
        ChatConversation.objects.filter(pk=conversation.pk).update(
            turn_count=F("turn_count") + 1,
            prompt_tokens=F("prompt_tokens") + usage.get("prompt_tokens", 0),
            completion_tokens=F("completion_tokens") + usage.get("completion_tokens", 0),
        )

    logger.info(
        "chat turn offer=%s latency_ms=%s question_chars=%s reply_chars=%s",
        offer.id,
        latency_ms,
        len(question),
        len(reply),
    )

    return {
        "token": conversation.token,
        "reply": reply,
        "related_offers": related_offer_cards(offer),
    }


def _conversation_for(token, offer):
    if not token:
        return None
    conversation = ChatConversation.objects.filter(
        token=token,
        offer=offer,
        expires_at__gt=timezone.now(),
    ).first()
    if conversation is None:
        raise Http404(TOKEN_NOT_FOUND)
    return conversation


def _history(conversation):
    """The last few turns, oldest first. Built from rows, never from the client.

    An assistant message is stored only after the model produced it, so a forged
    "assistant: the price is 1 DZD" cannot exist in the transcript the model sees.
    """
    if conversation is None:
        return []
    rows = list(conversation.messages.order_by("-created_at")[: settings.CHAT_HISTORY_TURNS * 2])
    return [{"role": row.role, "content": row.content} for row in reversed(rows)]


def _locale(request):
    language = getattr(request, "LANGUAGE_CODE", None) or settings.LANGUAGE_CODE
    return str(language)[:2] or "fr"
