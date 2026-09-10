import { Module } from '@nestjs/common';
import { ApiUnavailableController } from './api-unavailable.controller';

@Module({ controllers: [ApiUnavailableController] })
export class ApiUnavailableModule {}
