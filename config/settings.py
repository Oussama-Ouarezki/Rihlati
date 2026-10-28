"""
Settings. Same posture as the seven rules in CLAUDE.md require:
nothing secret is hardcoded, and DEBUG is opt-in via the environment.

This file is committed, so every value in it is public by definition. That is
the whole reason secrets are read rather than written — see rule #1, and
`SecretsTests` in `apps/common/tests_house_rules.py`, which fails the build if
anyone writes a literal key here.
"""

import os
from pathlib import Path
from urllib.parse import urlparse

from apps.common.observability import init_error_reporting

BASE_DIR = Path(__file__).resolve().parent.parent

# Rule 1: secrets come from the environment. The fallback exists so `manage.py`
# runs out of the box on a fresh clone — it is a development convenience and a
# bug in production, which is why DJANGO_SECRET_KEY is in `.env.example`.
SECRET_KEY = os.environ.get("DJANGO_SECRET_KEY", "dev-only-not-a-real-secret")

# Rule 4: DEBUG=True renders the settings module, the SQL and the environment
# onto the error page for anyone who triggers a 500. Defaulting it to on is
# right for a laptop and catastrophic on a server, so it is an explicit
# environment variable rather than a guess about which one you are on.
DEBUG = os.environ.get("DJANGO_DEBUG", "1") == "1"
ALLOWED_HOSTS = os.environ.get("DJANGO_ALLOWED_HOSTS", "localhost,127.0.0.1").split(",")

INSTALLED_APPS = [
    "django.contrib.admin",
    "django.contrib.auth",
    "django.contrib.contenttypes",
    "django.contrib.sessions",
    "django.contrib.messages",
    "django.contrib.staticfiles",
    # django-ninja is not listed here on purpose: it ships no models, no
    # templates and no migrations, so it needs no app registry entry. It is
    # wired in at config/api.py instead.
    "apps.accounts",
    "apps.offers",
    "apps.leads",
    "apps.trips",
    "apps.reviews",
    "apps.pages",
    "apps.chat",
    # Dev-only tooling (e.g. `manage.py graph_models` for ER diagrams).
    # Never loaded when DEBUG is off, so it never ships to production.
    *(["django_extensions"] if DEBUG else []),
]

MIDDLEWARE = [
    "django.middleware.security.SecurityMiddleware",
    # First after security, so the id exists before anything else can fail and
    # want to mention it.
    "apps.common.middleware.RequestIdMiddleware",
    "django.contrib.sessions.middleware.SessionMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.middleware.csrf.CsrfViewMiddleware",
    "django.contrib.auth.middleware.AuthenticationMiddleware",
    "django.contrib.messages.middleware.MessageMiddleware",
]

ROOT_URLCONF = "config.urls"

TEMPLATES = [
    {
        "BACKEND": "django.template.backends.django.DjangoTemplates",
        "DIRS": [BASE_DIR / "templates"],
        "APP_DIRS": True,
        "OPTIONS": {
            "context_processors": [
                "django.template.context_processors.request",
                "django.template.context_processors.i18n",
                "django.contrib.auth.context_processors.auth",
                "django.contrib.messages.context_processors.messages",
            ],
        },
    },
]

WSGI_APPLICATION = "config.wsgi.application"


# SQLite locally, Postgres wherever DATABASE_URL is set (CI, staging, prod).
#
# Rule 5 in spirit: SQLite is a development convenience, never the production
# database. It is single-writer, has no real concurrency story, and disagrees
# with Postgres on exactly the things this app leans on — JSON lookups, case
# sensitivity, and constraint enforcement. So CI runs on Postgres: a test that
# only passes on SQLite is a test that has not tested anything.
#
# Parsed by hand rather than with `dj-database-url`, to keep the dependency
# list at two packages. If this grows a third case, take the dependency.
def _database_from_url(url):
    parsed = urlparse(url)
    return {
        "ENGINE": "django.db.backends.postgresql",
        "NAME": parsed.path.lstrip("/"),
        "USER": parsed.username or "",
        "PASSWORD": parsed.password or "",
        "HOST": parsed.hostname or "",
        "PORT": str(parsed.port or ""),
    }


DATABASE_URL = os.environ.get("DATABASE_URL", "")
DATABASES = {
    "default": _database_from_url(DATABASE_URL)
    if DATABASE_URL
    else {
        "ENGINE": "django.db.backends.sqlite3",
        "NAME": BASE_DIR / "preview.sqlite3",
    }
}

AUTH_USER_MODEL = "accounts.User"

# Rule 2 — deny by default — is configured on the NinjaAPI instance in
# config/api.py rather than here, because that is where the routes are: an
# `auth=` sitting next to `add_router()` is a setting somebody reads while
# adding a route. See that file for why it is set once at the root.

# Rule 4: structured logs with a request id, from day one rather than after the
# first incident. JSON because a human reads maybe ten log lines a year and a
# log aggregator reads all of them — optimise for the machine that does the
# searching. `%(request_id)s` is filled by RequestIdMiddleware; the default
# below keeps a log call from outside a request cycle (a management command,
# say) from blowing up on a missing key.
LOGGING = {
    "version": 1,
    "disable_existing_loggers": False,
    "filters": {
        "request_id": {"()": "apps.common.logging.RequestIdFilter"},
    },
    "formatters": {
        "json": {
            "()": "apps.common.logging.JsonFormatter",
        },
    },
    "handlers": {
        "console": {
            "class": "logging.StreamHandler",
            "filters": ["request_id"],
            "formatter": "json",
        },
    },
    "root": {"handlers": ["console"], "level": os.environ.get("LOG_LEVEL", "INFO")},
    "loggers": {
        # Django's own request logger duplicates what RequestIdMiddleware logs,
        # minus the id. Silence the duplicate rather than read every line twice.
        "django.request": {"handlers": ["console"], "level": "ERROR", "propagate": False},
    },
}

LANGUAGE_CODE = "en"
LANGUAGES = [("en", "English")]
TIME_ZONE = "UTC"  # stored UTC, displayed Africa/Algiers
USE_I18N = True
USE_TZ = True

STATIC_URL = "static/"
STATICFILES_DIRS = [BASE_DIR / "static"]

LOGIN_URL = "login"
LOGIN_REDIRECT_URL = "dashboard"
DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"

# How many reverse proxies sit in front of this app. It decides which entry of
# `X-Forwarded-For` a rate limiter treats as "the client".
#
# 0 means: ignore that header entirely and trust only REMOTE_ADDR. That is
# correct here — nothing is in front of us yet — and it is also the only safe
# default, because `X-Forwarded-For` is a request header like any other. Left
# unset, Django Ninja uses the whole header when present, so an attacker sends
# a different value on every request, lands in a different throttle bucket each
# time, and the login limit stops existing.
#
# **When this is deployed behind nginx / a load balancer / Cloudflare, set this
# to the real number of proxies**, or every request will be attributed to the
# proxy's IP and one throttled attacker locks out the entire country.
NINJA_NUM_PROXIES = 0

# Rate-limit counters live in the cache. The default backend is per-process
# local memory, which is fine for one dev server and wrong the moment there are
# two workers: each keeps its own count, so the effective limit is multiplied by
# the number of processes. Production wants Redis here — see The Seven Rules.
CACHES = {"default": {"BACKEND": "django.core.cache.backends.locmem.LocMemCache"}}

# --- The local assistant ---------------------------------------------------
#
# One per-agency chat, grounded in a single offer. The model runs on this
# machine through Ollama, so there is no API key and no per-token invoice; the
# cost is CPU/GPU time, which is why the route is throttled per source.
#
# `CHAT_ENABLED` defaults to on only in DEBUG. A production deploy that forgets
# it gets a widget that is simply absent, rather than one that answers 503 to
# travelers because nobody started Ollama. Set it explicitly when the model is
# reachable from the web process.
CHAT_ENABLED = os.environ.get("CHAT_ENABLED", "1" if DEBUG else "0") == "1"

# Ollama's address, not a secret: it is localhost today and an internal hostname
# the day the model gets its own machine. Still an environment variable, because
# that is the only difference between those two deployments.
CHAT_BASE_URL = os.environ.get("CHAT_BASE_URL", "http://127.0.0.1:11434")
CHAT_MODEL = os.environ.get("CHAT_MODEL", "qwen3:14b")
# Qwen3 "thinks" before answering unless told not to. The hidden reasoning is
# not shown to the traveler, costs seconds on a laptop, and is not needed for
# "is the visa included" — so it is off. See apps/chat/llm.py.
CHAT_KEEP_ALIVE = os.environ.get("CHAT_KEEP_ALIVE", "10m")
CHAT_TIMEOUT = int(os.environ.get("CHAT_TIMEOUT", "60"))
CHAT_MAX_TOKENS = int(os.environ.get("CHAT_MAX_TOKENS", "400"))
CHAT_NUM_CTX = int(os.environ.get("CHAT_NUM_CTX", "8192"))

# How many past exchanges the model sees. Small on purpose: the facts block is
# the context, the conversation is only there so "et les repas ?" makes sense.
# Every extra turn is prompt tokens re-read on a machine that has no GPU budget.
CHAT_HISTORY_TURNS = 6
# A hard stop per conversation: the token is a capability URL, and an
# unbounded one is a free LLM endpoint somebody can leave running overnight.
CHAT_MAX_TURNS = 12
CHAT_CONVERSATION_TTL_DAYS = 90

# Rule 4, the other half: an error tracker, so a crash nobody reports is still
# something you find out about. No DSN configured = a silent no-op, which is
# why local runs and CI stay quiet without special-casing them.
#
# `SENTRY_DSN` is the variable name for both Sentry and a self-hosted
# GlitchTip — same protocol, different host. Decision 017 picks GlitchTip,
# because the crash reports contain Algerian travelers' data and it should stay
# on infrastructure we control.
SENTRY_DSN = os.environ.get("SENTRY_DSN", "")
ERROR_REPORTING_ENABLED = init_error_reporting(
    SENTRY_DSN,
    environment=os.environ.get("SENTRY_ENVIRONMENT", "development" if DEBUG else "production"),
    release=os.environ.get("GIT_SHA") or None,
)
