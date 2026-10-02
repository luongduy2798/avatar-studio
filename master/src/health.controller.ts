import { Controller, Get, Inject } from '@nestjs/common'
import { APP_CONFIG, type AppConfig } from './config'

@Controller('api/v1')
export class HealthController {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  @Get('health')
  health() {
    return {
      status: 'ready',
      service: 'avatar-master',
      infrastructure: this.config.infrastructureMode,
    }
  }
}
