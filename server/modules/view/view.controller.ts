import {
  Controller,
  Get,
  NotFoundException,
  Render,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';

@Controller()
export class ViewController {

  @Get(['/', '*'])
  @Render('index')
  async render(@Req() request: Request): Promise<Record<string, never>> {
    const pathname = request.path || request.url.split('?')[0];
    // Let API and asset requests keep their normal 404 semantics instead of
    // masking a missing resource with the SPA shell.
    if (
      pathname === '/api' ||
      pathname.startsWith('/api/') ||
      pathname.includes('.')
    ) {
      throw new NotFoundException();
    }
    return {
    };
  }
}
