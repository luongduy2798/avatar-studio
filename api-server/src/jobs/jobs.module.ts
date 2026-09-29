import { Module } from '@nestjs/common'
import { InfrastructureModule } from '../infrastructure/infrastructure.module'
import { JobsController } from './jobs.controller'
import { JobsService } from './jobs.service'

@Module({
  imports: [InfrastructureModule],
  controllers: [JobsController],
  providers: [JobsService],
})
export class JobsModule {}
