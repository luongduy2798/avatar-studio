import { Body, Controller, Get, Header, Headers, Param, Post } from '@nestjs/common'
import { AdminService } from './admin.service'

@Controller('api/v1/admin')
export class AdminController {
  constructor(private readonly admin: AdminService) {}

  private token(authorization?: string) {
    return authorization?.replace(/^Bearer\s+/i, '').trim()
  }

  @Post('runners/enrollment-codes')
  @Header('Cache-Control', 'no-store')
  createCode(
    @Headers('authorization') authorization: string | undefined,
    @Body() body: { ttl_seconds?: number },
  ) {
    this.admin.authorize(this.token(authorization))
    return this.admin.createEnrollmentCode(Number(body?.ttl_seconds ?? 900))
  }

  @Get('runners')
  @Header('Cache-Control', 'no-store')
  list(@Headers('authorization') authorization: string | undefined) {
    this.admin.authorize(this.token(authorization))
    return this.admin.listRunners()
  }

  @Get('runners/:runnerId')
  @Header('Cache-Control', 'no-store')
  get(
    @Headers('authorization') authorization: string | undefined,
    @Param('runnerId') runnerId: string,
  ) {
    this.admin.authorize(this.token(authorization))
    return this.admin.getRunner(runnerId)
  }

  @Post('runners/:runnerId/revoke')
  @Header('Cache-Control', 'no-store')
  revoke(
    @Headers('authorization') authorization: string | undefined,
    @Param('runnerId') runnerId: string,
  ) {
    this.admin.authorize(this.token(authorization))
    return this.admin.revokeRunner(runnerId)
  }

  @Get('metrics')
  @Header('Cache-Control', 'no-store')
  metrics(@Headers('authorization') authorization: string | undefined) {
    this.admin.authorize(this.token(authorization))
    return this.admin.metrics()
  }
}
