# The Shared Package

`packages/shared` — the contract between the API and every client. The smallest package in
the repo and the one that prevents the most bugs.

---

## What's in it

| File | Holds |
|---|---|
| `enums.ts` | every fixed list: offer kinds, lead stages, quality labels, roles, statuses |
| `plans.ts` | plan limits and feature gates — [[Plan Limits and Quotas]] |
| `money.ts` | centimes helpers, formatting |
| `phone.ts` | Algerian phone normalization to E.164, masking for logs |
| `wilayas.ts` | the 58 wilayas, French + Arabic names |
| `pagination.ts` | cursor pagination |
| `offers/attributes.ts` | per-kind offer schemas — [[Offer]] |
| `offers/schemas.ts` | create / update / search shapes |
| `offers/dedup.ts` | fingerprinting — [[Duplicate and Spam Control]] |

67 tests. It's the most heavily tested part of the codebase, because everything else depends
on it.

---

## Why it exists

Three places need to agree on what an offer looks like: the API, the website, and later the
phone app.

Without a shared package, each writes its own copy. They agree on Monday. On Tuesday you add
a field to the API and the website's copy is now wrong — and nothing tells you. The app keeps
compiling, keeps running, and silently drops the field.

With one definition, changing it makes TypeScript point at every place that needs updating.
The compiler finds what your eyes skip, which is the direct fix for problem #7 in
[[The Seven Rules]].

---

## One definition, two jobs

A Zod schema is both a runtime check and a TypeScript type:

```ts
export const createOfferSchema = z.object({ title: z.string().min(8), ... });
export type CreateOfferInput = z.infer<typeof createOfferSchema>;
```

The API uses the schema to *validate* an incoming request. The website uses the type to know
what to send, and the same schema to validate the form before sending. Same rule, both sides,
no drift. See [[Validation at the Boundary]].

---

## The rules for this package

**No imports from anywhere else in the repo.** Not from the API, not from Prisma, not from
React. `zod` is the only dependency. It must run unchanged in Node, a browser and React
Native — the moment it imports `@prisma/client`, the phone app can't use it.

**Enums are declared here, not imported from Prisma.** They're duplicated with
`schema.prisma` on purpose, because the alternative is the web app depending on the database
client. The duplication is guarded: `attributes.test.ts` asserts every offer kind has a
schema, so a kind added in one place and forgotten in the other fails the build.

**No business logic that needs a database.** "Can this agency publish another offer?" is
`canPublishAnotherOffer(count, limit)` here — pure, testable, no I/O. *Fetching* the count is
the API's job. That split is why the rule can be tested in milliseconds.

---

## Building it

The API and web import the compiled output, so it has to be built before they run:

```bash
npm run build --workspace @rihlati/shared
```

`npm run dev:api` does this automatically. If you get "cannot find module `@rihlati/shared`",
that's what's missing.

---

Related: [[System Overview]] · [[Validation at the Boundary]] · [[Offer]] ·
[[Plan Limits and Quotas]]
