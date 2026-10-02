import { Module } from '@nestjs/common'
import { APP_CONFIG, loadConfig } from '../config'
import { DynamoDbJobStore, LocalJobStore } from './job-store'
import { LocalGenerationQueue, SqsGenerationQueue } from './queue'
import { LocalStorage, S3Storage } from './storage'
import { DynamoDbIdempotencyStore, LocalIdempotencyStore } from './idempotency'
import { DynamoDbRunnerStore, LocalRunnerStore } from './runner-store'
import { IDEMPOTENCY, JOB_STORE, QUEUE, RUNNER_STORE, STORAGE } from './tokens'

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
    {
      provide: IDEMPOTENCY,
      inject: [APP_CONFIG],
      useFactory: (config: ReturnType<typeof loadConfig>) =>
        config.infrastructureMode === 'aws'
          ? new DynamoDbIdempotencyStore(config)
          : new LocalIdempotencyStore(config),
    },
    {
      provide: RUNNER_STORE,
      inject: [APP_CONFIG],
      useFactory: (config: ReturnType<typeof loadConfig>) =>
        config.infrastructureMode === 'aws'
          ? new DynamoDbRunnerStore(config)
          : new LocalRunnerStore(config),
    },
  ],
  exports: [APP_CONFIG, JOB_STORE, STORAGE, QUEUE, IDEMPOTENCY, RUNNER_STORE],
})
export class InfrastructureModule {}
