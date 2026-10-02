import { Module, type Type } from '@nestjs/common'
import path from 'node:path'
import { HealthController } from './health.controller'
import { InfrastructureModule } from './infrastructure/infrastructure.module'
import { JobsModule } from './jobs/jobs.module'
import { PublicModule } from './public/public.module'
import { AdminModule } from './admin/admin.module'
import { MasterModule } from './master/master.module'

function localBenchmarkModules() {
  // Keep benchmark-only controllers outside the production Master package.
  // The internal dev stack opts in explicitly; production leaves this off.
  if (process.env.AVATAR_LOCAL_BENCHMARKS !== '1') return []
  const modulePath = path.resolve(__dirname, '../../internal/benchmark-api/module.ts')
  const loaded = require(modulePath) as { LocalBenchmarkModule: Type<unknown> }
  return [loaded.LocalBenchmarkModule]
}

@Module({
  imports: [
    InfrastructureModule,
    JobsModule,
    PublicModule,
    AdminModule,
    MasterModule,
    ...localBenchmarkModules(),
  ],
  controllers: [HealthController],
})
export class AppModule {}
