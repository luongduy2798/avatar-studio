import { Module } from '@nestjs/common'
import { InfrastructureModule } from '../../master/src/infrastructure/infrastructure.module'
import { JobsModule } from '../../master/src/jobs/jobs.module'
import { BenchmarksController } from './benchmarks.controller'
import { BenchmarksService } from './benchmarks.service'
import { JobsController } from './jobs.controller'

@Module({
  imports: [InfrastructureModule, JobsModule],
  controllers: [BenchmarksController, JobsController],
  providers: [BenchmarksService],
})
export class LocalBenchmarkModule {}
