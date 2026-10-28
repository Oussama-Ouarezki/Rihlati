"""The local model, behind one function.

No SDK, no client library: Ollama speaks HTTP and `urllib` is in the standard
library. That keeps the dependency list at three packages and makes the whole
integration readable in one screen — which is the point of wiring an LLM into a
backend rather than hiding it in a framework.

Three settings are not cosmetic:

* `think: false` — Qwen3 writes its reasoning into a separate field by default.
  Those tokens cost seconds on a laptop and are never shown to the traveler, so
  the feature would be slower and no better.
* `keep_alive` — without it Ollama unloads the model between conversations and
  every first question pays a seven-second load. Measured on this machine: 8.4s
  cold, ~1.3s warm for a short answer.
* `num_predict` — a hard cap on the answer. Without it a confused model can
  generate for a minute, holding the worker and the traveler's browser.

Failure is a typed exception, not a dict with an error key: the handler maps it
to one 503, and a caller cannot accidentally treat "model down" as an answer.
"""

import json
import urllib.request

from django.conf import settings

# Ollama's default; overridden by CHAT_BASE_URL. Declared here rather than
# imported from settings so this module can be read without the project.
DEFAULT_BASE_URL = "http://127.0.0.1:11434"


class LLMUnavailable(Exception):
    """The model could not answer: not running, timed out, or returned nothing."""


def complete(messages):
    """Ask the model once. Returns `(text, usage)`.

    `messages` is the OpenAI-shaped list Ollama expects, already built by the
    caller from the database — this function never reads a model and never
    decides what the bot may know.
    """
    if not settings.CHAT_ENABLED:
        raise LLMUnavailable("assistant disabled by configuration")

    payload = {
        "model": settings.CHAT_MODEL,
        "messages": messages,
        "stream": False,
        "think": False,
        "keep_alive": settings.CHAT_KEEP_ALIVE,
        "options": {
            "temperature": 0.2,
            "num_ctx": settings.CHAT_NUM_CTX,
            "num_predict": settings.CHAT_MAX_TOKENS,
        },
    }
    base_url = getattr(settings, "CHAT_BASE_URL", DEFAULT_BASE_URL).rstrip("/")
    request = urllib.request.Request(  # noqa: S310  # settings-controlled internal URL
        f"{base_url}/api/chat",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )

    try:
        # The URL comes from settings, never from a request. S310 is the
        # "urlopen with a variable" check and does not apply to a configured
        # internal host, so it is silenced here with the reason rather than
        # globally.
        with urllib.request.urlopen(request, timeout=settings.CHAT_TIMEOUT) as response:  # noqa: S310
            body = json.load(response)
    except (OSError, ValueError) as exc:
        raise LLMUnavailable(f"{type(exc).__name__}: {exc}") from exc

    content = ((body.get("message") or {}).get("content") or "").strip()
    if not content:
        raise LLMUnavailable("the model returned no text")

    usage = {
        "prompt_tokens": int(body.get("prompt_eval_count") or 0),
        "completion_tokens": int(body.get("eval_count") or 0),
    }
    return content, usage
