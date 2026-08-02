import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  Inject,
} from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
import { Prisma } from '@prisma/client';
import type { Request, Response } from 'express';
import { z } from 'zod';
import type { ApiErrorBody, ErrorCode } from '@rihlati/shared';
import { ERROR_STATUS } from '@rihlati/shared';
import { AppError } from '../errors/app-error';
import { AppLogger } from '../logging/logger';
import { APP_CONFIG, type AppConfig } from '../../config/env';
import { captureException } from '../observability/sentry';

/**
 * THE LAST LINE OF DEFENCE
 *
 * Every error that escapes a handler ends up here, and exactly one shape of
 * response leaves. Two rules it exists to enforce:
 *
 *   1. A client never sees a stack trace, a SQL fragment, a table name, or a
 *      Prisma error code. Those tell an attacker your schema for free.
 *   2. Every response carries the `requestId`, so a user can report "it broke,
 *      here is the id" and you can find the exact log line (rule #4).
 *
 * An unhandled 500 is an incident, so it is logged at `error` with the full
 * detail server-side — the redaction is only about what crosses the network.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  constructor(
    private readonly logger: AppLogger,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const req = ctx.getRequest<Request>();
    const res = ctx.getResponse<Response>();
    const requestId = req.requestId ?? 'unknown';

    const { code, message, fields, details, isUnexpected } = this.classify(exception);
    const status = ERROR_STATUS[code];

    const logContext = {
      requestId,
      userId: req.auth?.userId,
      method: req.method,
      // `req.route?.path` is the PATTERN ("/offers/:id"), not the filled-in URL.
      // Logging the pattern keeps ids out of the log and groups errors properly.
      route: (req.route as { path?: string } | undefined)?.path ?? req.path,
      status,
      code,
    };

    if (isUnexpected) {
      this.logger.error(message, {
        ...logContext,
        stack: exception instanceof Error ? exception.stack : String(exception),
      });

      // Only UNEXPECTED errors reach the tracker. A 404 or a validation
      // failure is the app working correctly; reporting those is how people
      // learn to ignore the alerts (rule #4).
      captureException(exception, {
        requestId,
        ...(req.auth?.userId ? { userId: req.auth.userId } : {}),
        ...(logContext.route ? { route: logContext.route } : {}),
      });
    } else if (status >= 500) {
      this.logger.error(message, logContext);
    } else {
      this.logger.warn(message, logContext);
    }

    const body: ApiErrorBody = {
      error: {
        code,
        // An unexpected error's real message can contain a connection string or
        // a row's contents. The client gets a constant; the detail is in the log.
        message: isUnexpected ? 'Une erreur interne est survenue' : message,
        ...(fields ? { fields } : {}),
        ...(details ? { details } : {}),
        requestId,
      },
    };

    res.status(status).json(body);
  }

  private classify(exception: unknown): {
    code: ErrorCode;
    message: string;
    fields?: Record<string, string[]>;
    details?: Record<string, unknown>;
    isUnexpected: boolean;
  } {
    if (exception instanceof AppError) {
      return {
        code: exception.code,
        message: exception.message,
        ...(exception.fields ? { fields: exception.fields } : {}),
        ...(exception.details ? { details: exception.details } : {}),
        isUnexpected: false,
      };
    }

    // A Zod error that escaped the pipe — e.g. thrown inside a service.
    if (exception instanceof z.ZodError) {
      const fields: Record<string, string[]> = {};
      for (const issue of exception.issues) {
        const path = issue.path.length > 0 ? issue.path.join('.') : '_';
        (fields[path] ??= []).push(issue.message);
      }
      return { code: 'VALIDATION_FAILED', message: 'Données invalides', fields, isUnexpected: false };
    }

    if (exception instanceof ThrottlerException) {
      return {
        code: 'RATE_LIMITED',
        message: 'Trop de requêtes. Réessayez dans un instant.',
        isUnexpected: false,
      };
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      // Nest's own 404 for an unmatched route, 401 from a guard, etc.
      const code: ErrorCode =
        status === 401 ? 'UNAUTHENTICATED'
        : status === 403 ? 'FORBIDDEN'
        : status === 404 ? 'NOT_FOUND'
        : status === 429 ? 'RATE_LIMITED'
        : status >= 500 ? 'INTERNAL'
        : 'VALIDATION_FAILED';
      return { code, message: exception.message, isUnexpected: status >= 500 };
    }

    /**
     * Prisma errors are translated, never forwarded. `P2002` on a unique index
     * would otherwise tell the caller the exact constraint and column names.
     */
    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      if (exception.code === 'P2025') {
        return { code: 'NOT_FOUND', message: 'Ressource introuvable', isUnexpected: false };
      }
      if (exception.code === 'P2002') {
        return { code: 'VALIDATION_FAILED', message: 'Cette valeur est déjà utilisée', isUnexpected: false };
      }
      if (exception.code === 'P2003') {
        return { code: 'VALIDATION_FAILED', message: 'Référence invalide', isUnexpected: false };
      }
      // Anything else is a bug in our query, not the caller's fault.
      return {
        code: 'INTERNAL',
        message: `Prisma ${exception.code}: ${exception.message}`,
        isUnexpected: true,
      };
    }

    return {
      code: 'INTERNAL',
      message: exception instanceof Error ? exception.message : String(exception),
      isUnexpected: true,
    };
  }
}
