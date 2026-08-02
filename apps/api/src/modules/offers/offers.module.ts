import { Module } from '@nestjs/common';
import { OffersService } from './offers.service';
import { OfferReportsService } from './offer-reports.service';
import { OfferMetricsService } from './offer-metrics.service';
import { AgencyAnalyticsController, AgencyOffersController, PublicOffersController } from './offers.controller';

@Module({
  controllers: [PublicOffersController, AgencyOffersController, AgencyAnalyticsController],
  providers: [OffersService, OfferReportsService, OfferMetricsService],
  exports: [OffersService, OfferMetricsService],
})
export class OffersModule {}
