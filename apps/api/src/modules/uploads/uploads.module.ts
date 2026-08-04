import { Module } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../../config/env';
import { ImageService } from './image.service';
import { LocalDiskStorage, S3Storage, STORAGE_DRIVER } from './storage';
import { MediaController } from './media.controller';
import { UploadsController } from './uploads.controller';
import { UploadsService } from './uploads.service';

/**
 * The storage driver is chosen once, at boot, from config — not per call.
 *
 * `useFactory` is what lets `ImageService` depend on the INTERFACE and never
 * learn which implementation it got. Swapping local disk for object storage is
 * then a `.env` change, and no other file in the codebase notices.
 */
const storageProvider = {
  provide: STORAGE_DRIVER,
  inject: [APP_CONFIG, LocalDiskStorage, S3Storage],
  useFactory: (config: AppConfig, local: LocalDiskStorage, s3: S3Storage) =>
    config.STORAGE_DRIVER === 's3' ? s3 : local,
};

@Module({
  controllers: [UploadsController, MediaController],
  providers: [UploadsService, ImageService, LocalDiskStorage, S3Storage, storageProvider],
  exports: [ImageService],
})
export class UploadsModule {}
