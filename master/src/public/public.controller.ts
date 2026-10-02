import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Inject,
  Param,
  Post,
  UnauthorizedException,
} from '@nestjs/common'
import type { AppConfig } from '../config'
import { expressionIds, type ExpressionId } from '../domain'
import { JobsService } from '../jobs/jobs.service'
import { APP_CONFIG } from '../infrastructure/tokens'

type CreateJobBody = {
  upload_id?: string
  generator?: string
  expressions?: unknown
  intensity?: unknown
}

@Controller('api/v1')
export class PublicController {
  constructor(
    private readonly jobs: JobsService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  private clientId(authorization?: string) {
    const token = authorization?.replace(/^Bearer\s+/i, '').trim()
    if (!token || (this.config.moodlabApiKeys.length > 0 && !this.config.moodlabApiKeys.includes(token))) {
      throw new UnauthorizedException('Invalid integration API key')
    }
    if (this.config.moodlabApiKeys.length === 0) {
      if (this.config.infrastructureMode === 'aws') {
        throw new UnauthorizedException('AVATAR_MOODLAB_API_KEYS is required')
      }
      return 'local-client'
    }
    return 'moodlab'
  }

  @Post('uploads/init')
  async initUpload(
    @Headers('authorization') authorization: string | undefined,
    @Body() body: { content_type?: string },
  ) {
    this.clientId(authorization)
    const contentType = String(body?.content_type ?? '')
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(contentType)) {
      throw new BadRequestException('content_type must be image/jpeg, image/png or image/webp')
    }
    if (this.config.infrastructureMode !== 'aws') {
      throw new BadRequestException('Presigned uploads require AVATAR_INFRA_MODE=aws')
    }
    const upload = await this.jobs.initUpload(contentType)
    return {
      upload_id: upload.uploadId,
      object_key: upload.key,
      upload_url: upload.uploadUrl,
      expires_in_seconds: upload.expiresInSeconds,
    }
  }

  @Post('jobs')
  async create(
    @Headers('authorization') authorization: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: CreateJobBody,
  ) {
    const clientId = this.clientId(authorization)
    if (!idempotencyKey || idempotencyKey.length < 8 || idempotencyKey.length > 200) {
      throw new BadRequestException('Idempotency-Key header is required')
    }
    if (body.generator && body.generator !== 'liveportrait') {
      throw new BadRequestException('Unsupported generator: ' + body.generator)
    }
    const expressions = this.parseExpressions(body.expressions)
    const intensity = Number(body.intensity ?? 1)
    if (!Number.isFinite(intensity) || intensity < 0.5 || intensity > 1.5) {
      throw new BadRequestException('intensity must be between 0.5 and 1.5')
    }
    if (!body.upload_id) throw new BadRequestException('upload_id is required')
    try {
      const response = await this.jobs.createFromUpload(
        body.upload_id,
        expressions,
        intensity,
        clientId,
        idempotencyKey,
      )
      return {
        job_id: response.job_id,
        status: response.status,
        status_url: this.config.publicUrl.replace(/\/$/, '') + '/api/v1/jobs/' + encodeURIComponent(response.job_id),
      }
    } catch (error) {
      if (error instanceof Error && /upload|expression|intensity|ready/i.test(error.message)) {
        throw new BadRequestException(error.message)
      }
      throw error
    }
  }

  @Get('jobs/:jobId')
  get(
    @Headers('authorization') authorization: string | undefined,
    @Param('jobId') jobId: string,
  ) {
    return this.jobs.get(jobId, this.clientId(authorization))
  }

  @Post('jobs/:jobId/cancel')
  cancel(
    @Headers('authorization') authorization: string | undefined,
    @Param('jobId') jobId: string,
  ) {
    return this.jobs.cancel(jobId, this.clientId(authorization))
  }

  private parseExpressions(raw: unknown): ExpressionId[] {
    if (!Array.isArray(raw) || raw.length === 0) {
      throw new BadRequestException('expressions must be a non-empty array')
    }
    const values = [...new Set(raw.map(String))]
    const unsupported = values.filter((value) => !expressionIds.includes(value as ExpressionId))
    if (unsupported.length) throw new BadRequestException('Unsupported expressions: ' + unsupported.join(', '))
    return values as ExpressionId[]
  }
}
