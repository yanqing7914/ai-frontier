import { Controller } from '@nestjs/common';
import { DigestService } from './digest.service';

@Controller('api/daily-digests')
export class DigestController {
  constructor(private readonly digestService: DigestService) {}
}
