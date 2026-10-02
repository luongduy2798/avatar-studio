import { Module } from '@nestjs/common'
import { InfrastructureModule } from '../infrastructure/infrastructure.module'
import { JobsService } from './jobs.service'

@Module({
  imports: [InfrastructureModule],
  providers: [JobsService],
  exports: [JobsService],
})
export class JobsModule {}
