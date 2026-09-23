import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { join } from 'path';
import { __express as hbsExpressEngine } from 'hbs';
import { loadRuntimeEnvironment } from './infrastructure/runtime-env';

import type { NestExpressApplication } from '@nestjs/platform-express';

// AppModule decides which modules to register during import, so environment
// files must be loaded before requiring it.
loadRuntimeEnvironment();
const { AppModule } = require('./app.module') as typeof import('./app.module');

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    abortOnError: process.env.NODE_ENV !== 'development',
  });
  app.enableCors();
  const logger = new Logger('Bootstrap');
  const host = process.env.SERVER_HOST || '0.0.0.0';
  const port = Number(process.env.SERVER_PORT || '3000');

  const clientRoot = join(__dirname, '..', 'client');
  // Keep server code outside the directory exposed by the static middleware.
  app.useStaticAssets(clientRoot, { index: false });
  app.setBaseViewsDir(clientRoot);
  app.setViewEngine('html');
  app.engine('html', hbsExpressEngine);

  await app.listen(port, host);
  logger.log(`Server running on ${host}:${port}`);
  logger.log(`API endpoints ready at http://${host}:${port}/api`);
}

bootstrap();
