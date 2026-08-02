import { Module } from '@nestjs/common';
import { MilestonesService } from './milestones.service';
import { OfferMilestonesController } from './milestones.controller';
import { CheckpointAttendanceService } from './checkpoint-attendance.service';
import { CheckpointAttendanceController } from './checkpoint-attendance.controller';

@Module({
  controllers: [OfferMilestonesController, CheckpointAttendanceController],
  providers: [MilestonesService, CheckpointAttendanceService],
})
export class MilestonesModule {}
