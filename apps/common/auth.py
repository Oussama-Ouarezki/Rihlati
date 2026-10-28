"""Authentication for the JSON API — who are you, and nothing more.

Two mechanisms, for two kinds of caller:

* a **person in a browser** authenticates with the session cookie Django
  already issues. The cookie is HttpOnly, so an XSS bug cannot read it.
* a **program** (mobile app, script, a future LLM tool-call) sends a bearer
  access token. No cookie jar, no CSRF concept.

Access tokens are produced with `django.core.signing`, not a JWT library.
That is a deliberate choice, and the reasoning is worth reading once:

`signing.dumps()` gives an HMAC-signed, timestamped payload verified against
SECRET_KEY, which is exactly what a JWT's HS256 mode gives — minus a
dependency, minus the algorithm-confusion class of bug (`"alg": "none"` and
friends), and minus the temptation to put things in a token that should be
read from the database. If a third party ever needs to *verify* our tokens
without our secret, that is the day to switch to real asymmetric JWTs. Nothing
in Rihlati needs that.

What is deliberately NOT in the token: roles, memberships, `is_superuser`.
Those are read from the database on every request, so revoking access bites
immediately rather than whenever a token happens to expire.
"""

import hashlib
import uuid

from django.core import signing
from django.utils import timezone
from ninja.security import HttpBearer, SessionAuth as NinjaSessionAuth

from apps.accounts.models import RefreshToken, User, generate_token

ACCESS_SALT = "rihlati.access"
ACCESS_TTL_SECONDS = 15 * 60
REFRESH_TTL_DAYS = 30


def issue_access_token(user):
    """15 minutes. Short enough that a leaked token is a small window, long
    enough that a phone on a bad connection is not re-authenticating mid-form."""
    return signing.dumps({"uid": str(user.pk)}, salt=ACCESS_SALT)


def read_access_token(raw):
    try:
        data = signing.loads(raw, salt=ACCESS_SALT, max_age=ACCESS_TTL_SECONDS)
    except signing.BadSignature:
        return None
    try:
        return User.objects.get(pk=data["uid"], is_active=True)
    except (User.DoesNotExist, KeyError, ValueError):
        return None


def hash_token(raw):
    """SHA-256, not a password hasher.

    A password is low-entropy and guessable, so it needs a deliberately slow
    hash. A 256-bit random token is not guessable, so slowness buys nothing and
    costs a database round-trip's worth of CPU on every refresh. The reason to
    hash at all is the same either way: a database dump must not contain live
    credentials.
    """
    return hashlib.sha256(raw.encode()).hexdigest()


def issue_refresh_token(user, family=None):
    raw = generate_token()
    RefreshToken.objects.create(
        user=user,
        token_hash=hash_token(raw),
        family=family or uuid.uuid4(),
        expires_at=timezone.now() + timezone.timedelta(days=REFRESH_TTL_DAYS),
    )
    return raw


def rotate_refresh_token(raw):
    """Spend one refresh token and mint its successor.

    Returns `(user, new_raw_refresh)` or `None`.

    The reuse rule is the interesting part. A refresh token is single-use. If
    one arrives that has already been spent, two parties hold it — the
    legitimate client and a thief — and there is no way to tell which one is
    calling. So the whole family is revoked and everybody re-authenticates.

    That sounds harsh until you notice what it buys: the theft is detected by
    the *victim's own normal activity*, with no monitoring, no heuristics, and
    nobody noticing anything was wrong.
    """
    token = RefreshToken.objects.filter(token_hash=hash_token(raw)).select_related("user").first()
    if token is None:
        return None

    if token.used_at is not None or token.revoked_at is not None:
        RefreshToken.objects.filter(family=token.family, revoked_at__isnull=True).update(
            revoked_at=timezone.now()
        )
        return None

    if not token.is_live:
        return None

    token.used_at = timezone.now()
    token.revoked_at = timezone.now()
    token.save(update_fields=["used_at", "revoked_at", "updated_at"])
    return token.user, issue_refresh_token(token.user, family=token.family)


def revoke_all_for_user(user):
    RefreshToken.objects.filter(user=user, revoked_at__isnull=True).update(
        revoked_at=timezone.now()
    )


class BearerAuth(HttpBearer):
    def authenticate(self, request, token):
        user = read_access_token(token)
        if user is None:
            return None
        request.user = user
        return user


class SessionAuth(NinjaSessionAuth):
    """The browser half. Django's own session, already loaded by
    AuthenticationMiddleware — this only reads the answer.

    It subclasses Ninja's `SessionAuth` rather than reimplementing it, because
    the base class carries the CSRF check and a hand-written version would not.
    That matters more here than anywhere else in the file: a browser attaches
    the session cookie to *any* request to our domain, including one triggered
    by a form on someone else's site. A bearer token is never sent that way, so
    the token half needs no equivalent — CSRF is a cookie problem, not an
    authentication problem in general.

    The one thing changed from the base: the CSRF check is skipped when there
    is no session cookie at all. Ninja runs it unconditionally, so an anonymous
    POST to a protected route answers `403 CSRF check Failed` — which is a
    misleading thing to tell a mobile client whose token simply expired. With
    no cookie there is no cookie to forge, so the honest answer is 401.
    """

    def _get_key(self, request):
        if self.param_name not in request.COOKIES:
            return None
        return super()._get_key(request)


# Order matters only for the OpenAPI document; either may satisfy a request.
API_AUTH = [BearerAuth(), SessionAuth()]
