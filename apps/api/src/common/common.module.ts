import { Global, Module } from '@nestjs/common';
import { AuditService } from './audit/audit.service';
import { AppLogger } from './logging/logger';

/**
 * Cross-cutting services every module needs. Global because passing the logger
 * and the audit writer through six module imports adds noise and no safety.
 */
@Global()
@Module({
  providers: [AppLogger, AuditService],
  exports: [AppLogger, AuditService],
})
export class CommonModule {}
