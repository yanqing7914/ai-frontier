import { Controller, Get, Param } from '@nestjs/common';
import { DigestService } from './digest.service';

@Controller('api/daily-digests')
export class DigestController {
  constructor(private readonly digestService: DigestService) {}

  @Get(':date')
  async getDigestByDate(@Param('date') date: string) {
    return this.digestService.getDigestByDate(date);
  }
}
