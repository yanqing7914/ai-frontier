import { Controller } from '@nestjs/common';
import { ArticleService } from './article.service';

@Controller('api')
export class ArticleController {
  constructor(private readonly articleService: ArticleService) {}
}
