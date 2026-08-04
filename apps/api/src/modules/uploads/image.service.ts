import { Inject, Injectable } from '@nestjs/common';
import sharp from 'sharp';
import { AppError } from '../../common/errors/app-error';
import { STORAGE_DRIVER, contentAddressedKey, type StorageDriver } from './storage';

/**
 * TURNING AN UPLOADED FILE INTO AN IMAGE WE ARE WILLING TO SERVE
 *
 * The rule this service exists to enforce: **the bytes a client sends are never
 * the bytes we store.** Every upload is decoded and re-encoded from scratch.
 *
 * That single decision handles a whole family of problems at once:
 *
 *   - **The file might not be an image.** `Content-Type: image/png` and a
 *     `.png` filename are both typed by the client and mean nothing. Only
 *     decoding proves it.
 *   - **EXIF metadata.** A photo taken on a phone carries GPS coordinates.
 *     Publishing an agency owner's home address alongside their profile picture
 *     is a real harm, and it happens silently. Re-encoding drops all of it.
 *   - **Polyglot files.** A file can be a valid GIF *and* valid HTML/JS at the
 *     same time; served from our origin it becomes stored XSS. A re-encoded
 *     image is only an image.
 *   - **Decompression bombs.** A 4 KB PNG can expand to 40 000 × 40 000 pixels
 *     and exhaust memory. `limitInputPixels` refuses before allocating.
 *
 * What it does NOT do is trust anything about the request except its bytes.
 */

/** What a caller wants back. Keeps the tuning in one table instead of at each call site. */
export interface ImageVariant {
  /** Key prefix, e.g. `avatars`. Never client-supplied. */
  prefix: string;
  /** Longest edge, in pixels, after resizing. */
  maxEdge: number;
  /** `cover` crops to a square (avatars); `inside` preserves shape (logos). */
  fit: 'cover' | 'inside';
}

export const AVATAR_VARIANT: ImageVariant = { prefix: 'avatars', maxEdge: 512, fit: 'cover' };
export const LOGO_VARIANT: ImageVariant = { prefix: 'logos', maxEdge: 512, fit: 'inside' };

/**
 * Hard cap on the uploaded file, before decoding. 5 MB is generous for a
 * profile picture and small enough that a hostile client cannot tie up memory.
 * Enforced twice: by multer at the socket, and here in case a caller forgets.
 */
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

/**
 * Formats we are willing to DECODE. Note SVG is absent, and that is the whole
 * point: an SVG is a document that can contain script, so accepting one and
 * serving it back from our own origin is stored XSS with extra steps. There is
 * no safe way to "sanitize" it that is worth the risk for a logo.
 */
const ACCEPTED_INPUT_FORMATS = new Set(['jpeg', 'png', 'webp', 'gif', 'avif', 'tiff']);

@Injectable()
export class ImageService {
  constructor(@Inject(STORAGE_DRIVER) private readonly storage: StorageDriver) {}

  /**
   * Validates, re-encodes and stores. Returns the public URL and the key —
   * callers keep the key so they can delete the old file afterwards.
   */
  async storeImage(
    file: { buffer: Buffer; size: number } | undefined,
    variant: ImageVariant,
  ): Promise<{ url: string; key: string }> {
    if (!file || file.size === 0) {
      throw new AppError('VALIDATION_FAILED', 'Aucun fichier reçu', {
        fields: { file: ['Fichier manquant'] },
      });
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      throw new AppError('VALIDATION_FAILED', 'Fichier trop volumineux', {
        fields: { file: ['Image trop lourde (5 Mo maximum)'] },
        details: { maxBytes: MAX_UPLOAD_BYTES },
      });
    }

    // `limitInputPixels` is the decompression-bomb guard; `failOn: 'error'`
    // stops sharp from quietly accepting a truncated or corrupt file.
    const pipeline = sharp(file.buffer, { limitInputPixels: 50_000_000, failOn: 'error' });

    const metadata = await pipeline.metadata().catch(() => null);
    if (!metadata?.format || !ACCEPTED_INPUT_FORMATS.has(metadata.format)) {
      throw new AppError('VALIDATION_FAILED', "Le fichier n'est pas une image lisible", {
        fields: { file: ['Format non supporté. Utilisez JPEG, PNG ou WebP.'] },
      });
    }

    const body = await pipeline
      .rotate() // applies the EXIF orientation BEFORE the tag is dropped, or portraits come out sideways
      .resize({
        width: variant.maxEdge,
        height: variant.maxEdge,
        fit: variant.fit,
        // Never scale a small image up: a 64px avatar blown up to 512 looks
        // worse than the original and costs more to serve.
        withoutEnlargement: true,
      })
      // WebP for everything: ~30% smaller than JPEG at the same quality, and
      // universally supported since 2020. Bandwidth is the scarce resource for
      // a user on Algerian mobile data.
      .webp({ quality: 82 })
      .toBuffer();

    const key = contentAddressedKey(variant.prefix, body, 'webp');
    const url = await this.storage.put(key, body, 'image/webp');
    return { url, key };
  }

  /** Best-effort cleanup of a replaced image. Never throws. */
  async removeByUrl(url: string | null): Promise<void> {
    const key = this.keyFromUrl(url);
    if (key) await this.storage.remove(key).catch(() => undefined);
  }

  /**
   * Recovers the storage key from a stored URL.
   *
   * Returns null for anything that is not one of ours. Historic rows may hold a
   * URL from before this module existed, and deleting a key derived from a
   * stranger's URL would be a bug pointed at our own bucket.
   */
  private keyFromUrl(url: string | null): string | null {
    if (!url) return null;
    for (const prefix of [AVATAR_VARIANT.prefix, LOGO_VARIANT.prefix]) {
      const marker = `/${prefix}/`;
      const at = url.lastIndexOf(marker);
      if (at === -1) continue;
      const key = `${prefix}/${url.slice(at + marker.length)}`;
      // Server-generated keys are `<prefix>/<64 hex chars>.webp` and nothing else.
      if (/^[a-z]+\/[a-f0-9]{32}\.webp$/.test(key)) return key;
    }
    return null;
  }
}
