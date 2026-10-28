# Image Uploads

> [!danger] Not built in this port — and the code currently does the opposite
> There is no upload endpoint, no storage driver, no re-encoding. What exists instead:
> `Offer.cover_image_url` and `Agency.logo_url` are `URLField`s, and the agency **types a
> URL into a form** (`apps/pages/forms.py`, labelled "Photo (URL)" and "Logo (URL)"). The
> API accepts the same string on `PATCH /api/agencies/{id}` and on offer create/update.
>
> That is precisely the design this note argues against. Everything below is the **plan**,
> written down while the reasoning was fresh, not a description of running code. Read
> "Why a client-chosen URL is a real problem" first — it is the live risk today, not a
> hypothetical.

---

## Why a client-chosen URL is a real problem

The rule the built version must enforce: **a client uploads bytes, never a URL.**

This looks like an arbitrary restriction until you follow what a client-chosen URL does:

- **It turns every page into a tracking beacon.** If an agency sets its logo to a URL on a
  server it controls, then every time anyone loads a search page showing that logo, their
  browser makes a request to that server. The agency now has the IP address and rough time
  of every person who browsed those results — including its competitors' customers.
- **It can be swapped after moderation.** A URL that passed review on Monday can serve
  something else on Tuesday. An agency approved with a clean logo can quietly change it to
  anything. Bytes we store cannot change under us.
- **It breaks.** Someone else's server going down puts a broken image on our page, and
  nobody finds out until a traveler mentions it.

> [!warning] How exposed are we today, concretely?
> The field is a `URLField`, so Django validates it is a URL and the templates render it in
> `src=`, not as HTML — so this is **not** an XSS hole. The live problems are the three
> above: the beacon, the swap, and the breakage. That is a launch blocker for the beacon
> reason alone, and it is cheap to reduce in the meantime — see the interim option below.

So: the client sends the file, and **the server decides the name**. That inversion is the
whole design. Everything below follows from it.

---

## The plan: what should happen between the browser and disk

```
browser → multipart/form-data → Django UploadedFile → Pillow → storage backend → path in the DB
```

1. **Django's own file handling.** Django already streams uploads over
   `FILE_UPLOAD_MAX_MEMORY_SIZE` to a temp file rather than holding them in RAM. Set
   `DATA_UPLOAD_MAX_MEMORY_SIZE` so a 2 GB upload is refused early, not after 2 GB arrive.
2. **Pillow decodes it,** with `Image.MAX_IMAGE_PIXELS` set — see the decompression bomb
   below.
3. Check the format Pillow *actually found*, not the `Content-Type` the browser claimed.
   Anyone can claim `image/png`.
4. **Re-encode to WebP.** Not "validate and keep the original" — throw the original bytes
   away and write bytes we generated.
5. Name the stored file by the **sha256 of its own content**, first 32 hex characters.
6. Only after the file is safely stored, update the database row.

### Why re-encoding is the whole security model

One decision closes four holes at once. That is why it is worth the CPU.

| Attack | Why re-encoding stops it |
|---|---|
| A `.php`/`.html` file renamed `.jpg` | Pillow cannot decode it, so it never reaches step 4 |
| **EXIF GPS coordinates** | re-encoding drops all metadata. A phone photo often carries the coordinates of the house it was taken in |
| **Polyglot files** — valid image *and* valid HTML/JS | the output is bytes we generated from decoded pixels; the smuggled text is not in them |
| **Decompression bomb** — a 40 KB PNG that expands to 60 000 × 60 000 pixels | a pixel limit refuses it before allocating ~10 GB |

> [!note] The one ordering detail that is easy to get wrong
> Apply the EXIF rotation **before** resizing. Phone cameras store the picture sideways plus
> an EXIF "rotate 90°" tag. Strip the tag without applying it first and every portrait photo
> comes out on its side. In Pillow that is `ImageOps.exif_transpose(img)`, first thing.

> [!warning] SVG must be refused on purpose
> An SVG is not a picture, it is a document — it can contain `<script>`, and browsers
> execute it. Accepting one and serving it from our own domain is stored XSS. It belongs
> nowhere in the accepted-format list, and that deserves its own test.

### Why the filename should be a hash of the content

Content-addressed keys (`logos/9f2c…4b1a.webp`) buy three things:

- **The name is unguessable and unforgeable.** A user cannot pick it, so a user cannot
  collide with someone else's, and cannot smuggle `../../` into it.
- **Identical images are one file**, for free.
- **The URL can be cached forever** (`max-age=31536000, immutable`). Different content
  means a different hash means a different URL, so a stale cache is not possible.

The cost: uploading the same picture twice and deleting one copy would break the other.
Worth remembering before writing any cleanup job.

### Where the files would live

Django's `STORAGES` setting is already the "three-method interface" this needs —
`FileSystemStorage` locally, an S3-compatible backend in production (`django-storages`).
Nothing outside the model needs to know which is running, and moving to object storage is a
settings change rather than a code change.

> [!danger] Local disk in production is a silent data-loss bug
> Every image is deleted at the next deploy, silently, and noticed weeks later when someone
> reports a broken logo. Whatever wires this up should **refuse to boot** with a local
> storage backend when `DEBUG` is off, the same way `DJANGO_SECRET_KEY` should.

### Order of operations when a picture changes

Store the new file **first**, update the row **second**. If the store fails, the row still
points at the old picture, which still exists. The other way round leaves the row pointing
at a file that was never written — a broken image, permanently, with no way to know it
happened.

### Tenant isolation still applies

An upload is a write like any other. The endpoint belongs under
`/api/agencies/{agency_id}/…`, so `require_membership(request.user, agency_id,
Membership.MANAGER)` fires, and the row is fetched with `scoped(...)` — agency B setting
A's logo is **404, not 403**, and A's logo is unchanged afterwards ([[Multi-Tenancy]]).
That test ships with the feature, per rule #3.

---

## An interim option, if this is not built before launch

If uploads slip past launch, the beacon problem can be blunted without the whole pipeline:
**fetch the image server-side once and store the bytes.** Same "we decide the name" rule,
one tenth the code — no multipart, no form work. The catch is that fetching a URL the user
supplied is itself an attack surface (SSRF: `http://169.254.169.254/`, `http://localhost:…`),
so it needs an allow-list of schemes, a DNS-resolution check against private ranges, a
timeout, and a size cap. Cheaper than the full pipeline, not free. Decide deliberately.

---

> [!danger] Whatever gets built here, do not reuse it for identity documents
> Everything on this page assumes the picture is **meant to be public**: no auth to fetch
> it, a URL cached forever, a filename that is a permanent bearer token. That is correct
> for a logo and a breach for a passport scan or a registre de commerce.
>
> Identity documents need a private bucket, short-lived signed URLs, `no-store`, encryption
> at rest, and an audit row on every *read*. See [[Agency Verification]].

---

## Open questions — yours

- **Is this a launch blocker?** My read: yes, for the tracking-beacon reason. An agency
  that notices can watch its competitors' traffic. Your call on timing.
- **Do offers need photo galleries?** That is the obvious real user of this feature, and it
  changes the shape: many images per offer, ordering, a cover image, and moderation before
  they are public. Worth deciding *before* the code is shaped around exactly two single
  images.
- **How big should a stored image be?** 512 px was the previous answer for logos and
  avatars. Nobody has looked at these on a real phone yet.
- **Is a picture moderated at all?** For an agency logo shown next to a "verified" badge,
  possibly it should be.
- **Who pays for storage, and what is the retention rule** when an agency deletes its
  account?

## Related

[[Agency]] · [[Offer]] · [[Agency Verification]] · [[Decisions You Must Make]] ·
[[Validation at the Boundary]] · [[Multi-Tenancy]] · [[The Seven Rules]]
