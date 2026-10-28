# One Rule, Two Entry Points

> [!note] This note replaces the NestJS repo's "The Shared Package"
> That repo has `packages/shared`: one folder of Zod schemas imported by the API, the website
> and later the phone app. Django has no such thing, and pretending otherwise would be
> cargo-culting. This note is the same *problem* — how do you stop one rule from becoming
> three slightly different rules — answered with what Django actually offers.

---

## The problem

Rihlati validates an Algerian phone number in at least two places:

- `LeadIn` — when a traveler inquires through `POST /api/inquiries`
- `InquiryForm` — when a traveler inquires through the website

They must agree. If the schema accepts `+213 5 55 11 12 22` with spaces and the form doesn't,
then the same person, entering the same number, succeeds or fails depending on which page they
happened to land on. That is not a hypothetical: it is what happens by default, because a
`ModelForm` and a Pydantic schema get written by different people on different days.

They agree on Monday. On Tuesday someone widens the regex in one of them. Nothing anywhere
reports a problem, and now you have two definitions of "valid phone number" and no way to know
which one is real.

---

## The answer here: one module, imported twice

`apps/common/validators.py` is the whole mechanism, and its docstring states the job:

> This file is the Django answer to `packages/shared` — one definition, imported by both entry
> points, so a rule can't drift between the JSON API and the form.

```python
# Guess at the valid Algerian mobile prefixes. VERIFY before real signups.
E164_DZ = re.compile(r"^\+213[5-7]\d{8}$")
PHONE_HELP = "Format international : +213XXXXXXXXX"


def validate_dz_phone(value):
    if not E164_DZ.match(value or ""):
        raise ValidationError("Numéro algérien attendu, au format +213…")
    return value
```

- `create_inquiry` in `apps/leads/api.py` calls `validate_dz_phone(payload.phone_e164)`.
- `InquiryForm.clean_phone_e164` calls the same function.
- The form's `help_texts` imports `PHONE_HELP`, so even the *instructions* can't drift from
  the rule they describe.

One definition. Two enforcement points. No second copy to disagree with the first. The same
file holds `validate_wilaya_code`, `validate_time_of_day`, `validate_price_centimes` and
`validate_date_range`, each used from both sides.

There is a test for both doors, and that pairing is the point — an API test and a form test
for the same rule, so a change that fixes one and forgets the other goes red.

> [!info] Why every validator raises Django's `ValidationError`, not Pydantic's
> A shared module can only be shared if both callers can use its exceptions. Django's
> `ValidationError` is what a `ModelForm` already understands, and on the API side
> `apps/common/errors.py` has a handler that turns it into a `400` with the same
> `{field: [messages]}` envelope. Reaching for Pydantic's exception type would have made the
> module importable by exactly one of the two doors, which defeats the purpose.
>
> That is also the origin of the 400/422 split in [[What the API Is]]: **422 is Pydantic**
> (the shape was wrong, before the handler ran), **400 is this module** (the shape was fine,
> the value broke a rule).

---

## The same idea, applied to fields rather than formats

The stronger version of this pattern isn't a shared function — it's a field that simply
doesn't exist on either door.

`InquiryForm` says so in its own docstring:

> Note what it does *not* contain: agency, offer, status, quality. Those are set by the view
> from data the server controls — **the same list that is absent from `LeadIn` in the JSON
> API, because it is the same rule at a second door.**

And `OfferForm`:

> `agency` is absent on purpose — the view sets it from the membership it already authorized,
> so a crafted POST can't reassign it. So are `quality_score`, `is_featured` and
> `duplicate_status`: server-owned.

Neither form uses `fields = "__all__"`; both list their fields. That is the HTML-side twin of
the allowlist in [[Validation at the Boundary]], and it is worth checking by eye whenever a
column is added, because nothing enforces it automatically.

---

## What this buys, and what it doesn't

**It buys** a single place to change the rule when you finally verify which Algerian mobile
prefixes are real, and a guarantee that both doors change together.

**It does not buy** what `packages/shared` buys, and it's worth being precise about the gap.

| | NestJS + Zod | Django |
|---|---|---|
| One definition of the rule | ✅ | ✅ |
| Server enforces it | ✅ | ✅ |
| **Browser enforces the same code** | ✅ | ❌ |
| Renaming a field breaks the build | ✅ TypeScript | ❌ nothing |
| A mobile app reuses the validator | ✅ | ❌ (gets the shape via OpenAPI, not the rule) |

Two of those matter enough to say out loud.

### The browser gap

A Zod schema runs unchanged in Node and in the browser. The NestJS website validates a form as
you type using *literally the same code* the server will run. Instant feedback, zero drift,
free.

Python does not run in the browser. So a Django form that wants live client-side feedback has
to repeat the rule in JavaScript, and that copy *can* drift. Three ways out, none free:

1. **Don't do live validation.** Submit, let the server answer, re-render with errors. This is
   what Rihlati does today. It's correct, it's what Django is built for, and it costs a
   round-trip on every mistake.
2. **Render the rule into the page.** Emit `E164_DZ.pattern` as an HTML `pattern` attribute on
   the widget. One definition, still, and it survives as long as nobody hand-writes a second
   regex in a `<script>` tag.
3. **HTMX.** Validate on the server, per field, on blur; swap the error in. Feels live, stays
   single-definition, costs a request per field.

Option 2 is the one I'd reach for first, and it isn't built. It is also nearly free here,
because `StyledFormMixin` already walks every widget's `attrs` — adding `pattern` is a few
lines in the same loop.

### The rename gap

This is the one that will actually bite you.

In the NestJS repo, renaming `priceFromCentimes` makes the compiler point at every file that
mentions it, including the React components. In Django, renaming `price_centimes` updates the
model and the migration — and a template that says `{{ offer.price_centimes }}` keeps
rendering. Django templates **silently render an empty string for a missing attribute**. No
error, no warning, no log line. The price just quietly disappears from the page.

There is no compiler coming to save you. That is precisely why `apps/pages/tests.py` asserts on
rendered *content* and not merely on status codes. A test that only checks `200` passes with a
completely blank page.

**If you take one practical habit from this note:** when you rename a model field, grep the
`templates/` folder. Nothing else will tell you.

---

## Where the rest of `packages/shared` went

| NestJS file | Django home |
|---|---|
| `enums.ts` | model `choices` on the field itself — `Offer.KINDS`, `Lead.STATUSES` |
| `phone.ts` | `apps/common/validators.py` |
| `money.ts` | `Offer.price_dzd` property + `OfferForm`'s dinars↔centimes conversion |
| `plans.ts` | `apps/common/quotas.py` |
| `offers/attributes.ts` | **nowhere — see the warning below** |
| `pagination.ts` | `limit`/`offset` on the filter schemas, plus an `OfferPage` response |
| `errors.ts` | `apps/common/errors.py` |
| the generated client types | the OpenAPI document at `/api/docs` |

Model `choices` deserve a note of their own. In Django the fixed list lives **on the field**:

```python
KINDS = [(OMRA, "Omra"), (HAJJ, "Hajj"), ...]
kind = models.CharField(max_length=20, choices=KINDS)
```

which means the database constraint, the form dropdown, the schema's validation, the admin
filter and the human-readable label are all generated from one declaration. That is genuinely
tighter than the JS stack, where `enums.ts` is deliberately duplicated with `schema.prisma` and
a test has to guard the duplication.

Credit where it's due: this is the thing Django does better, and it's not a small thing.

> [!warning] Honest state — `attributes` is the one place with no rule at all
> `Offer.attributes` is a `JSONField`, and `OfferIn` types it `dict`. That means **any** JSON
> object is accepted: no per-`kind` schema, no key allowlist, nothing. `nightsInMakkah`,
> `nights_in_makkah` and `nightsInMaccah` are all equally valid, and two of them are data
> nothing will ever read.
>
> The NestJS repo has `offers/attributes.ts` precisely to stop this: a strict Zod schema per
> offer kind, so a typo is a 422 rather than a silent write. That is the design this column
> was meant to have, and it is missing. Until it exists, `attributes` is the junk drawer the
> whole idea was supposed to avoid. See [[Offer]] and [[Known Gaps]].

---

## The rule for this module

**`apps/common/validators.py` imports nothing from the apps.** Not models, not views, not
schemas — only `wilayas.py`, which is a constant list. If a validator needs to query the
database to decide, it is not a validator; it is a business rule, and it belongs on the model
(`Offer.publicly_visible()`, `Agency.can_transition_to()`) or in `apps/common/quotas.py`.

Keeping this file dependency-free is what lets both doors import it without an import cycle,
and what would let a future management command — or an LLM tool-call — import it too.

---

## Open questions

- Do you want live client-side validation on the inquiry form? It measurably improves
  conversion on forms strangers fill in once. If yes, option 2 or 3 above — and option 3 is a
  real decision, because it means adding HTMX to the stack.
- If a mobile app happens, the OpenAPI document gives it the *shapes* but not the *rules* — it
  will learn `phone_e164` is a string, not that it must start `+213`. Is a round-trip to the
  server good enough for that app, or is that the argument for the NestJS stack?

Related: [[System Overview]] · [[Validation at the Boundary]] · [[Offer]] ·
[[Templates and Pages]] · [[Plan Limits and Quotas]] · [[What the API Is]] ·
[[Authentication vs Authorization]]
