export interface ParsedItem {
  title: string;
  url: string;
  canonicalUrl?: string;
  publishedAt: Date | null;
  content: string;
  rawContent: string;
}

export interface ParseResult {
  items: ParsedItem[];
  error?: string;
}

export interface FeedSourceInput {
  id: string;
  name: string;
  url: string;
  feedType: string;
  tier: string;
}
