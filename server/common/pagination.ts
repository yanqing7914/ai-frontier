import { BadRequestException } from '@nestjs/common';

export const DEFAULT_PAGE = 1;
export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE = 10_000;
export const MAX_PAGE_SIZE = 100;

export function parsePagination(page?: string, pageSize?: string): { page: number; pageSize: number } {
  return {
    page: parsePositiveInteger(page, DEFAULT_PAGE, MAX_PAGE, 'page'),
    pageSize: parsePositiveInteger(pageSize, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, 'pageSize'),
  };
}

function parsePositiveInteger(value: string | undefined, fallback: number, max: number, name: string): number {
  if (value === undefined || value === '') return fallback;
  if (!/^\d+$/.test(value)) {
    throw new BadRequestException(`${name} must be a positive integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > max) {
    throw new BadRequestException(`${name} must be between 1 and ${max}`);
  }
  return parsed;
}
