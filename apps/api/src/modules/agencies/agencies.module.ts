import { Module } from '@nestjs/common';
import { AgenciesService } from './agencies.service';
import { AgencyFaqService } from './agency-faq.service';
import { AgencyMembersController, PublicAgenciesController } from './agencies.controller';

@Module({
  controllers: [PublicAgenciesController, AgencyMembersController],
  providers: [AgenciesService, AgencyFaqService],
  exports: [AgenciesService],
})
export class AgenciesModule {}
