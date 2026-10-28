"""The API root — one NinjaAPI instance, deny-by-default.

Why Django Ninja rather than plain Django views or DRF:

* **The schema is the contract.** A `ninja.Schema` is a Pydantic model, so the
  request is parsed and typed before a handler runs, and the same class
  generates the OpenAPI document at `/api/docs`. That document is the Django
  answer to `packages/shared` — a client generates its types from it instead of
  hand-writing a second copy of every interface that then drifts.
* **Unknown keys are rejected**, because `Strict` sets `extra="forbid"`. A
  client sending `{"price_centimes": 1, "is_featured": true}` gets a 422, not a
  silently ignored field — and "silently ignored" is how privilege-escalation
  bugs hide.
* **`auth=` is set here, once, for everything.** Rule 2 says no endpoint is
  public unless explicitly marked so. Setting it on the API rather than per
  route inverts the failure mode: forgetting to write anything gives you a
  *locked* endpoint, not an open one. `auth=None` on a route is the only exit,
  and grepping for it lists the entire public surface of the app in one screen.

The routers stay in their apps. This file only decides what is mounted where,
so the URL layout is readable in one place.
"""

from ninja import NinjaAPI

from apps.accounts.api import admin_router, router as accounts_router
from apps.chat.api import public_router as chat_router
from apps.common.auth import API_AUTH
from apps.common.errors import register_exception_handlers
from apps.leads.api import agency_router as crm_router, public_router as inquiries_router
from apps.offers.api import agency_router as offers_agency_router, public_router as offers_router
from apps.reviews.api import (
    agency_router as reviews_agency_router,
    public_router as reviews_router,
)
from apps.trips.api import agency_router as manifest_router, public_router as trips_router

api = NinjaAPI(
    title="Rihlati API",
    version="1.0.0",
    description=(
        "Marketplace for verified travel agencies. "
        "Every route requires authentication unless stated otherwise."
    ),
    auth=API_AUTH,
    # CSRF is not configured here. In Django Ninja 1.x it belongs to the cookie
    # auth class, not to the API — see `SessionAuth` in apps/common/auth.py,
    # which inherits the check. Worth knowing because a `csrf=True` here is
    # accepted by neither version: Ninja 0.x took it, 1.x raises TypeError, and
    # nothing silently ignores it. If you find that argument in a tutorial, the
    # tutorial is for 0.x.
    urls_namespace="api",
)

register_exception_handlers(api)

api.add_router("/", offers_router)
api.add_router("/", offers_agency_router)
api.add_router("/", inquiries_router)
api.add_router("/", crm_router)
api.add_router("/", accounts_router)
api.add_router("/", admin_router)
api.add_router("/", manifest_router)
api.add_router("/", trips_router)
api.add_router("/", reviews_router)
api.add_router("/", reviews_agency_router)
# The per-offer assistant. Public because travelers have no account; scoped by
# an unguessable conversation token rather than by a session. See apps/chat/api.py.
api.add_router("/chat", chat_router)
