import {
  BadRequestException,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Res,
  UploadedFile,
  UseInterceptors,
  Body,
} from '@nestjs/common'
import { FileInterceptor } from '@nestjs/platform-express'
import type { Response } from 'express'
import { JobsService } from './jobs.service'

@Controller('api/v1')
export class JobsController {
  constructor(private readonly jobs: JobsService) {}

  @Post('avatar/expression-jobs')
  @HttpCode(202)
  @UseInterceptors(FileInterceptor('image', { limits: { fileSize: 25 * 1024 * 1024 } }))
  async create(
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body('expressions') rawExpressions: string | undefined,
    @Body('intensity') rawIntensity: string | undefined,
    @Body('generator') generator: string | undefined,
  ) {
    if (!file) throw new BadRequestException('image is required')
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype)) {
      throw new BadRequestException('image must be JPEG, PNG or WebP')
    }
    if (generator && generator !== 'liveportrait') {
      throw new BadRequestException('Unsupported generator: ' + generator)
    }
    const intensity = Number(rawIntensity ?? '1')
    if (!Number.isFinite(intensity) || intensity < 0.5 || intensity > 1.5) {
      throw new BadRequestException('intensity must be between 0.5 and 1.5')
    }
    if (!rawExpressions) throw new BadRequestException('expressions is required')
    try {
      return await this.jobs.create(file, this.jobs.parseExpressions(rawExpressions), intensity)
    } catch (error) {
      if (error instanceof Error && (
        error.message.startsWith('expressions ') ||
        error.message.startsWith('Choose ') ||
        error.message.startsWith('Unsupported expressions')
      )) {
        throw new BadRequestException(error.message)
      }
      throw error
    }
  }

  @Get('avatar/expression-jobs/:jobId')
  get(@Param('jobId') jobId: string) {
    return this.jobs.get(jobId)
  }

  @Get('files/:jobId/:fileName')
  async file(
    @Param('jobId') jobId: string,
    @Param('fileName') fileName: string,
    @Res() response: Response,
  ) {
    const payload = await this.jobs.readLocalResult(jobId, fileName)
    if (!payload) return response.status(404).json({ detail: 'Output file not found' })
    response.type('image/png')
    return response.send(payload)
  }
}
