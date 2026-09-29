import { Module } from '@nestjs/common'
import { HealthController } from './health.controller'
import { InfrastructureModule } from './infrastructure/infrastructure.module'
import { JobsModule } from './jobs/jobs.module'

@Module({
  imports: [InfrastructureModule, JobsModule],
  controllers: [HealthController],
})
export class AppModule {}
