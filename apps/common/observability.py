"""Error reporting — CLAUDE.md rule #4, the half that logs alone cannot do.

Logs answer "what happened during this request, once I know which request".
An error tracker answers the question nobody is around to ask: *something is
crashing right now and no user has told you.* Users do not report bugs. They
leave, quietly, and the graph never shows a reason.

This wires **Sentry or a self-hosted GlitchTip** — same wire protocol, so the
only difference is which DSN you paste in. [[Decision Log|Decision 017]] picks
GlitchTip, because the data being reported includes Algerian travelers' names
and phone numbers and it should not leave infrastructure we control.

Two behaviours worth knowing before reading the code:

* **No DSN configured is a silent no-op.** That is why local runs and CI stay
  quiet without any test needing to know this module exists.
* **Only unexpected errors are reported.** A 404 or a validation failure is the
  application working correctly, and a tracker full of those is a tracker
  everyone learns to ignore — at which point the real crash arrives and nobody
  looks.
"""

import logging

from apps.common.logging import is_sensitive_key, redact

logger = logging.getLogger("rihlati.observability")

# Errors the application raises on purpose, as part of behaving correctly.
# Reporting these is how alert fatigue starts.
EXPECTED_EXCEPTIONS = (
    "Http404",
    "PermissionDenied",
    "Forbidden",
    "ValidationError",
    "AuthenticationError",
    "Throttled",
)


def scrub(event, hint):
    """Everything leaving for the tracker goes through the same `redact()` the
    logs use.

    A crash report naturally carries the request that caused it — which here
    means a traveler's phone number, and sometimes an Authorization header. An
    error tracker is very much "anywhere", and rule #4's list of things that
    are never logged does not stop applying because the destination is a
    different vendor.

    Returning `None` drops the event entirely; that is how the expected-error
    filter below refuses to send one.
    """
    exc_info = (hint or {}).get("exc_info")
    if exc_info and type(exc_info[1]).__name__ in EXPECTED_EXCEPTIONS:
        return None

    # Two passes over the same tree, because a crash report carries secrets in
    # two shapes and only one of them is a pattern:
    #
    #   "lead +213555111222 failed"   → the value looks dangerous  → redact()
    #   {"Authorization": "Bearer x"} → the *key* says it is       → drop it
    #
    # The second case is the one that leaks. `redact()` needs to see the name
    # and the value in the same string, and here they are a dict key and a
    # dict value with no text between them.
    def walk(value):
        if isinstance(value, str):
            return redact(value)
        if isinstance(value, dict):
            return {k: "***" if is_sensitive_key(k) else walk(v) for k, v in value.items()}
        if isinstance(value, list):
            return [walk(v) for v in value]
        return value

    return walk(event)


def init_error_reporting(dsn, environment, release=None):
    """Called once from settings. Returns True if reporting is live.

    The import is inside the function on purpose: `sentry-sdk` is an optional
    dependency, and a project running without a DSN should not be forced to
    install a package it will never call.
    """
    if not dsn:
        return False

    try:
        import sentry_sdk
        from sentry_sdk.integrations.django import DjangoIntegration
    except ImportError:
        # Not silent, and not fatal. A crash here would take down a working
        # site over a monitoring dependency; saying nothing would leave someone
        # believing errors are being collected when they are not.
        logger.error(
            "SENTRY_DSN is set but sentry-sdk is not installed. "
            "Error reporting is OFF. Run: pip install -r requirements.txt"
        )
        return False

    sentry_sdk.init(
        dsn=dsn,
        environment=environment,
        release=release,
        integrations=[DjangoIntegration()],
        # The default is to attach the logged-in user's id, email and IP.
        # Off: an error tracker is not a place to accumulate a second copy of
        # the user table. `request_id` below is enough to find the request in
        # the logs, and the logs are where the detail lives.
        send_default_pii=False,
        before_send=scrub,
        # 10% of requests get a performance trace. Enough to see a query that
        # got slow; not enough to pay for tracing every search on a marketplace
        # whose traffic is mostly search.
        traces_sample_rate=0.1,
    )
    return True
