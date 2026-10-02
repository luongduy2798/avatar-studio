import { Controller, Get, NotFoundException, Param, Res } from '@nestjs/common'
import type { Response } from 'express'
import path from 'node:path'

const uiRoot = path.resolve(__dirname, '../../admin-ui/dist')
const assets = new Set(['admin.js', 'styles.css'])

@Controller('admin')
export class AdminUiController {
  @Get()
  index(@Res() response: Response) {
    return this.sendFile(response, 'index.html')
  }

  @Get('assets/:fileName')
  asset(@Param('fileName') fileName: string, @Res() response: Response) {
    if (!assets.has(fileName)) throw new NotFoundException('Admin asset not found')
    return this.sendFile(response, fileName)
  }

  private sendFile(response: Response, fileName: string) {
    response.set({
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    })
    return response.sendFile(fileName, { root: uiRoot })
  }
}
