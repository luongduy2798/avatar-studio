import { Body, Controller, Get, Headers, Param, Post } from '@nestjs/common'
import { AdminService } from './admin.service'

@Controller('api/v1/admin')
export class AdminController {
  constructor(private readonly admin: AdminService) {}

  private token(authorization?: string) {
    return authorization?.replace(/^Bearer\s+/i, '').trim()
  }

  @Post('runners/enrollment-codes')
  createCode(
    @Headers('authorization') authorization: string | undefined,
    @Body() body: { ttl_seconds?: number },
  ) {
    this.admin.authorize(this.token(authorization))
    return this.admin.createEnrollmentCode(Number(body?.ttl_seconds ?? 900))
  }

  @Get('runners')
  list(@Headers('authorization') authorization: string | undefined) {
    this.admin.authorize(this.token(authorization))
    return this.admin.listRunners()
  }

  @Get('runners/:runnerId')
  get(
    @Headers('authorization') authorization: string | undefined,
    @Param('runnerId') runnerId: string,
  ) {
    this.admin.authorize(this.token(authorization))
    return this.admin.getRunner(runnerId)
  }

  @Post('runners/:runnerId/revoke')
  revoke(
    @Headers('authorization') authorization: string | undefined,
    @Param('runnerId') runnerId: string,
  ) {
    this.admin.authorize(this.token(authorization))
    return this.admin.revokeRunner(runnerId)
  }

  @Get('metrics')
  metrics(@Headers('authorization') authorization: string | undefined) {
    this.admin.authorize(this.token(authorization))
    return this.admin.metrics()
  }
}
