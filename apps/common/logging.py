"""Structured logs, and the redaction that makes them safe to keep.

CLAUDE.md rule #4 says two things that pull in opposite directions: log enough
to diagnose an incident, and never log a token, a password, an OTP code, or a
full phone number. Redacting at the *call site* loses that argument eventually
— one `logger.info(f"lead {lead}")` in a hurry and a phone number is in the
aggregator forever, where deleting it is somebody's week.

So redaction happens here, at the exit. The house-rules test still bans the
obvious call-site mistake; this is the layer that catches the one nobody
predicted.
"""

import json
import logging
import re

# A phone number, anywhere in a formatted message: 8–14 digits, optionally
# grouped with spaces, dots or dashes, optionally prefixed with a country code.
#
# The lookarounds are the whole trick, and they were added after the first
# version of this file quietly turned every URL in the logs into nonsense.
# `/a/8005579e-7de8-4e54-9f25-213c273a5d0/offers/` is a UUID, but a naive
# "digits and dashes" pattern reads a phone number inside it and masks it — so
# every request path became unsearchable, which defeats the point of logging
# the path at all. `(?<![\w-])` refuses to start mid-token, and `(?![\w-])`
# refuses to stop mid-token, so a UUID segment can never match.
#
# The bias is still toward over-redacting. Masking one extra order reference
# costs a mild annoyance; missing one phone number costs a person's privacy.
PHONE = re.compile(r"(?<![\w-])\+?\d(?:[\s.-]?\d){7,13}(?![\w-])")

# `token=abc123`, `"password": "hunter2"`, `api_key: sk-...` — the shapes a
# secret takes when someone dumps a dict into a log line.
#
# `(?:Bearer|Token|Basic)\s+` is matched and thrown away on purpose: without it
# the pattern masks the *word* "Token" and leaves the actual credential sitting
# in the log, which is the worst of both worlds — it looks redacted.
SECRETISH = re.compile(
    r"(?i)\b(password|passwd|secret|token|api[_-]?key|authorization|otp|code)"
    r"\b\s*[:=]\s*[\"']?(?:(?:Bearer|Token|Basic)\s+)?[^\s\"',}]+"
)


# The same policy as SECRETISH, for data that arrives already structured.
#
# `redact()` works on a formatted line, where the name and the value sit next
# to each other and a regex can see both. A crash report is not a line: the
# name is a dict key and the value is somewhere else entirely, so the pattern
# above sees `Bearer abcdef…` with no clue what it is and leaves it alone. This
# was found by a test, not by reading — see `ErrorReportingTests`.
SENSITIVE_KEYS = re.compile(
    r"(?i)(password|passwd|secret|token|api[_-]?key|authorization|cookie|session|otp|nif|"
    r"registre_commerce|card|cvv|iban)"
)


def is_sensitive_key(name):
    """Should the value under this key be dropped wholesale?

    Matching on a *substring* is deliberate: `access_token`, `refresh_token`,
    `HTTP_AUTHORIZATION` and `csrftoken` are all the same thing wearing
    different names, and an exact-match list is a list somebody has to keep
    complete forever.
    """
    return bool(SENSITIVE_KEYS.search(str(name)))


def mask_phone(value):
    """`+213555111222` → `+213555***222`.

    Keeps the country code and the last three digits, which is enough for an
    agent on the phone to confirm "yes, that's the number", and not enough for
    anyone reading the logs to call it.
    """
    digits = str(value or "")
    if len(digits) < 8:
        return "***"
    return f"{digits[:6]}***{digits[-3:]}"


def redact(text):
    text = SECRETISH.sub(lambda m: f"{m.group(1)}=***", text)
    return PHONE.sub(lambda m: mask_phone(m.group(0)), text)


class RequestIdFilter(logging.Filter):
    """Guarantee every record has a `request_id`, even outside a request.

    Without the default, a management command that logs anything crashes on a
    missing format key — which is how a logging config takes down a cron job.
    """

    def filter(self, record):
        if not hasattr(record, "request_id"):
            record.request_id = "-"
        return True


class JsonFormatter(logging.Formatter):
    """One JSON object per line.

    A human reads maybe ten log lines a year; a log aggregator reads all of
    them. Optimise for the reader that does the searching.
    """

    def format(self, record):
        payload = {
            "level": record.levelname,
            "logger": record.name,
            "requestId": getattr(record, "request_id", "-"),
            "message": redact(record.getMessage()),
        }
        if record.exc_info:
            # The traceback itself can contain a repr of a model instance, so it
            # goes through the same redaction as the message.
            payload["exception"] = redact(self.formatException(record.exc_info))
        return json.dumps(payload, ensure_ascii=False)
