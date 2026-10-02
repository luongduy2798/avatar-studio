import 'reflect-metadata'
import { NestFactory } from '@nestjs/core'
import { AppModule } from './app.module'
import { loadConfig } from './config'
import { MasterService } from './master/master.service'

async function bootstrap() {
  const config = loadConfig()
  const app = await NestFactory.create(AppModule)
  app.enableCors({
    origin: config.corsOrigins,
    methods: ['GET', 'POST'],
  })
  await app.listen(config.port, '0.0.0.0')
  if (config.masterEnabled) {
    app.get(MasterService).start(app.getHttpServer())
  }
}

void bootstrap()
