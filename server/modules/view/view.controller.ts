import { Controller, Get, Render, Req } from '@nestjs/common';
import type { Request } from 'express';

@Controller()
export class ViewController {

  @Get(['/', '*'])
  @Render('index')
  async render(@Req() _req: Request): Promise<Record<string, never>>  {
    return {
    };
  }
}
