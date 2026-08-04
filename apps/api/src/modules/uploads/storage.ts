import { createHash } from 'node:crypto';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, normalize, resolve, sep } from 'node:path';
import { Inject, Injectable } from '@nestjs/common';
import { DeleteObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { APP_CONFIG, type AppConfig } from '../../config/env';

/**
 * WHERE UPLOADED BYTES LIVE
 *
 * One interface, two implementations. The rest of the codebase never learns
 * which one is active — that is the whole point of putting a seam here. Moving
 * from a disk in development to object storage in production must be a config
 * change, not an edit to every place that touches an image.
 *
 * A `key` is a path-like string owned by us (`avatars/<uuid>.webp`). It is
 * never derived from a filename the client sent: see `ImageService`.
 */
export interface StorageDriver {
  /** Writes the bytes and returns the public URL they can be read at. */
  put(key: string, body: Buffer, contentType: string): Promise<string>;
  /** Best-effort. A failed delete must not fail the request that triggered it. */
  remove(key: string): Promise<void>;
  /** The public URL for a key that is already stored. */
  urlFor(key: string): string;
}

export const STORAGE_DRIVER = Symbol('STORAGE_DRIVER');

/**
 * Development driver: writes under `STORAGE_LOCAL_DIR`, served back by the
 * `/media` route. Refuses in production (see `loadConfig`) — files on a
 * container's filesystem do not survive the next deploy.
 */
@Injectable()
export class LocalDiskStorage implements StorageDriver {
  private readonly root: string;

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {
    this.root = resolve(config.STORAGE_LOCAL_DIR);
  }

  async put(key: string, body: Buffer, _contentType: string): Promise<string> {
    const path = this.pathFor(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, body);
    return this.urlFor(key);
  }

  async remove(key: string): Promise<void> {
    await unlink(this.pathFor(key)).catch(() => undefined);
  }

  urlFor(key: string): string {
    return `${this.config.MEDIA_BASE_URL.replace(/\/$/, '')}/${key}`;
  }

  /**
   * Resolves a key to an absolute path and proves it stayed inside the root.
   *
   * Every key this module writes is server-generated, so traversal should be
   * impossible — but this function is also what the `/media` READ route uses,
   * and there the key comes straight off the URL. `../../etc/passwd` is the
   * oldest file-server bug there is; the check costs nothing.
   */
  pathFor(key: string): string {
    const path = resolve(join(this.root, normalize(key)));
    if (path !== this.root && !path.startsWith(this.root + sep)) {
      throw new Error('Chemin de stockage hors du répertoire autorisé');
    }
    return path;
  }
}

/**
 * Production driver. S3-compatible rather than AWS-specific on purpose: the
 * same code runs against Scaleway, Backblaze, Wasabi or a self-hosted MinIO,
 * which matters when serving Algeria and latency to eu-west is the constraint.
 *
 * > [!warning] Not yet exercised against a real bucket. Verify the bucket's
 * > public-read policy and CORS before launch — objects are written without an
 * > ACL, because most S3-compatible providers reject `public-read` outright and
 * > expect a bucket policy instead.
 */
@Injectable()
export class S3Storage implements StorageDriver {
  private cachedClient: S3Client | null = null;

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  /**
   * Built on first use, not in the constructor.
   *
   * Nest instantiates every provider at boot, including this one when the local
   * driver is the one actually selected — and in development the S3 settings
   * are legitimately absent. Constructing a client from undefined credentials
   * there would fail startup for a driver nobody asked for.
   *
   * By the time this runs, `loadConfig` has already refused to boot with
   * `STORAGE_DRIVER=s3` and any setting missing, so the assertions below record
   * that guarantee rather than re-checking it.
   */
  private get client(): S3Client {
    this.cachedClient ??= new S3Client({
      endpoint: this.config.S3_ENDPOINT!,
      region: this.config.S3_REGION!,
      credentials: {
        accessKeyId: this.config.S3_ACCESS_KEY_ID!,
        secretAccessKey: this.config.S3_SECRET_ACCESS_KEY!,
      },
    });
    return this.cachedClient;
  }

  private get bucket(): string {
    return this.config.S3_BUCKET!;
  }

  async put(key: string, body: Buffer, contentType: string): Promise<string> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        // Immutable: the key contains a content hash, so a changed picture is a
        // new key. That lets the CDN cache forever and makes a stale avatar
        // impossible.
        CacheControl: 'public, max-age=31536000, immutable',
      }),
    );
    return this.urlFor(key);
  }

  async remove(key: string): Promise<void> {
    await this.client
      .send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }))
      .catch(() => undefined);
  }

  urlFor(key: string): string {
    return `${this.config.MEDIA_BASE_URL.replace(/\/$/, '')}/${key}`;
  }
}

/**
 * A key that changes whenever the bytes change.
 *
 * Why not `avatars/<userId>.webp`? Two reasons. It would be guessable — anyone
 * could check whether a given user has a picture — and it would be overwritten
 * in place, so a CDN would keep serving the old face for as long as its cache
 * lasted. Hashing the content solves both, and makes the object safely
 * cacheable forever.
 */
export function contentAddressedKey(prefix: string, body: Buffer, extension: string): string {
  const digest = createHash('sha256').update(body).digest('hex').slice(0, 32);
  return `${prefix}/${digest}.${extension}`;
}
