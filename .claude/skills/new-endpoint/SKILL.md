---
name: new-endpoint
description: Build a new API endpoint in the Rihlati backend with authorization, validation, tenant isolation, tests and vault docs. Use whenever adding or changing an endpoint, route, controller or service method in apps/api — including "add an endpoint for X", "expose Y over the API", or "let agencies do Z".
---

# Adding an endpoint

Follow every step. Steps 4, 5 and 7 are the ones that get skipped and the ones that matter.
If a step genuinely doesn't apply, say so out loud rather than passing over it.

## 1. Decide who may call it

Write this down before any code:

- **Public?** (`@Public()`) — then it must be rate limited, and it must not read tenant data.
- **Logged in?** — the default. Nothing needed.
- **Agency staff?** — which minimum role: `agent`, `manager`, `owner`?
- **Platform admin?** — `isPlatformAdmin`.

Deny by default: if you write no decorator, the endpoint requires a logged-in user. Never
"open by default and remember to lock it".

## 2. Shape the input in `packages/shared`

Add or extend a Zod schema in `packages/shared/src/`. Never define request shapes inside the
API — the web and mobile apps need the same definition.

**Omit every server-owned field.** The client must not be able to send:
`id`, `agencyId`, `userId`, `role`, `status`, `isPlatformAdmin`, `plan`,
`publishedOfferLimitOverride`, `isFeatured`, `qualityScore`, any price or amount,
`createdAt`/`updatedAt`, or any counter.

If a field is absent from the schema, `z.object()` strips it and it cannot be acted on. That
is the defence against mass assignment — not an `if` in the handler.

## 3. Write the service method

Business rules go in the service, never the controller. The service takes plain arguments
and knows nothing about HTTP, so it can be tested without a server.

Fetch anything you need to decide with — counts, limits, current state — **from the
database**. Never from arguments the client influenced.

## 4. Scope every query to the tenant

For any table with an `agencyId`:

```ts
// NO
prisma.lead.findUnique({ where: { id } })

// YES
prisma.lead.findFirst({ where: { id, agencyId: session.agencyId, deletedAt: null } })
```

Same for `update`, `delete` and every list. Writes use `updateMany`/`deleteMany` with the
`agencyId` in the where clause, then check the affected count — `update({ where: { id } })`
cannot express the second condition.

A not-found row and another agency's row both return **404**. Never 403, never a different
message, never a different shape. A 403 confirms the row exists.

## 5. Write the isolation test

Not optional. Roughly eight lines:

```ts
it('does not let another agency reach this', async () => {
  const { agency: a, token: tokenA } = await createAgencyWithUser();
  const { token: tokenB } = await createAgencyWithUser();
  const resource = await createResourceFor(a, tokenA);

  await request(app).get(`/my/leads/${resource.id}`)
    .set('Authorization', `Bearer ${tokenB}`)
    .expect(404);
});
```

Also test: the role below the required one gets 403, and no token gets 401.

## 6. Wire up the controller

Thin. Guard decorator, validated input, call the service, return. No business logic, no
Prisma calls, ideally under ten lines.

## 7. Audit and document

- Anything that changes trust, money, permissions, or a judgement about a person gets an
  `AuditLog` row **in the same transaction** as the change.
- Add the endpoint to `obsidian/Backend/API Endpoints.md` with its permission level.
- If it introduced a business rule, update the matching note in `obsidian/Backend/`.
- If a design decision had a real alternative, append to `obsidian/Decisions/Decision Log.md`.

## 8. Verify

```bash
npm run check
```

Then state plainly what you did and did not cover. Do not report an endpoint as done if the
isolation test is missing.

## Never

- Trust `agencyId`, `userId`, `role` or any price from a request body
- Return a stack trace, SQL fragment, or column name to a client
- Log a token, password, OTP or full phone number (use `maskPhone()`)
- Use `z.coerce.boolean()` on a query parameter — `Boolean("false")` is `true`
- Return an unpaginated list
- Add a `GET` that changes state
