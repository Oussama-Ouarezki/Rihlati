"""Rule 4, tested rather than asserted.

"We redact PII in logs" is the kind of claim that is true on the day it is
written and false eight commits later. These tests are cheap and they are the
only thing standing between a good intention and a log aggregator full of
travelers' phone numbers.
"""

import json
import logging

from django.http import Http404
from django.test import SimpleTestCase, TestCase
from django.urls import reverse

from apps.common.logging import JsonFormatter, mask_phone, redact
from apps.common.observability import init_error_reporting, scrub


class RedactionTests(SimpleTestCase):
    def test_a_phone_number_never_survives_a_log_line(self):
        line = redact("lead created for +213555111222 on offer x")
        self.assertNotIn("555111222", line)
        self.assertIn("+21355***222", line)

    def test_a_locally_formatted_number_is_caught_too(self):
        """The regex is deliberately greedy. An agent pasting `0555 11 12 22`
        into a note is the realistic case, and it is still a phone number.
        """
        self.assertNotIn("0555 11 12 22", redact("called 0555 11 12 22 twice"))

    def test_a_uuid_in_a_path_survives_intact(self):
        """Regression. The first version of PHONE matched "digits and dashes",
        which is also the shape of half a UUID — so every request path in the
        logs came out as `/a/8005579e-7de8-4e54-9f25-213***273a5d0/`, and the
        logs stopped being searchable by the id you actually have.

        Over-redaction is not the safe side of this trade when it destroys the
        thing you log for.
        """
        path = "/a/8005579e-7de8-4e54-9f25-213c273a5d0/offers/ 404"
        self.assertEqual(redact(f"GET {path}"), f"GET {path}")

    def test_a_uuid_made_only_of_digits_survives_too(self):
        """The nastier version of the same bug: no letters to save you."""
        path = "/a/12345678-1234-4123-9123-123456789012/leads/"
        self.assertEqual(redact(path), path)

    def test_secret_shaped_assignments_are_masked(self):
        for line in (
            'password="hunter2-and-more"',
            "api_key: sk-abcdef123456",
            'Authorization: "Token abc123def456"',
        ):
            with self.subTest(line=line):
                out = redact(line)
                self.assertIn("***", out)
                self.assertNotIn("hunter2", out)
                self.assertNotIn("sk-abcdef", out)
                self.assertNotIn("abc123def456", out)

    def test_mask_keeps_enough_to_confirm_and_not_enough_to_dial(self):
        self.assertEqual(mask_phone("+213555111222"), "+21355***222")
        # Too short to be a real number: give up entirely rather than leak most
        # of it. Half a phone number is still a phone number to a determined
        # reader with a list of prefixes.
        self.assertEqual(mask_phone("12345"), "***")

    def test_an_exception_traceback_is_redacted_as_well(self):
        """A traceback prints the repr of every local, and a local named `lead`
        prints whatever `__str__` returns. That path bypasses the message.
        """
        try:
            raise ValueError("failed for +213555111222")
        except ValueError:
            import sys

            record = logging.LogRecord("t", logging.ERROR, __file__, 1, "boom", (), sys.exc_info())
        out = JsonFormatter().format(record)
        self.assertNotIn("555111222", out)


class RequestIdTests(TestCase):
    def test_every_response_carries_an_id(self):
        res = self.client.get(reverse("search"))
        self.assertIn("X-Request-Id", res)
        self.assertTrue(res["X-Request-Id"])

    def test_two_requests_get_two_ids(self):
        """Shared ids would make the header worse than useless — it would look
        like correlation while grouping unrelated requests together.
        """
        first = self.client.get(reverse("search"))["X-Request-Id"]
        second = self.client.get(reverse("search"))["X-Request-Id"]
        self.assertNotEqual(first, second)

    def test_a_client_supplied_id_is_not_trusted(self):
        """Accepting `X-Request-Id` from the client is a free way to poison your
        own logs: send someone else's id and the two requests become
        indistinguishable in aggregate.
        """
        res = self.client.get(reverse("search"), HTTP_X_REQUEST_ID="attacker-chosen")
        self.assertNotEqual(res["X-Request-Id"], "attacker-chosen")

    def test_the_error_envelope_carries_the_same_id_as_the_header(self):
        """This is the whole point: the id a user reads off the screen is the id
        you grep for.

        Note the URL has no trailing slash. Ninja registers routes exactly as
        written, so `/offers/` would miss the API entirely and be answered by
        Django's own 404 — which carries no envelope, and would make this test
        pass or fail for reasons unrelated to what it is checking.
        """
        res = self.client.get("/api/agencies/00000000-0000-0000-0000-000000000000/offers")
        self.assertEqual(res.status_code, 401)
        body = json.loads(res.content)
        self.assertEqual(body["requestId"], res["X-Request-Id"])


class ErrorReportingTests(SimpleTestCase):
    """The crash report is the one place PII leaks by accident.

    Logs are written by us, line by line, so redaction there is about
    discipline. A crash report is assembled by a library out of whatever the
    request happened to contain — body, headers, local variables — and nobody
    chose any of it. So the scrubber is tested against the shapes that actually
    carry a phone number or a token.
    """

    def test_reporting_is_off_without_a_dsn(self):
        """An empty DSN must be an ordinary no-op, not a crash and not a
        warning. Otherwise every local run and every CI job pays for a feature
        that only makes sense in production."""
        self.assertFalse(init_error_reporting("", environment="test"))

    def test_a_phone_number_in_the_request_body_is_scrubbed(self):
        event = {"request": {"data": {"phone_e164": "+213555111222"}}}
        scrubbed = scrub(event, {})
        self.assertNotIn("555111222", json.dumps(scrubbed))

    def test_an_authorization_header_is_scrubbed(self):
        event = {"request": {"headers": {"Authorization": "Bearer abcdef123456"}}}
        scrubbed = scrub(event, {})
        self.assertNotIn("abcdef123456", json.dumps(scrubbed))

    def test_a_phone_number_nested_in_a_list_is_scrubbed(self):
        """The walk has to recurse. Sentry nests exception values inside
        `exception.values[]`, which is exactly where the message that mentions
        a lead's phone number ends up."""
        event = {"exception": {"values": [{"value": "lead +213555111222 failed"}]}}
        self.assertNotIn("555111222", json.dumps(scrub(event, {})))

    def test_an_expected_error_is_not_reported(self):
        """A 404 is the application working correctly. A tracker full of them
        is a tracker everyone learns to scroll past — and then the real crash
        arrives and nobody looks."""
        hint = {"exc_info": (Http404, Http404("no such offer"), None)}
        self.assertIsNone(scrub({"message": "boom"}, hint))

    def test_an_unexpected_error_is_reported(self):
        hint = {"exc_info": (ValueError, ValueError("genuinely broken"), None)}
        self.assertIsNotNone(scrub({"message": "boom"}, hint))

    def test_the_scrubber_leaves_non_string_values_alone(self):
        """Timestamps and status codes are the whole point of the report.
        A scrubber that stringifies everything makes the report unreadable."""
        event = {"level": "error", "timestamp": 1735689600, "tags": {"status": 500}}
        self.assertEqual(scrub(event, {}), event)
