"""Authentication — the three routes a stranger may call, and what they refuse.

Every other test file in this project asserts *authorization*: given a logged-in
user, may they touch this row. This one is a layer below that. It asserts that
being logged in means something in the first place, and that the four ways to
stop being logged in — expiry, rotation, logout, deactivation — all actually
stop it.

The interesting half is refresh-token rotation. A refresh token lives for
thirty days, which is thirty days of damage if one leaks, so it is single-use:
spending it mints a successor and kills the original. That gives theft
detection for free — if a spent token comes back, two parties hold it, and
there is no way to tell the thief from the victim, so the whole family is
revoked and both re-authenticate. `test_a_replayed_refresh_token_burns_the_
whole_family` is that rule, and it is the one test here worth reading twice.
"""

import json
from unittest import mock

from django.test import TestCase, override_settings
from django.utils import timezone

from apps.accounts.models import RefreshToken
from apps.common.auth import (
    hash_token,
    issue_access_token,
    issue_refresh_token,
    read_access_token,
)
from apps.common.testing import TEST_PASSWORD, make_user

LOGIN = "/api/auth/login"
REFRESH = "/api/auth/refresh"
LOGOUT = "/api/auth/logout"
ME = "/api/me"


class AuthTestCase(TestCase):
    def post(self, path, body, user=None):
        headers = {"HTTP_AUTHORIZATION": f"Bearer {issue_access_token(user)}"} if user else {}
        return self.client.post(
            path, data=json.dumps(body), content_type="application/json", **headers
        )

    def login(self, username, password):
        return self.post(LOGIN, {"username": username, "password": password})


class LoginTests(AuthTestCase):
    def setUp(self):
        self.user = make_user("amina")

    def test_correct_credentials_return_a_pair_of_tokens(self):
        response = self.login("amina", TEST_PASSWORD)
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertTrue(body["access_token"])
        self.assertTrue(body["refresh_token"])
        self.assertEqual(body["expires_in"], 15 * 60)

    def test_login_needs_no_token_of_its_own(self):
        """Obvious, and worth pinning: the API is deny-by-default, so `auth=None`
        on this route is the exit. If a refactor drops it, every user is locked
        out of a system they can no longer log into to fix."""
        self.assertEqual(self.login("amina", TEST_PASSWORD).status_code, 200)

    def test_a_wrong_password_and_an_unknown_user_are_indistinguishable(self):
        """Account enumeration. If "no such user" reads differently from "wrong
        password", anyone can check whether an address is registered here — and
        knowing that is half of a convincing phishing email."""
        wrong_password = self.login("amina", "not-the-password")
        no_such_user = self.login("nobody-at-all", TEST_PASSWORD)
        self.assertEqual(wrong_password.status_code, 401)
        self.assertEqual(no_such_user.status_code, 401)

        # Everything except `requestId`, which is per-request by design and is
        # the one field that is *supposed* to differ between two responses.
        def told(response):
            body = response.json()
            return body["code"], body["details"]

        self.assertEqual(told(wrong_password), told(no_such_user))

    def test_a_deactivated_user_cannot_log_in(self):
        self.user.is_active = False
        self.user.save(update_fields=["is_active"])
        self.assertEqual(self.login("amina", TEST_PASSWORD).status_code, 401)

    def test_an_unknown_field_in_the_body_is_refused(self):
        """`Strict` forbids extras everywhere, but here specifically: a login
        body is the one payload a stranger fully controls, and a handler that
        quietly ignores `{"is_staff": true}` today is one careless
        `**payload.dict()` away from honouring it."""
        response = self.post(
            LOGIN, {"username": "amina", "password": TEST_PASSWORD, "is_staff": True}
        )
        self.assertEqual(response.status_code, 422)


class AccessTokenTests(AuthTestCase):
    def setUp(self):
        self.user = make_user("amina")

    def get_me(self, raw_token):
        return self.client.get(ME, HTTP_AUTHORIZATION=f"Bearer {raw_token}")

    def test_a_fresh_token_identifies_its_user(self):
        response = self.get_me(issue_access_token(self.user))
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["username"], "amina")

    def test_no_token_at_all_is_401(self):
        self.assertEqual(self.client.get(ME).status_code, 401)

    def test_a_forged_token_is_401(self):
        self.assertEqual(self.get_me("not.a.real.token").status_code, 401)

    def test_a_tampered_payload_is_401(self):
        """The signature covers the payload, so flipping one character of a
        real token breaks it rather than editing whose token it is."""
        token = issue_access_token(self.user)
        tampered = token[:-1] + ("a" if token[-1] != "a" else "b")
        self.assertEqual(self.get_me(tampered).status_code, 401)

    def test_a_token_signed_for_a_different_purpose_is_401(self):
        """`salt=` is namespacing. Without it, any signed value the app
        produces elsewhere — an unsubscribe link, a password-reset code —
        would be accepted here, because they all share SECRET_KEY."""
        from django.core import signing

        other = signing.dumps({"uid": str(self.user.pk)}, salt="rihlati.something-else")
        self.assertIsNone(read_access_token(other))

    def test_an_expired_token_is_refused(self):
        token = issue_access_token(self.user)
        with mock.patch("apps.common.auth.ACCESS_TTL_SECONDS", -1):
            self.assertIsNone(read_access_token(token))

    def test_deactivating_a_user_kills_a_token_that_has_not_expired(self):
        """This is why the token carries a user id and nothing else. Roles,
        memberships and `is_active` are read from the database on every
        request, so revoking access bites now rather than in fifteen minutes."""
        token = issue_access_token(self.user)
        self.assertEqual(self.get_me(token).status_code, 200)
        self.user.is_active = False
        self.user.save(update_fields=["is_active"])
        self.assertEqual(self.get_me(token).status_code, 401)


class RefreshRotationTests(AuthTestCase):
    def setUp(self):
        self.user = make_user("amina")
        self.raw = issue_refresh_token(self.user)

    def refresh(self, raw):
        return self.post(REFRESH, {"refresh_token": raw})

    def test_the_raw_token_is_never_stored(self):
        """A database dump must not contain live credentials. The row holds a
        SHA-256 of the token; the token itself is shown once and forgotten."""
        row = RefreshToken.objects.get(user=self.user)
        self.assertNotEqual(row.token_hash, self.raw)
        self.assertEqual(row.token_hash, hash_token(self.raw))

    def test_a_refresh_returns_a_new_pair(self):
        response = self.refresh(self.raw)
        self.assertEqual(response.status_code, 200)
        self.assertNotEqual(response.json()["refresh_token"], self.raw)

    def test_a_spent_token_cannot_be_spent_twice(self):
        self.assertEqual(self.refresh(self.raw).status_code, 200)
        self.assertEqual(self.refresh(self.raw).status_code, 401)

    def test_the_successor_stays_in_the_same_family(self):
        """One login, one family. That is what makes the revocation below
        surgical instead of logging the user out of every device."""
        new_raw = self.refresh(self.raw).json()["refresh_token"]
        families = set(RefreshToken.objects.filter(user=self.user).values_list("family", flat=True))
        self.assertEqual(len(families), 1)
        self.assertTrue(RefreshToken.objects.get(token_hash=hash_token(new_raw)).is_live)

    def test_a_replayed_refresh_token_burns_the_whole_family(self):
        """The theft-detection rule, end to end.

        A thief copies the refresh token and uses it. The real client then
        refreshes on its normal schedule and presents the same, now-spent
        token. Two parties hold it and nothing in the request says which is
        which — so both are logged out. The victim notices a re-login; the
        thief loses the account. The detection cost no monitoring at all.
        """
        stolen = self.raw
        thief_new = self.refresh(stolen).json()["refresh_token"]

        self.assertEqual(self.refresh(stolen).status_code, 401)

        # And the token the thief just earned is dead too.
        self.assertEqual(self.refresh(thief_new).status_code, 401)
        self.assertFalse(RefreshToken.objects.filter(user=self.user, revoked_at=None).exists())

    def test_an_expired_refresh_token_is_refused(self):
        row = RefreshToken.objects.get(user=self.user)
        row.expires_at = timezone.now() - timezone.timedelta(seconds=1)
        row.save(update_fields=["expires_at"])
        self.assertEqual(self.refresh(self.raw).status_code, 401)

    def test_an_unknown_refresh_token_is_refused_without_touching_anything(self):
        self.assertEqual(self.refresh("made-up").status_code, 401)
        self.assertTrue(RefreshToken.objects.get(user=self.user).is_live)


class LogoutTests(AuthTestCase):
    def setUp(self):
        self.user = make_user("amina")

    def test_logout_requires_being_logged_in(self):
        self.assertEqual(self.post(LOGOUT, {}).status_code, 401)

    def test_logout_revokes_every_token_not_just_the_current_one(self):
        """Logging out on a device you are worried about has to mean it. A
        partial logout that leaves a stolen token alive is worse than none,
        because the user now believes they are safe."""
        phone = issue_refresh_token(self.user)
        laptop = issue_refresh_token(self.user)

        self.assertEqual(self.post(LOGOUT, {}, user=self.user).status_code, 200)

        for raw in (phone, laptop):
            self.assertEqual(self.post(REFRESH, {"refresh_token": raw}).status_code, 401)

    def test_logout_does_not_touch_another_user(self):
        other = make_user("karim")
        other_raw = issue_refresh_token(other)
        issue_refresh_token(self.user)

        self.post(LOGOUT, {}, user=self.user)

        self.assertEqual(self.post(REFRESH, {"refresh_token": other_raw}).status_code, 200)


class ThrottleTests(AuthTestCase):
    """The limit on the routes a stranger may call.

    `override_settings(CACHES=...)` per test, because throttle counters live in
    the cache and a count left behind by one test would fail the next one for
    no reason anybody could see. Each test gets its own namespace instead.
    """

    def setUp(self):
        self.user = make_user("amina")

    @override_settings(
        CACHES={
            "default": {
                "BACKEND": "django.core.cache.backends.locmem.LocMemCache",
                "LOCATION": "throttle-login",
            }
        }
    )
    def test_the_eleventh_login_attempt_in_the_window_is_refused(self):
        for _ in range(10):
            self.assertEqual(self.login("amina", "wrong").status_code, 401)

        response = self.login("amina", "wrong")
        self.assertEqual(response.status_code, 429)
        self.assertEqual(response.json()["code"], "RATE_LIMITED")

    @override_settings(
        CACHES={
            "default": {
                "BACKEND": "django.core.cache.backends.locmem.LocMemCache",
                "LOCATION": "throttle-correct",
            }
        }
    )
    def test_the_limit_counts_attempts_not_failures(self):
        """A successful login costs a try like any other.

        Counting only failures sounds friendlier and is useless: an attacker
        working through a stolen password list *wants* to succeed, and every
        request that gets a real answer is progress. The thing being limited is
        how fast a source may ask the question.
        """
        for _ in range(10):
            self.assertEqual(self.login("amina", TEST_PASSWORD).status_code, 200)
        self.assertEqual(self.login("amina", TEST_PASSWORD).status_code, 429)

    @override_settings(
        CACHES={
            "default": {
                "BACKEND": "django.core.cache.backends.locmem.LocMemCache",
                "LOCATION": "throttle-ip",
            }
        }
    )
    def test_the_bucket_is_the_source_not_the_account(self):
        """The whole point of limiting per IP.

        One address hammering `amina` must not stop `karim` — or anyone else —
        from logging in from their own machine. Account lockout would do
        exactly that, and would hand every user a button that locks out any
        competitor whose email they know.
        """
        make_user("karim")
        for _ in range(10):
            self.login("amina", "wrong")

        self.assertEqual(self.login("amina", "wrong").status_code, 429)
        blocked = self.client.post(
            LOGIN,
            data=json.dumps({"username": "karim", "password": TEST_PASSWORD}),
            content_type="application/json",
            REMOTE_ADDR="10.0.0.9",
        )
        self.assertEqual(blocked.status_code, 200)

    @override_settings(
        CACHES={
            "default": {
                "BACKEND": "django.core.cache.backends.locmem.LocMemCache",
                "LOCATION": "throttle-xff",
            }
        }
    )
    def test_a_forged_x_forwarded_for_header_does_not_buy_a_fresh_bucket(self):
        """`NINJA_NUM_PROXIES = 0` is what makes this pass.

        Left unset, Django Ninja keys the bucket on `X-Forwarded-For` when the
        header is present — and that header is chosen by the caller. A new
        value on every request means a new bucket on every request, and the
        limit silently stops existing while still looking configured.
        """
        for index in range(10):
            self.client.post(
                LOGIN,
                data=json.dumps({"username": "amina", "password": "wrong"}),
                content_type="application/json",
                HTTP_X_FORWARDED_FOR=f"203.0.113.{index}",
            )

        response = self.client.post(
            LOGIN,
            data=json.dumps({"username": "amina", "password": "wrong"}),
            content_type="application/json",
            HTTP_X_FORWARDED_FOR="203.0.113.200",
        )
        self.assertEqual(response.status_code, 429)


class SessionAuthTests(AuthTestCase):
    """The browser half. Same API, a cookie instead of a header."""

    def setUp(self):
        self.user = make_user("amina")

    def test_a_session_cookie_authenticates_the_api_too(self):
        """One API, two doors. The mobile app sends a bearer token; a page
        served by Django already has a session, and making it fetch a token
        would mean handing a token to JavaScript — which is the thing the
        HttpOnly cookie exists to avoid."""
        self.client.force_login(self.user)
        response = self.client.get(ME)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["username"], "amina")

    def test_an_anonymous_post_is_401_and_not_a_csrf_error(self):
        """Ninja's SessionAuth runs the CSRF check unconditionally, so an
        anonymous POST answers `403 CSRF check Failed` — a misleading thing to
        tell a mobile client whose token simply expired. With no cookie there
        is nothing to forge, so the honest answer is 401. This test guards the
        one-method override in `apps/common/auth.py` that arranges it."""
        response = self.client.post(LOGOUT, data="{}", content_type="application/json")
        self.assertEqual(response.status_code, 401)
