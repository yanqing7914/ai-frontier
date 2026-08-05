import { BadRequestException } from '@nestjs/common';
import { ArticleController, parsePagination } from '../../../server/modules/article/article.controller';

describe('parsePagination', () => {
  it('uses safe defaults for omitted parameters', () => {
    expect(parsePagination()).toEqual({ page: 1, pageSize: 20 });
  });

  it('accepts positive values within the endpoint limits', () => {
    expect(parsePagination('2', '100')).toEqual({ page: 2, pageSize: 100 });
  });

  it.each([
    ['0', '20'],
    ['-1', '20'],
    ['1.5', '20'],
    ['1', '0'],
    ['1', '101'],
    ['10001', '20'],
  ])('rejects invalid pagination values (%s, %s)', (page, pageSize) => {
    expect(() => parsePagination(page, pageSize)).toThrow(BadRequestException);
  });
});

describe('ArticleController pagination', () => {
  const service = { getHotArticles: jest.fn() } as any;
  const controller = new ArticleController(service);

  it('does not pass an unbounded page size to the service', async () => {
    await expect(controller.getHotArticles('1', '101')).rejects.toThrow(BadRequestException);
    expect(service.getHotArticles).not.toHaveBeenCalled();
  });
});
