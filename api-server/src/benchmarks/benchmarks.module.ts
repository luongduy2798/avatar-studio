import { Module } from '@nestjs/common'
import { InfrastructureModule } from '../infrastructure/infrastructure.module'
import { BenchmarksController } from './benchmarks.controller'
import { BenchmarksService } from './benchmarks.service'

@Module({
  imports: [InfrastructureModule],
  controllers: [BenchmarksController],
  providers: [BenchmarksService],
})
export class BenchmarksModule {}
