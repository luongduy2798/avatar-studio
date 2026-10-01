import { Module } from '@nestjs/common'
import { HealthController } from './health.controller'
import { InfrastructureModule } from './infrastructure/infrastructure.module'
import { JobsModule } from './jobs/jobs.module'
import { BenchmarksModule } from './benchmarks/benchmarks.module'

@Module({
  imports: [InfrastructureModule, JobsModule, BenchmarksModule],
  controllers: [HealthController],
})
export class AppModule {}
