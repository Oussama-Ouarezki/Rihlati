import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Controller, Get, Inject, Param, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Public } from '../../common/auth/auth.decorators';
import { notFound } from '../../common/errors/app-error';
import { APP_CONFIG, type AppConfig } from '../../config/env';
import { LocalDiskStorage } from './storage';

/**
 * SERVING LOCALLY STORED IMAGES — DEVELOPMENT ONLY
 *
 * In production `STORAGE_DRIVER=s3` and the bucket (or a CDN in front of it)
 * answers these URLs directly; this controller is never reached. It exists so
 * that `npm run dev` works without anyone standing up object storage first.
 *
 * The route is always mounted but answers 404 unless the local driver is
 * active, so a misconfigured production cannot accidentally start serving files
 * off the API container's disk.
 *
 * The headers are the interesting part. Serving user-uploaded files is the
 * classic stored-XSS route, so:
 *   - `Content-Type` is pinned to `image/webp`, because that is the only thing
 *     `ImageService` ever writes. It is never guessed from the file.
 *   - `X-Content-Type-Options: nosniff` stops the browser overriding that and
 *     deciding some bytes look like HTML.
 *   - `Content-Security-Policy: sandbox` makes the response inert even if
 *     something did slip through.
 */
@Controller('media')
export class MediaController {
  constructor(
    private readonly storage: LocalDiskStorage,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Public()
  @Get('*key')
  async serve(@Param('key') segments: string[] | string, @Res() res: Response): Promise<void> {
    if (this.config.STORAGE_DRIVER !== 'local') throw notFound('Image');

    const key = Array.isArray(segments) ? segments.join('/') : segments;

    // Only keys this API generates: `<prefix>/<32 hex chars>.webp`. Anything
    // else is a probe. Checked BEFORE touching the filesystem — the path guard
    // in `pathFor` is the second line of defence, not the first.
    if (!/^[a-z]+\/[a-f0-9]{32}\.webp$/.test(key)) throw notFound('Image');

    let path: string;
    try {
      path = this.storage.pathFor(key);
      const info = await stat(path);
      if (!info.isFile()) throw new Error('not a file');
    } catch {
      throw notFound('Image');
    }

    res.setHeader('Content-Type', 'image/webp');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    // Safe to cache forever: the key is a hash of the bytes, so different
    // content is always a different URL.
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');

    createReadStream(path).pipe(res);
  }
}
