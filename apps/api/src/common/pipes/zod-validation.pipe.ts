import { type ArgumentMetadata, Injectable, type PipeTransform } from '@nestjs/common';
import { z } from 'zod';
import { AppError } from '../errors/app-error';

/**
 * VALIDATION AT THE BOUNDARY
 *
 * Every body, query and param passes through one of these before a handler
 * sees it. By the time your service runs, the data has the exact shape its
 * types claim — so the types stop being a hopeful comment and start being true.
 *
 * The pipe is generic over the schema, and Nest infers the handler parameter's
 * type from it. That is why controllers below never declare a DTO class: the
 * Zod schema in @rihlati/shared IS the type, and the web app imports the same
 * one. There is no second definition to drift.
 */
@Injectable()
export class ZodValidationPipe<T extends z.ZodTypeAny> implements PipeTransform {
  constructor(private readonly schema: T) {}

  transform(value: unknown, _metadata: ArgumentMetadata): z.infer<T> {
    const result = this.schema.safeParse(value);

    /**
     * `z.infer<T>` on an unresolved generic is `any` to the linter, so it
     * cannot see that this is exactly the schema's own output type. It is —
     * `safeParse` returns `z.infer<T>` by construction, and the whole point of
     * this pipe is that the value is now proven to have that shape.
     */
    // eslint-disable-next-line @typescript-eslint/no-unsafe-return -- see above
    if (result.success) return result.data;

    // Group issues by field path so a form can highlight each input.
    const fields: Record<string, string[]> = {};
    for (const issue of result.error.issues) {
      const path = issue.path.length > 0 ? issue.path.join('.') : '_';
      (fields[path] ??= []).push(issue.message);
    }

    throw new AppError('VALIDATION_FAILED', 'Données invalides', { fields });
  }
}

/** `@Body(zodBody(createOfferSchema)) input: CreateOfferInput` */
export function zodBody<T extends z.ZodTypeAny>(schema: T): ZodValidationPipe<T> {
  return new ZodValidationPipe(schema);
}

/** `@Query(zodQuery(offerSearchSchema)) query: OfferSearchInput` */
export function zodQuery<T extends z.ZodTypeAny>(schema: T): ZodValidationPipe<T> {
  return new ZodValidationPipe(schema);
}

/**
 * Route params. Always validate these too — `/offers/:id` with an id of
 * `../../etc/passwd` or a 40 KB string reaches your database otherwise.
 */
export const uuidParam = (): ZodValidationPipe<z.ZodString> =>
  new ZodValidationPipe(z.string().uuid('validation.idInvalid'));

export const slugParam = (): ZodValidationPipe<z.ZodString> =>
  new ZodValidationPipe(
    z.string().trim().toLowerCase().min(1).max(120).regex(/^[a-z0-9-]+$/, 'validation.idInvalid'),
  );
