import { Module } from '@nestjs/common'
import { APP_CONFIG, loadConfig } from '../config'
import { DynamoDbJobStore, LocalJobStore } from './job-store'
import { LocalGenerationQueue, SqsGenerationQueue } from './queue'
import { LocalStorage, S3Storage } from './storage'
import { JOB_STORE, QUEUE, STORAGE } from './tokens'

@Module({
  providers: [
    { provide: APP_CONFIG, useFactory: loadConfig },
    {
      provide: JOB_STORE,
      inject: [APP_CONFIG],
      useFactory: (config: ReturnType<typeof loadConfig>) =>
        config.infrastructureMode === 'aws' ? new DynamoDbJobStore(config) : new LocalJobStore(config),
    },
    {
      provide: STORAGE,
      inject: [APP_CONFIG],
      useFactory: (config: ReturnType<typeof loadConfig>) =>
        config.infrastructureMode === 'aws' ? new S3Storage(config) : new LocalStorage(config),
    },
    {
      provide: QUEUE,
      inject: [APP_CONFIG],
      useFactory: (config: ReturnType<typeof loadConfig>) =>
        config.infrastructureMode === 'aws'
          ? new SqsGenerationQueue(config)
          : new LocalGenerationQueue(config),
    },
  ],
  exports: [APP_CONFIG, JOB_STORE, STORAGE, QUEUE],
})
export class InfrastructureModule {}
