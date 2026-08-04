# Image Uploads

> [!success] Built
> Code: `apps/api/src/modules/uploads/`.
> Tests: `apps/api/test/uploads.e2e.test.ts` (17 cases).
> Two things use it today: a user's profile picture and an agency's logo.

---

## The one rule: a client uploads bytes, never a URL

There is deliberately no endpoint anywhere that accepts `{ avatarUrl: "https://..." }`. Not on
`PATCH /auth/me`, not on `PATCH /agencies/{id}`. `updateProfileSchema` omits the field, so Zod
strips it and posting it does nothing. There is a test for exactly that.

This looks like an arbitrary restriction until you follow what a client-chosen URL does:

- **It turns every page into a tracking beacon.** If I set my avatar to a URL on a server I
  control, then every time anyone loads a page showing my avatar, their browser makes a request
  to me. I now have the IP address and rough time of every person who viewed that page.
- **It can be swapped after moderation.** A URL that passed review on Monday can serve
  something else on Tuesday. The bytes we store cannot.
- **It breaks.** Someone else's server going down puts a broken image on our page.

So: the client sends the file, and **the server decides the name**. That inversion is the whole
design. Everything below follows from it.

---

## What happens to a file between the browser and disk

```
browser → multipart/form-data → multer (memory) → sharp → storage driver → URL in the DB
```

1. **multer, `memoryStorage()`.** The file never touches disk as the user sent it. Limits are
   set at the interceptor: 5 MB, exactly 1 file, 4 fields. Multer aborts mid-stream when a limit
   is passed, so a 2 GB upload costs us the first 5 MB, not 2 GB.
2. **sharp decodes it.** `limitInputPixels: 50_000_000` — see the decompression bomb below.
3. We check the format sharp *actually found*, not the `Content-Type` the browser claimed.
   Anyone can claim `image/png`.
4. **We re-encode to WebP.** Not "we validate and keep the original" — we throw the original
   bytes away and write bytes we generated.
5. The stored file is named by the **sha256 of its own content**, first 32 hex characters.
6. Only after the file is safely stored do we update the database row.

### Why re-encoding is the whole security model

One decision closes four holes at once. That is why it is worth the CPU.

| Attack | Why re-encoding stops it |
|---|---|
| A `.php`/`.html` file renamed `.jpg` | sharp cannot decode it, so it never reaches step 4 |
| **EXIF GPS coordinates** | re-encoding drops all metadata. A phone photo of your face often carries the coordinates of your house |
| **Polyglot files** — valid image *and* valid HTML/JS | the output is bytes we generated from decoded pixels; the smuggled text is not in them |
| **Decompression bomb** — a 40 KB PNG that expands to 60 000 × 60 000 pixels | `limitInputPixels` refuses it before allocating ~10 GB |

> [!note] The one ordering detail that is easy to get wrong
> `.rotate()` is called **before** the resize. Phone cameras store the picture sideways plus an
> EXIF "rotate 90°" tag. Strip the tag without applying it first and every portrait photo comes
> out on its side. `.rotate()` with no argument means "apply whatever the EXIF says, now".

> [!warning] SVG is refused on purpose
> An SVG is not a picture, it is a document — it can contain `<script>`, and browsers execute
> it. Accepting one and serving it from our domain is stored XSS. It is absent from
> `ACCEPTED_INPUT_FORMATS`, and there is a test.

### Why the filename is a hash of the content

Content-addressed keys (`avatars/9f2c…4b1a.webp`) buy three things:

- **The name is unguessable and unforgeable.** A user cannot pick it, so a user cannot collide
  with someone else's, and cannot smuggle `../../` into it.
- **Identical images are one file**, for free.
- **The URL can be cached forever** (`max-age=31536000, immutable`). Different content means a
  different hash means a different URL, so a stale cache is not possible.

The cost: uploading the same picture twice and deleting one copy would break the other. We
never delete on overwrite in a way that hits this today, but it is the trade-off to remember.

---

## Where the files actually live

`StorageDriver` is a three-method interface — `put`, `remove`, `urlFor`. Two implementations,
chosen **once at boot** by `useFactory` reading `STORAGE_DRIVER`:

- `LocalDiskStorage` — development. Writes under `STORAGE_LOCAL_DIR` (`./var/uploads`, which is
  gitignored) and is served back by the `/media` route.
- `S3Storage` — production. Any S3-compatible object store, not AWS-specific, which matters
  because the eventual host may well not be AWS.

Nothing outside this module knows which one is running. Moving to object storage is a `.env`
change, not a code change.

> [!danger] The config refuses to boot in production with the local driver
> Local disk in production means every image is deleted at the next deploy — silently, and only
> noticed weeks later when someone reports a broken logo. `loadConfig` throws instead. It also
> throws if `STORAGE_DRIVER=s3` and any `S3_*` variable is missing, so the failure is at
> startup rather than on a user's first upload.

> [!warning] Not yet verified
> `S3Storage` has never been run against a real bucket. It is written and typechecked, nothing
> more. Verify it before launch — see [[Decisions You Must Make]].

---

## The order of operations when a picture changes

Store the new file **first**, update the database **second**:

1. `put()` the new bytes.
2. `update` the row's `avatarUrl` / `logoUrl`.

If step 1 fails, the row still points at the old picture, which still exists. Do it the other
way round and a failure leaves the row pointing at a file that was never written — a broken
image, permanently, with no way to know it happened.

## Tenant isolation still applies

The logo endpoints live under `/agencies/{agencyId}/`, so `AgencyMembershipGuard` fires and
`@RequireAgencyRole('manager')` applies. Inside the service the write is still
`findFirst({ where: { id, deletedAt: null } })` + `updateMany` — never `findUnique({ id })`.
Uploading a file is a write like any other; see [[Multi-Tenancy]].

The test asserts agency B setting A's logo gets **404, not 403**, and that A's logo is
unchanged afterwards. 403 would confirm the agency exists, which is itself a leak.

`keyFromUrl()` will only return a key matching `^[a-z]+/[a-f0-9]{32}\.webp$`. So even if a
`logoUrl` in the database were somehow attacker-controlled, "delete the old file" can never be
pointed at an arbitrary path.

---

## What the browser sees

The `/media` route sets, on every response:

| Header | Why |
|---|---|
| `Content-Type: image/webp` | we know it is, we generated it |
| `X-Content-Type-Options: nosniff` | stops a browser second-guessing us and executing the file |
| `Content-Security-Policy: default-src 'none'; sandbox` | belt and braces if something *is* executable |
| `Cache-Control: public, max-age=31536000, immutable` | safe because the URL is a content hash |

---

---

> [!danger] Do not reuse this module for identity documents
> Everything on this page assumes the picture is **meant to be public**: no auth to fetch it,
> a URL cached forever, a filename that is a permanent bearer token. That is correct for a
> logo and a breach for a passport scan or a registre de commerce.
>
> Identity documents need a private bucket, short-lived signed URLs, `no-store`, encryption
> at rest, and an audit row on every *read*. The design is written up in
> [[Agency Verification]] — read it before adding a third caller to this module.

---

## Open questions — for the owner

- **How big should a stored image be?** Avatars are capped at 512 px, logos at 512 px. Nobody
  has looked at these on a real phone yet.
- **Do offers need photo galleries?** That is the obvious next user of this module, and it
  changes things: many images per offer, ordering, a cover image, and moderation before they
  are public. Worth deciding before this code is shaped around exactly two single images.
- **Is a picture moderated at all?** Today anyone can upload anything that decodes as an image.
  For an avatar that is probably fine; for an agency logo shown next to a "verified" badge,
  possibly not.
- **Who pays for storage, and what is the retention rule** when an agency deletes its account?

## Related

[[Image Uploads]] is used by [[Auth Flow]] and [[Agency]].
Concepts: [[Validation at the Boundary]], [[Multi-Tenancy]], [[The Seven Rules]].
