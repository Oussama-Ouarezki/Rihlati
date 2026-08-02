import { Module } from '@nestjs/common';
import { OffersModule } from '../offers/offers.module';
import { TrackedLinksModule } from '../tracked-links/tracked-links.module';
import { LeadsService } from './leads.service';
import { AgencyLeadsController, InquiriesController } from './leads.controller';

@Module({
  // For OfferMetricsService: an inquiry ticks the offer's analytics inside
  // the same transaction that creates the lead.
  imports: [OffersModule, TrackedLinksModule],
  controllers: [InquiriesController, AgencyLeadsController],
  providers: [LeadsService],
  exports: [LeadsService],
})
export class LeadsModule {}
