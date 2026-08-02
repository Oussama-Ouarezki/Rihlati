import { Global, Module } from '@nestjs/common';
import { APP_CONFIG, loadConfig, type AppConfig } from './env';

/**
 * Global so every module can inject `APP_CONFIG` without importing this module.
 * Config is genuinely cross-cutting; almost nothing else deserves `@Global()`.
 */
@Global()
@Module({
  providers: [
    {
      provide: APP_CONFIG,
      useFactory: (): AppConfig => loadConfig(),
    },
  ],
  exports: [APP_CONFIG],
})
export class ConfigModule {}
