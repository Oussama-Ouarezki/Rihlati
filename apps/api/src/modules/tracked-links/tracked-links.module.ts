import { Module } from '@nestjs/common';
import { TrackedLinksService } from './tracked-links.service';
import {
  AgencyTrackedLinksController,
  PublicTrackedLinksController,
} from './tracked-links.controller';

@Module({
  controllers: [PublicTrackedLinksController, AgencyTrackedLinksController],
  providers: [TrackedLinksService],
  // Exported for LeadsModule: an inquiry resolves its `ref` and bumps the
  // link's conversion counter inside the same transaction as the lead.
  exports: [TrackedLinksService],
})
export class TrackedLinksModule {}
