import { Module } from '@nestjs/common';
import { AdminAgenciesController } from './admin-agencies.controller';
import { AdminAgenciesService } from './admin-agencies.service';

/** Rihlati's own back office. Everything in here is cross-tenant by design. */
@Module({
  controllers: [AdminAgenciesController],
  providers: [AdminAgenciesService],
})
export class AdminModule {}
