"""Pydantic schemas are the contract at the boundary.

Django Ninja validates with Pydantic, so a schema is a *type* rather than a
class full of hand-written checks. That has one consequence worth naming: the
same declaration produces the validation, the OpenAPI document at /api/docs,
and the response shape. Three things that used to be able to disagree now
cannot.

`Strict` is the base every input schema uses. Pydantic's default is to ignore
unknown keys, which means `{"stauts": "published"}` — a typo — is silently
dropped and the client is told 200. `extra="forbid"` turns that into a 422 that
names the offending field.
"""

from typing import Any

from ninja import Schema
from pydantic import ConfigDict


class Strict(Schema):
    """Reject unknown fields instead of ignoring them.

    A loud rejection beats a quiet success. The failure this prevents is not
    the attacker — the allowlist of declared fields already stops them — it is
    the honest client that believes a write landed when it did not.
    """

    model_config = ConfigDict(extra="forbid")


class ErrorOut(Schema):
    """The one shape every error leaves through.

    The client switches on `code`, never on the human sentence: the sentence is
    going to be translated, and a UI that matches on French prose breaks the day
    someone fixes a typo.
    """

    code: str
    details: dict[str, Any] | list[Any] | str | None = None
    requestId: str | None = None


class Message(Schema):
    detail: str
