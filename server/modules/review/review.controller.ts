import {
  Controller,
  Get,
  Patch,
  Param,
  Query,
  Body,
  UseGuards,
} from '@nestjs/common';
import { AdminTokenGuard } from '../../common/guards/admin-token.guard';
import { ReviewService } from './review.service';
import type { ReviewActionRequest } from '@shared/api.interface';

@Controller('api/workbench/reviews')
export class ReviewController {
  constructor(private readonly reviewService: ReviewService) {}

  @Get()
  async getReviews(
    @Query('page') page: string,
    @Query('pageSize') pageSize: string,
    @Query('status') status?: string,
  ) {
    return this.reviewService.getReviews({
      page: parseInt(page, 10) || 1,
      pageSize: parseInt(pageSize, 10) || 20,
      status,
    });
  }

  @Patch(':id')
  @UseGuards(AdminTokenGuard)
  async processReview(
    @Param('id') id: string,
    @Body() body: ReviewActionRequest,
  ) {
    return this.reviewService.processReview(
      id,
      body.action,
      body.note,
    );
  }
}
