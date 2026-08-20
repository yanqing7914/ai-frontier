export interface ParsedItem {
  title: string;
  url: string;
  canonicalUrl?: string;
  publishedAt: Date | null;
  content: string;
  rawContent: string;
  /** The parser's confidence in the body field; empty bodies are not replaced by titles. */
  contentStatus?: 'full' | 'summary' | 'missing';
  originalUrl?: string;
  warnings?: string[];
}

export interface ParseStats {
  input: number;
  parsed: number;
  skipped: number;
}

export interface ParseProvenance {
  sourceUrl?: string;
  finalUrl?: string;
  contentType?: string;
  parserType?: string;
  httpStatus?: number;
}

export interface ParseResult {
  items: ParsedItem[];
  error?: string;
  warnings?: string[];
  stats?: ParseStats;
  provenance?: ParseProvenance;
}

export interface FeedSourceInput {
  id: string;
  name: string;
  url: string;
  feedType: string;
  tier: string;
}
