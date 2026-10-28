"""One id, followed from the browser to the log line — CLAUDE.md rule #4.

The problem this solves is unglamorous and constant. An agency phones and says
"it broke around three o'clock". Without a shared id you are grepping a day of
logs for a phone number you are not allowed to log. With one, the error the
traveler saw carries an id, the response header carries the same id, and every
log line for that request carries it too — so "it broke" becomes one search.

The id is generated here rather than trusted from the client. A client-supplied
`X-Request-Id` is a free way to poison your own logs: an attacker sends the id
of someone else's request and the two are now indistinguishable in aggregate.
"""

import logging
import uuid

logger = logging.getLogger("rihlati.request")


class RequestIdMiddleware:
    """Attach `request.request_id`, echo it back, and log the exchange.

    `apps.common.errors.typed_exception_handler` reads the attribute set here
    and puts it in the error envelope, so the id the user can read off the
    screen is the id in the log.
    """

    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        request.request_id = uuid.uuid4().hex[:16]

        response = self.get_response(request)
        response["X-Request-Id"] = request.request_id

        # Deliberately not logging query strings or POST bodies. A search URL is
        # harmless; `?phone=+213...` on some future endpoint is not, and the
        # difference is impossible to enforce once the habit exists.
        logger.info(
            "%s %s %s",
            request.method,
            request.path,
            response.status_code,
            extra={"request_id": request.request_id},
        )
        return response
