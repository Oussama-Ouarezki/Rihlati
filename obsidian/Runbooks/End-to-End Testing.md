# End-to-End Testing

> [!danger] This does not exist yet
> Two notes link here — [[Start Here]] and [[Local Setup]] — and both describe it in the
> present tense, as "the agent that clicks through the app like a user". **Nothing in this
> repo drives a browser.** The suite is Python calling Python.
>
> The note is kept rather than deleted because the gap is real and rule 7 names it
> explicitly. It is **M1** in [[Milestone Plan]], and the first milestone on the list.

---

## What exists instead, and where it stops

`./scripts/check.sh` runs the Django test suite. Those tests are genuinely good at the things
they cover — tenant isolation, quotas, validation, auth, the house rules enforced by reading
the source with `ast`. They go through Django's test client, which calls the view function
directly.

What that can never catch:

- A template that raises on a field that no longer exists. The view returns fine; the *page*
  is a 500.
- A form that posts to the wrong URL, or with a field name the view does not read.
- CSS that hides the submit button, or an RTL layout that puts it off-screen.
- A stylesheet that was never rebuilt after a template change (`npm run css`).
- Any JavaScript at all.

Every one of those is invisible to a green suite and immediately visible to a person. That is
the entire argument for this layer.

> [!example] It has already happened twice
> **C1** — on 2026-08-09 the home page returned 500 for a stale-schema reason while the whole
> suite was green. A browser test hitting `/` would have caught it in the first second.
>
> **C4**, the same day, and worse because it was not even loud: twenty template comments were
> rendering as visible text on *every page in the app*, including the marketplace home page.
> The suite was green before the fix and green after it — 218 tests either way. It was found by
> a human opening the site and reading it.
>
> Both are in [[Known Gaps]]. The tests were not wrong either time; they were answering a
> different question. C4 names the question precisely: **every assertion in this repo checks
> that something expected is present, and none checks that something unexpected is absent.**
> No amount of adding tests of the current kind would have caught it.

---

## The five pages, and why exactly these five

Rule 7 names them, and the choice is not arbitrary — it is the shortest path a stranger walks
from arriving to becoming a lead an agency can work, plus the one door that lets the agency in:

| Page | If it breaks |
|---|---|
| Search `/` | nobody finds anything; the marketplace is a blank page |
| Offer detail `/offers/<id>/` | the traveler cannot see what they would be buying |
| Inquiry submission | **the product produces nothing** — this is the conversion |
| Agency lead inbox | the lead arrives and nobody works it; the agency churns |
| Login | the agency cannot get in at all |

Everything else in the app can be broken for a day. These five cannot.

---

## What done looks like

- One test per page, driven in a real browser.
- **Assertions on what a user can see** — visible text, in French — not on element ids. A test
  that asserts on `#submit-btn` passes while the button says the wrong thing.
- A screenshot assertion per page, so a layout regression is a diff rather than a bug report.
- Runs inside `./scripts/check.sh`, so CI gets it without a second list of steps. This is the
  same reasoning as everywhere else here: two lists drift, and the one that drifts is local.
- **Builds its own state**, through `seed_preview` or through the UI. A suite that needs a
  hand-prepared database is a suite that rots within a month.
- The inquiry test must submit a **real** inquiry and assert the lead appears in the agency
  inbox — the two halves of the loop, in one test. That crossing is the point of the whole
  layer; each half already has unit tests.

## What it must not become

- **Not a re-test of business rules.** Tenant isolation, quotas and validation are already
  pinned by fast tests. Testing them again through a browser buys nothing and costs minutes on
  every run.
- **Not a fixture nobody can regenerate.** If the screenshots can only be updated by one
  person on one machine, the first false failure gets ignored and then all of them do.

---

## Open questions — yours

- **Which tool?** Playwright is what rule 7 names, and it is what the NestJS repo uses, which
  is an argument for keeping one answer across both repos. `pytest-playwright` versus Django's
  own `LiveServerTestCase` changes how much of the existing suite is reused.
- **Do screenshots run in CI, or only locally?** Fonts and rendering differ between a laptop
  and a CI container, and a screenshot test that fails for that reason teaches everyone to
  ignore it. The usual answer is to generate the baselines in CI, not on the laptop.
- **Arabic too?** Once [[Milestone Plan]] M2 lands, RTL is a second rendering of every page,
  and a screenshot suite that only covers French is only half a suite.

---

Related: [[Milestone Plan]] · [[Local Setup]] · [[The Seven Rules]] · [[Known Gaps]] ·
[[Templates and Pages]]
