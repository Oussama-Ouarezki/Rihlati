"""One envelope for every error the API returns.

```json
{
  "code": "VALIDATION_FAILED",
  "details": {"phone_e164": ["Enter an Algerian number in the +213… format."]},
  "requestId": "a1b2c3d4e5f60718"
}
```

Three deliberate choices:

* the client switches on `code`, never on the sentence — the sentence is copy,
  and a UI matching on prose breaks when someone fixes a typo;
* `details` is keyed by field name, so a form can highlight the exact input. A
  single "Bad request" is technically correct and practically useless;
* `requestId` is the same id in the `X-Request-Id` header and in every log line
  for this request. They quote the id, you find the log. Nothing else about the
  internals ever crosses the boundary — no stack trace, no SQL, no column name.
"""

from django.core.exceptions import PermissionDenied, ValidationError
from django.http import Http404
from ninja.errors import AuthenticationError, HttpError, ValidationError as NinjaValidationError

from apps.common.tenancy import Forbidden

STATUS_TO_CODE = {
    400: "VALIDATION_FAILED",
    401: "NOT_AUTHENTICATED",
    403: "FORBIDDEN",
    404: "NOT_FOUND",
    405: "METHOD_NOT_ALLOWED",
    409: "CONFLICT",
    422: "VALIDATION_FAILED",
    429: "RATE_LIMITED",
    503: "UNAVAILABLE",
}


def envelope(request, status, details=None, code=None):
    return {
        "code": code or STATUS_TO_CODE.get(status, "ERROR"),
        "details": details,
        "requestId": getattr(request, "request_id", None),
    }


def register_exception_handlers(api):
    @api.exception_handler(NinjaValidationError)
    def _validation(request, exc):
        # Pydantic reports a list of {loc, msg, type}. Reshape it to
        # {field: [messages]} so a form can highlight the offending input.
        details = {}
        for error in exc.errors:
            location = error.get("loc") or ["__all__"]
            field = str(location[-1])
            details.setdefault(field, []).append(error.get("msg", "Invalid."))
        return api.create_response(request, envelope(request, 422, details), status=422)

    @api.exception_handler(ValidationError)
    def _django_validation(request, exc):
        details = exc.message_dict if hasattr(exc, "message_dict") else {"__all__": exc.messages}
        return api.create_response(request, envelope(request, 400, details), status=400)

    @api.exception_handler(Http404)
    def _not_found(request, exc):
        return api.create_response(request, envelope(request, 404), status=404)

    @api.exception_handler(Forbidden)
    def _forbidden(request, exc):
        return api.create_response(request, envelope(request, 403, str(exc)), status=403)

    @api.exception_handler(PermissionDenied)
    def _permission_denied(request, exc):
        return api.create_response(request, envelope(request, 403), status=403)

    @api.exception_handler(AuthenticationError)
    def _unauthenticated(request, exc):
        return api.create_response(request, envelope(request, 401), status=401)

    @api.exception_handler(HttpError)
    def _http_error(request, exc):
        return api.create_response(
            request, envelope(request, exc.status_code, str(exc)), status=exc.status_code
        )

    # Anything not listed above is left to Django: an unhandled 500 is an
    # incident, and swallowing it into a tidy envelope is how an incident
    # becomes a mystery (Rule 4).
    return api
