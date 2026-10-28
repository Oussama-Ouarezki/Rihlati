"""Rate limits for the routes a stranger may call.

Only three routes in the whole API accept a payload from someone who has not
proved who they are — login, refresh, and the inquiry form. Everything else is
behind authentication, where the account itself is the limit. So this file is
short on purpose: a limit on an authenticated route protects against a
misbehaving client, while a limit on these three protects against an attacker,
and only the second one is urgent.

> Limits are **per source, never per account.**

That is the decision worth reading twice. "Lock the account after five failed
attempts" sounds safer and hands everyone a weapon: type wrong passwords at a
competitor's owner account and lock them out of their own CRM during Ramadan
booking season. There is no way for the server to tell that attack from a
genuine forgotten password, so account lockout turns a login form into a
denial-of-service button pointed at your own users. Limiting the *source* slows
guessing down without creating the weapon.

The counters live in Django's cache. See the warnings in `config/settings.py`
about what that means with the default local-memory backend.
"""

from ninja.throttling import AnonRateThrottle

# Ten tries per quarter of an hour. Enough that a person mistyping a password
# on a phone keyboard never notices; far too slow to work through a password
# list. The number is a guess informed by nothing but judgement — when there
# are real logs, count how often a real user hits five and adjust.
LOGIN_RATE = "10/15m"

# Refresh is called by software on a schedule, not by a person, so a client
# hitting this is either broken or replaying stolen tokens. Higher than login
# because one browser tab with several components can legitimately refresh in a
# burst; still low enough that harvesting is impractical.
REFRESH_RATE = "30/15m"

# The public lead form. See Duplicate and Spam Control for the *content* side
# of this — the same phone number twice in ten minutes is caught there, by
# looking at the data. This is the blunter half: one machine, many identities.
INQUIRY_RATE = "20/1h"

# The public assistant. There is no invoice per message, but there is a 14B
# model on one machine: a caller who ignores the page and loops the endpoint can
# hold it hostage for everyone else. Thirty messages an hour is plenty for a
# traveler choosing a trip, and far too few to run a free chatbot service.
CHAT_RATE = "30/1h"


class LoginThrottle(AnonRateThrottle):
    scope = "login"

    def __init__(self):
        super().__init__(LOGIN_RATE)


class RefreshThrottle(AnonRateThrottle):
    scope = "refresh"

    def __init__(self):
        super().__init__(REFRESH_RATE)


class InquiryThrottle(AnonRateThrottle):
    scope = "inquiry"

    def __init__(self):
        super().__init__(INQUIRY_RATE)


class ChatThrottle(AnonRateThrottle):
    scope = "chat"

    def __init__(self):
        super().__init__(CHAT_RATE)
