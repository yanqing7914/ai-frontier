import { Controller } from '@nestjs/common';
import { FeedSourceService } from './feed-source.service';

@Controller('api/feed-sources')
export class FeedSourceController {
  constructor(private readonly feedSourceService: FeedSourceService) {}
}
