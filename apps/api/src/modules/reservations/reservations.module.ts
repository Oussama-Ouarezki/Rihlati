import { Module } from '@nestjs/common';
import { ReservationsService } from './reservations.service';
import { ReservationsController } from './reservations.controller';

@Module({
  controllers: [ReservationsController],
  providers: [ReservationsService],
  // Exported for the future chatbot's create_reservation tool — the bot acts
  // through this service like any other caller (Agency Chatbot note).
  exports: [ReservationsService],
})
export class ReservationsModule {}
