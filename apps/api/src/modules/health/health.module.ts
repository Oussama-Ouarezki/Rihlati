import { Controller, Get, Module } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { Public } from '../../common/auth/auth.decorators';
import { PrismaService } from '../../common/prisma/prisma.service';

/**
 * `/health` — is the process up and can it reach the database?
 *
 * Deliberately says almost nothing. No version, no hostname, no migration
 * state, no dependency list: a health endpoint is public by necessity, and
 * every extra field is free reconnaissance. The load balancer only needs a 200.
 */
@Controller('health')
class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Public()
  @SkipThrottle()
  @Get()
  async check(): Promise<{ status: 'ok' | 'degraded' }> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return { status: 'ok' };
    } catch {
      return { status: 'degraded' };
    }
  }
}

@Module({ controllers: [HealthController] })
export class HealthModule {}
