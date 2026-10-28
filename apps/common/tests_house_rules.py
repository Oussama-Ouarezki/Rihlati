"""The house rules, enforced by a machine instead of by a reviewer's memory.

This file is the Django answer to the custom `no-restricted-syntax` rules in the
NestJS repo's `eslint.config.mjs`. Each check below encodes a bug that has
actually happened, or a CLAUDE.md rule that a human would otherwise have to
catch by eye every single time. A rule a human has to remember is a rule that
gets forgotten on a Thursday afternoon.

Why a test and not a linter plugin: ruff does not support user-defined rules,
and a check nobody can read is a check nobody trusts. Forty lines of `ast`
sitting in the test suite is reviewable, runs in CI for free, and reports the
exact file and line.

To add a rule: write the visitor, name the bug it prevents in the docstring, and
say which of the seven rules it serves.
"""

import ast
from pathlib import Path

from django.test import SimpleTestCase

APPS_DIR = Path(__file__).resolve().parent.parent
PROJECT_DIR = APPS_DIR.parent


def source_files():
    """Every hand-written Python file in `apps/`, minus tests and migrations.

    Tests are exempt on purpose: they reach into the ORM directly to build
    states the API refuses to produce (an unverified agency owning a published
    offer, one tenant's row fetched to prove another tenant can't have it).
    Holding them to the production rules would mean writing the setup through
    the very API under test, which tests nothing.

    Migrations are generated, not authored.
    """
    for path in sorted(APPS_DIR.rglob("*.py")):
        parts = path.relative_to(APPS_DIR).parts
        if "migrations" in parts or path.name.startswith("test"):
            continue
        yield path


def parse(path):
    return ast.parse(path.read_text(encoding="utf-8"), filename=str(path))


def where(path, node):
    return f"{path.relative_to(PROJECT_DIR)}:{node.lineno}"


# Models whose rows belong to exactly one agency. Fetching one of these by
# primary key alone reads whichever agency's row happens to have that id.
#
# `Agency` itself is deliberately absent: its id *is* the tenant, and the
# membership check has already run by the time we look it up. The test is
# "could this selector name a row belonging to someone else?", not "does the
# model have an agency column".
TENANT_MODELS = {"Offer", "Lead", "ChatConversation", "AgencyAssistant"}

# Field names that hold a phone number in full.
PHONE_FIELDS = {"phone", "phone_e164", "whatsapp", "msisdn", "contact_phone"}

LOG_METHODS = {"debug", "info", "warning", "warn", "error", "exception", "critical"}


class TenantScopeTests(SimpleTestCase):
    """Rule 3 — every query on tenant data is scoped by the session's tenant."""

    def test_no_unscoped_get_on_a_tenant_model(self):
        """`Offer.objects.get(pk=...)` cannot also require an agency_id.

        The unique lookup happily returns another agency's row, and the handler
        that called it has no idea. The fix is always the same shape: filter by
        agency first, then `get_object_or_404` *inside* that queryset — which is
        exactly what `get_scoped_object()` in apps/common/tenancy.py does.
        """
        offences = []
        for path in source_files():
            for node in ast.walk(parse(path)):
                if not isinstance(node, ast.Call):
                    continue
                func = node.func
                # Match `<Model>.objects.get(...)` and `.objects.filter(...).get()`
                # is fine, so we only look at the `objects` attribute directly.
                if not isinstance(func, ast.Attribute) or func.attr != "get":
                    continue
                manager = func.value
                if not isinstance(manager, ast.Attribute) or manager.attr != "objects":
                    continue
                model = manager.value
                if isinstance(model, ast.Name) and model.id in TENANT_MODELS:
                    offences.append(f"{where(path, node)}  {model.id}.objects.get(...)")

        self.assertEqual(
            offences,
            [],
            "\n".join(
                [
                    "Unscoped read on a tenant-owned model — CLAUDE.md rule #3.",
                    "Use get_scoped_object(Model.objects, agency_id, pk=...) from",
                    "apps/common/tenancy.py. Offences:",
                    *offences,
                ]
            ),
        )

    def test_tenant_models_declare_a_non_null_agency(self):
        """Rule 3 starts in the schema: no nullable tenant column.

        A nullable `agency` means a row can exist that belongs to nobody, and a
        filter by agency will never find it again — an invisible row is a bug
        that only shows up as "the customer says it vanished".
        """
        from django.apps import apps as django_apps

        for model_name in sorted(TENANT_MODELS):
            model = next(m for m in django_apps.get_models() if m.__name__ == model_name)
            field = model._meta.get_field("agency")
            self.assertFalse(
                field.null,
                f"{model_name}.agency is nullable — CLAUDE.md rule #3.",
            )


class AuthorizationTests(SimpleTestCase):
    """Rule 2 — public is an explicit, countable decision."""

    # Every route an anonymous stranger on the internet can reach. Adding a
    # line here is the deliberate act; the test's whole job is to make sure
    # nobody adds one anywhere else.
    PUBLIC_OPERATIONS = {
        # The shop window. No account to browse — that is the product.
        "GET /api/offers",
        "GET /api/offers/{offer_id}",
        # A traveler inquires without an account. The conversion argument beat
        # the spam argument; see the open question in the README.
        "POST /api/inquiries",
        "GET /api/consent-text",  # the form fetches the wording it will record
        # Reporting a scam listing must not require being logged in, or the
        # people best placed to spot one never report it.
        "POST /api/offers/{offer_id}/report",
        # Reputation is public by definition. Writing one is gated inside the
        # handler on a completed lead, not by the auth layer.
        "GET /api/agencies/{agency_id}/reviews",
        "POST /api/reviews",
        # A traveler opens their trip page from an SMS link. The unguessable
        # code IS the credential — see the note in apps/trips/api.py.
        "GET /api/my-trip/{code}",
        # The per-offer assistant. Public because travelers have no account;
        # the returned 128-bit conversation token is the credential for the
        # rest of the exchange, and it names exactly one conversation.
        "POST /api/chat/offers/{offer_id}",
        # You cannot require a token in order to get a token.
        "POST /api/auth/login",
        "POST /api/auth/refresh",
    }

    def test_public_endpoints_are_the_ones_we_expect(self):
        """`auth=None` turns off deny-by-default for one route.

        This reads the generated **OpenAPI document**, not the source, and the
        difference matters twice over:

        * A route can become public by inheriting from a router mounted with
          `auth=None`. Grepping for the literal token on a decorator would
          never see that. The schema shows what actually ships.
        * An operation whose auth silently failed to resolve — neither declared
          public nor given a callback — also lands here with no `security`
          entry, so the same assertion catches the accident and the decision.
          A separate "did auth resolve?" test would be a second thing to
          maintain that this one already covers.

        The test doesn't ban public routes; a marketplace nobody can browse is
        not a marketplace. It pins the list, so adding one is an edit to this
        file with a reviewer attached.
        """
        from config.api import api

        schema = api.get_openapi_schema()

        found = {
            f"{method.upper()} {path}"
            for path, operations in schema["paths"].items()
            for method, operation in operations.items()
            # Ninja emits a `security` requirement for every authenticated
            # operation. Absent or empty means anyone may call it.
            if not operation.get("security")
        }

        self.assertEqual(
            found,
            self.PUBLIC_OPERATIONS,
            "The set of public API routes changed. Every entry is an endpoint "
            "an anonymous stranger can reach — CLAUDE.md rule #2. If the change "
            "is intended, update PUBLIC_OPERATIONS above and say why in the "
            "commit message.",
        )


class MembershipCheckTests(SimpleTestCase):
    """Rule 2 + 3 — a handler that names an agency must prove the caller owns it.

    This test exists to replace something the port lost. In NestJS the
    membership check was a **global guard** that armed itself whenever a route
    declared an `:agencyId` parameter: the thing that made a route
    tenant-scoped was the same thing that switched the check on, so there was
    no decorator to forget.

    Django Ninja has no equivalent hook that can see the URL parameter before
    dispatch, so here `require_membership()` is an ordinary function call at
    the top of each handler — and an ordinary function call can be left out.
    A convention plus a test that fails when the convention is broken is
    weaker than a mechanism, and much stronger than trusting a reviewer to
    notice a missing line in a 40-line diff.
    """

    # Calling any of these means the handler has thought about who may act.
    GATES = {"require_membership", "require_membership_or_404", "require_staff"}

    # Handlers that legitimately take an agency id without a membership check.
    # Each one is a decision, not an oversight, so each needs a reason here.
    EXEMPT = {
        # Public by design: reputation is readable by strangers. The handler
        # returns only published reviews of a VERIFIED agency, and the agency
        # id is not secret — it is in every agency's own public URLs.
        "list_reviews",
    }

    def handlers_taking_an_agency_id(self):
        for path in source_files():
            if path.name not in {"api.py", "views.py"}:
                continue
            for node in ast.walk(parse(path)):
                if not isinstance(node, ast.FunctionDef):
                    continue
                names = {arg.arg for arg in node.args.args}
                if "agency_id" in names and node.name not in self.EXEMPT:
                    yield path, node

    def test_every_handler_naming_an_agency_checks_membership(self):
        offences = []
        for path, node in self.handlers_taking_an_agency_id():
            called = {
                inner.func.id
                for inner in ast.walk(node)
                if isinstance(inner, ast.Call) and isinstance(inner.func, ast.Name)
            }
            if not called & self.GATES:
                offences.append(f"{where(path, node)}  {node.name}()")

        self.assertEqual(
            offences,
            [],
            "\n".join(
                [
                    "A handler takes `agency_id` from the URL and never proves the caller",
                    "belongs to that agency — CLAUDE.md rules #2 and #3. The URL is chosen",
                    "by the client and proves nothing. Call require_membership() (API) or",
                    "require_membership_or_404() (pages) before the first query, or add the",
                    "handler to EXEMPT above with the reason. Offences:",
                    *offences,
                ]
            ),
        )

    def test_the_exemption_list_has_not_gone_stale(self):
        """An exemption for a handler that no longer exists is worse than no
        list: it reads as "we thought about this" while silently covering
        nothing, and the next handler to reuse the name inherits the pass."""
        live = {
            node.name
            for path in source_files()
            if path.name in {"api.py", "views.py"}
            for node in ast.walk(parse(path))
            if isinstance(node, ast.FunctionDef)
        }
        self.assertEqual(self.EXEMPT - live, set(), "EXEMPT names a handler that is gone.")


class LoggingTests(SimpleTestCase):
    """Rule 4 — never log a full phone number."""

    def test_no_phone_number_reaches_a_log_call(self):
        """A traveler's phone number is the one piece of PII we hold that is
        directly abusable, and log aggregators are the least-protected place it
        could land. Mask it at the call site, not at the sink.
        """
        offences = []
        for path in source_files():
            for node in ast.walk(parse(path)):
                if not isinstance(node, ast.Call):
                    continue
                func = node.func
                if not isinstance(func, ast.Attribute) or func.attr not in LOG_METHODS:
                    continue
                for inner in ast.walk(node):
                    if isinstance(inner, ast.Attribute) and inner.attr in PHONE_FIELDS:
                        offences.append(f"{where(path, node)}  .{inner.attr}")

        self.assertEqual(
            offences,
            [],
            "A full phone number is being logged — CLAUDE.md rule #4. "
            "Mask it first. Offences:\n" + "\n".join(offences),
        )


class SecretsTests(SimpleTestCase):
    """Rule 1 — settings.py is committed, so nothing secret may be written in it."""

    def test_settings_reads_secrets_from_the_environment(self):
        """The failure this prevents is mundane and extremely common: someone
        pastes a working key into `settings.py` to unblock themselves at 11pm,
        the app works, and the key is in the repository forever. A key that has
        touched a commit is burned even if it is deleted in the next one.
        """
        settings_src = (PROJECT_DIR / "config" / "settings.py").read_text()
        tree = ast.parse(settings_src)

        secretish = ("SECRET", "PASSWORD", "TOKEN", "API_KEY", "DSN")
        for node in tree.body:
            if not isinstance(node, ast.Assign):
                continue
            for target in node.targets:
                if not isinstance(target, ast.Name):
                    continue
                if not any(word in target.id for word in secretish):
                    continue
                # A bare string literal is the bug. A call — os.environ.get(...)
                # — is the fix, whatever its default happens to be.
                self.assertNotIsInstance(
                    node.value,
                    ast.Constant,
                    f"{target.id} is a literal in config/settings.py, which is "
                    f"committed — CLAUDE.md rule #1. Read it from os.environ.",
                )


class MoneyTests(SimpleTestCase):
    """Rule 6 / locale — money is integer centimes, never a float."""

    def test_no_float_field_anywhere(self):
        """349 000,00 DZD is not exactly representable in binary. Store the
        smallest unit as an integer and divide only when you print it.

        This bites at the boundary, not in the database: a `FloatField` looks
        fine in tests with round numbers and is off by a centime on a real
        booking, which is how a customer's receipt and an agency's ledger stop
        agreeing.
        """
        from django.apps import apps as django_apps

        offences = [
            f"{model.__name__}.{field.name}"
            for model in django_apps.get_models()
            if model._meta.app_label.startswith(("accounts", "offers", "leads"))
            for field in model._meta.get_fields()
            if field.__class__.__name__ in {"FloatField", "DecimalField"}
        ]
        self.assertEqual(
            offences,
            [],
            "Money and quantities are integers here — CLAUDE.md, "
            f"'Language & locale'. Offences: {offences}",
        )


class TemplateCommentTests(SimpleTestCase):
    """Rule 7 — a template comment must not ship to the browser."""

    def test_no_multiline_hash_comment(self):
        """`{# ... #}` is single-line ONLY. Django's lexer matches it with a
        regex that never crosses a newline, so the moment the closing `#}`
        lands on a later line the whole block stops being a comment and is
        emitted as literal text, in the page, where a customer reads it.

        This is not hypothetical: on 2026-08-09 all twenty of these were
        leaking, on every page in the app, including the marketplace home page.
        The note explaining why the filter bar is a plain GET form was being
        rendered to travelers.

        The reason it survived so long is the interesting part, and it is the
        whole argument for M1 in the Milestone Plan: the suite was **green**
        the entire time. Every test asserts that some expected string is
        *present*; not one asserts that template source is *absent*, and no
        test renders a page and looks at it. A human opened the site and saw it
        in one second.

        Multi-line commentary belongs in `{% comment %}...{% endcomment %}`,
        which is a real block tag and is stripped properly.
        """
        offences = []
        for path in sorted((PROJECT_DIR / "templates").rglob("*.html")):
            for lineno, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
                if "{#" in line and "#}" not in line:
                    offences.append(f"{path.relative_to(PROJECT_DIR)}:{lineno}")
        self.assertEqual(
            offences,
            [],
            "`{# #}` does not span lines — use {% comment %}. These would "
            f"render as visible text on the page. Offences: {offences}",
        )
