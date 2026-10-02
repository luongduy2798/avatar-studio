import { Module } from '@nestjs/common'
import { InfrastructureModule } from '../infrastructure/infrastructure.module'
import { MasterService } from './master.service'

@Module({
  imports: [InfrastructureModule],
  providers: [MasterService],
  exports: [MasterService],
})
export class MasterModule {}
