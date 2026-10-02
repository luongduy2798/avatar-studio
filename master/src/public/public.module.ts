import { Module } from '@nestjs/common'
import { InfrastructureModule } from '../infrastructure/infrastructure.module'
import { JobsModule } from '../jobs/jobs.module'
import { PublicController } from './public.controller'

@Module({
  imports: [InfrastructureModule, JobsModule],
  controllers: [PublicController],
})
export class PublicModule {}
