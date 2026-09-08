import { Controller, Get } from '@nestjs/common';

@Controller('health')
export class HealthController {
  @Get()
  getHealth() {
    return {
      status: 'ok',
      service: 'ai-frontier',
      timestamp: new Date().toISOString(),
    };
  }
}
