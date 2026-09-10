import { Controller, HttpStatus, All, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';

@Controller('api')
export class ApiUnavailableController {
  @All('*')
  unavailable(@Req() _request: Request, @Res() response: Response) {
    return response.status(HttpStatus.SERVICE_UNAVAILABLE).json({
      error: {
        code: 'SERVICE_UNAVAILABLE',
        message: '数据库未配置，业务 API 暂不可用',
        timestamp: Date.now(),
      },
    });
  }
}
