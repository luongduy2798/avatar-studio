import { Module } from '@nestjs/common'
import { InfrastructureModule } from '../infrastructure/infrastructure.module'
import { AdminController } from './admin.controller'
import { AdminService } from './admin.service'
import { AdminUiController } from './admin-ui.controller'
import { MasterModule } from '../master/master.module'

@Module({
  imports: [InfrastructureModule, MasterModule],
  controllers: [AdminController, AdminUiController],
  providers: [AdminService],
  exports: [AdminService],
})
export class AdminModule {}
