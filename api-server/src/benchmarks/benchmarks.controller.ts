import {
  BadRequestException,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Res,
  UploadedFile,
  UseInterceptors,
  Body,
} from '@nestjs/common'
import { FileInterceptor } from '@nestjs/platform-express'
import type { Response } from 'express'
import { BenchmarksService } from './benchmarks.service'

@Controller('api/v1/benchmarks')
export class BenchmarksController {
  constructor(private readonly benchmarks: BenchmarksService) {}

  @Post()
  @HttpCode(202)
  @UseInterceptors(FileInterceptor('image', { limits: { fileSize: 25 * 1024 * 1024 } }))
  async create(
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body('expressions') rawExpressions: string | undefined,
    @Body('intensity') rawIntensity: string | undefined,
    @Body('batchSize') rawBatchSize: string | undefined,
    @Body('warmupRuns') rawWarmupRuns: string | undefined,
    @Body('measuredRuns') rawMeasuredRuns: string | undefined,
  ) {
    if (!file) throw new BadRequestException('image is required')
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype)) {
      throw new BadRequestException('image must be JPEG, PNG or WebP')
    }
    const intensity = Number(rawIntensity ?? '1')
    if (!Number.isFinite(intensity) || intensity < 0.5 || intensity > 1.5) {
      throw new BadRequestException('intensity must be between 0.5 and 1.5')
    }
    const batchSize = this.parseInteger(rawBatchSize, 'batchSize', 1, 64)
    const warmupRuns = this.parseInteger(rawWarmupRuns, 'warmupRuns', 1, 3)
    const measuredRuns = this.parseInteger(rawMeasuredRuns, 'measuredRuns', 3, 10)
    return this.benchmarks.create(
      file,
      this.benchmarks.parseExpressions(rawExpressions ?? ''),
      intensity,
      batchSize,
      warmupRuns,
      measuredRuns,
    )
  }

  @Get(':runId')
  get(@Param('runId') runId: string) {
    return this.benchmarks.get(runId)
  }

  @Get(':runId/export')
  async export(
    @Param('runId') runId: string,
    @Query('format') queryFormat: string | undefined,
    @Res() response: Response,
  ) {
    const format = queryFormat ?? 'json'
    if (format === 'csv') {
      const csv = await this.benchmarks.exportCsv(runId)
      response.type('text/csv')
      response.setHeader('Content-Disposition', `attachment; filename="${runId}.csv"`)
      return response.send(csv)
    }
    if (format !== 'json') throw new BadRequestException('format must be json or csv')
    const payload = await this.benchmarks.exportJson(runId)
    response.type('application/json')
    response.setHeader('Content-Disposition', `attachment; filename="${runId}.json"`)
    return response.send(payload)
  }

  private parseInteger(raw: string | undefined, name: string, fallback: number, max: number) {
    const value = Number(raw ?? fallback)
    if (!Number.isInteger(value) || value < 1 || value > max) {
      throw new BadRequestException(`${name} must be an integer between 1 and ${max}`)
    }
    return value
  }
}
