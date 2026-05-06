/**
 * Firecrawl Tools Integration for MCP STREAMABLE_HTTP / stdio / SSE
 *
 * - Built against @mendable/firecrawl-js v4.x (default export `Firecrawl`).
 * - Adds zod-based runtime validation for every tool.
 * - Routes deepResearch / generateLLMsText through `client.v1.*` (v1 surface,
 *   still feature-complete on self-hosted Firecrawl).
 * - firecrawl_crawl_params_preview uses raw fetch — the v2 SDK does not expose it.
 * - firecrawl_parse uses SDK 4.x `client.parse(file, options)` natively.
 */

import Firecrawl from '@mendable/firecrawl-js';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z, ZodError, ZodTypeAny } from 'zod';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const CONFIG = {
  retry: {
    maxAttempts: Number(process.env.FIRECRAWL_RETRY_MAX_ATTEMPTS) || 3,
    initialDelay: Number(process.env.FIRECRAWL_RETRY_INITIAL_DELAY) || 1000,
    maxDelay: Number(process.env.FIRECRAWL_RETRY_MAX_DELAY) || 10000,
    backoffFactor: Number(process.env.FIRECRAWL_RETRY_BACKOFF_FACTOR) || 2,
  },
  credit: {
    warningThreshold:
      Number(process.env.FIRECRAWL_CREDIT_WARNING_THRESHOLD) || 1000,
    criticalThreshold:
      Number(process.env.FIRECRAWL_CREDIT_CRITICAL_THRESHOLD) || 100,
  },
};

const ORIGIN = 'mcp-mocha';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withRetry<T>(
  operation: () => Promise<T>,
  context: string,
  attempt = 1
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    const isRateLimit =
      error instanceof Error &&
      (error.message.includes('rate limit') || error.message.includes('429'));

    if (isRateLimit && attempt < CONFIG.retry.maxAttempts) {
      const delayMs = Math.min(
        CONFIG.retry.initialDelay *
          Math.pow(CONFIG.retry.backoffFactor, attempt - 1),
        CONFIG.retry.maxDelay
      );

      console.log(
        `Rate limit hit for ${context}. Attempt ${attempt}/${CONFIG.retry.maxAttempts}. Retrying in ${delayMs}ms`
      );

      await delay(delayMs);
      return withRetry(operation, context, attempt + 1);
    }

    throw error;
  }
}

// ---------------------------------------------------------------------------
// Helpers (ported from upstream firecrawl/firecrawl-mcp-server)
// ---------------------------------------------------------------------------

export function removeEmptyTopLevel<T extends Record<string, any>>(
  obj: T
): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v == null) continue;
    if (typeof v === 'string' && v.trim() === '') continue;
    if (Array.isArray(v) && v.length === 0) continue;
    if (
      typeof v === 'object' &&
      !Array.isArray(v) &&
      Object.keys(v).length === 0
    )
      continue;
    // @ts-expect-error dynamic assignment
    out[k] = v;
  }
  return out;
}

/**
 * Expand `formats` from string form (with sibling option objects) into the
 * object form the v4 API expects. If items are already objects, pass through.
 */
export function buildFormatsArray(
  args: Record<string, unknown>
): unknown[] | undefined {
  const formats = args.formats as unknown[] | undefined;
  if (!formats || formats.length === 0) return undefined;

  const result: unknown[] = [];
  for (const fmt of formats) {
    if (typeof fmt !== 'string') {
      result.push(fmt);
      continue;
    }
    if (fmt === 'json') {
      const jsonOpts = args.jsonOptions as Record<string, unknown> | undefined;
      result.push({ type: 'json', ...(jsonOpts ?? {}) });
    } else if (fmt === 'query') {
      const queryOpts = args.queryOptions as
        | Record<string, unknown>
        | undefined;
      result.push({ type: 'query', ...(queryOpts ?? {}) });
    } else if (fmt === 'screenshot' && args.screenshotOptions) {
      const ssOpts = args.screenshotOptions as Record<string, unknown>;
      result.push({ type: 'screenshot', ...ssOpts });
    } else {
      result.push(fmt);
    }
  }
  return result;
}

/** Expand `parsers: ['pdf']` into `[{ type: 'pdf', ...pdfOptions }]`. */
export function buildParsersArray(
  args: Record<string, unknown>
): unknown[] | undefined {
  const parsers = args.parsers as unknown[] | undefined;
  if (!parsers || parsers.length === 0) return undefined;

  const result: unknown[] = [];
  for (const p of parsers) {
    if (p === 'pdf' && args.pdfOptions) {
      const pdfOpts = args.pdfOptions as Record<string, unknown>;
      result.push({ type: 'pdf', ...pdfOpts });
    } else {
      result.push(p);
    }
  }
  return result;
}

export function buildWebhook(
  args: Record<string, unknown>
): string | Record<string, unknown> | undefined {
  const webhook = args.webhook;
  if (!webhook) return undefined;
  if (typeof webhook === 'object') return webhook as Record<string, unknown>;
  if (typeof webhook !== 'string') return undefined;

  const headers = args.webhookHeaders as Record<string, string> | undefined;
  if (headers && Object.keys(headers).length > 0) {
    return { url: webhook, headers };
  }
  return webhook;
}

/** Apply formats/parsers/webhook expansions, drop the sibling option keys. */
export function transformScrapeParams(
  args: Record<string, unknown>
): Record<string, unknown> {
  const out = { ...args };

  const formats = buildFormatsArray(out);
  if (formats) out.formats = formats;

  const parsers = buildParsersArray(out);
  if (parsers) out.parsers = parsers;

  delete out.jsonOptions;
  delete out.queryOptions;
  delete out.screenshotOptions;
  delete out.pdfOptions;

  return out;
}

/** Translate includeDomains/excludeDomains into Google-style site: operators. */
export function buildSearchQueryWithDomains(
  query: string,
  includeDomains?: string[],
  excludeDomains?: string[]
): string {
  if (includeDomains?.length) {
    return `${query} (${includeDomains
      .map((domain) => `site:${domain}`)
      .join(' OR ')})`;
  }
  if (excludeDomains?.length) {
    return `${query} ${excludeDomains
      .map((domain) => `-site:${domain}`)
      .join(' ')}`;
  }
  return query;
}

// ---------------------------------------------------------------------------
// Zod schemas (runtime validation for every tool)
// ---------------------------------------------------------------------------

const formatItemSchema = z.union([
  z.enum([
    'markdown',
    'html',
    'rawHtml',
    'links',
    'images',
    'screenshot',
    'summary',
    'json',
    'attributes',
    'branding',
    'audio',
    'changeTracking',
    'query',
  ]),
  z.record(z.string(), z.any()),
]);

const parserItemSchema = z.union([z.literal('pdf'), z.record(z.string(), z.any())]);

const actionSchema = z.object({
  type: z.enum([
    'wait',
    'click',
    'screenshot',
    'write',
    'press',
    'scroll',
    'scrape',
    'executeJavascript',
    'pdf',
  ]),
  selector: z.string().optional(),
  milliseconds: z.number().optional(),
  text: z.string().optional(),
  key: z.string().optional(),
  direction: z.enum(['up', 'down']).optional(),
  script: z.string().optional(),
  fullPage: z.boolean().optional(),
});

const locationSchema = z.object({
  country: z.string().optional(),
  languages: z.array(z.string()).optional(),
});

const screenshotOptionsSchema = z.object({
  fullPage: z.boolean().optional(),
  quality: z.number().optional(),
  viewport: z
    .object({ width: z.number(), height: z.number() })
    .optional(),
});

const pdfOptionsSchema = z.object({
  maxPages: z.number().int().min(1).max(10000).optional(),
});

const jsonOptionsSchema = z.object({
  prompt: z.string().optional(),
  schema: z.record(z.string(), z.any()).optional(),
});

const queryOptionsSchema = z.object({
  prompt: z.string().max(10000),
  mode: z.enum(['directQuote', 'freeform']).optional(),
});

const scrapeOptionsBaseSchema = z.object({
  formats: z.array(formatItemSchema).optional(),
  jsonOptions: jsonOptionsSchema.optional(),
  queryOptions: queryOptionsSchema.optional(),
  screenshotOptions: screenshotOptionsSchema.optional(),
  parsers: z.array(parserItemSchema).optional(),
  pdfOptions: pdfOptionsSchema.optional(),
  onlyMainContent: z.boolean().optional(),
  includeTags: z.array(z.string()).optional(),
  excludeTags: z.array(z.string()).optional(),
  waitFor: z.number().optional(),
  timeout: z.number().optional(),
  actions: z.array(actionSchema).optional(),
  mobile: z.boolean().optional(),
  skipTlsVerification: z.boolean().optional(),
  removeBase64Images: z.boolean().optional(),
  blockAds: z.boolean().optional(),
  location: locationSchema.optional(),
  storeInCache: z.boolean().optional(),
  zeroDataRetention: z.boolean().optional(),
  maxAge: z.number().optional(),
  proxy: z.union([
    z.enum(['basic', 'stealth', 'enhanced', 'auto']),
    z.string(),
  ]).optional(),
  lockdown: z.boolean().optional(),
  profile: z
    .object({ name: z.string(), saveChanges: z.boolean().optional() })
    .optional(),
});

export const scrapeParamsSchema = scrapeOptionsBaseSchema.extend({
  url: z.string().url(),
});

export const mapParamsSchema = z.object({
  url: z.string().url(),
  search: z.string().optional(),
  sitemap: z.enum(['include', 'skip', 'only']).optional(),
  includeSubdomains: z.boolean().optional(),
  ignoreQueryParameters: z.boolean().optional(),
  limit: z.number().optional(),
});

export const crawlParamsSchema = z.object({
  url: z.string().url(),
  prompt: z.string().optional(),
  excludePaths: z.array(z.string()).optional(),
  includePaths: z.array(z.string()).optional(),
  maxDiscoveryDepth: z.number().optional(),
  crawlEntireDomain: z.boolean().optional(),
  allowSubdomains: z.boolean().optional(),
  sitemap: z.enum(['include', 'skip', 'only']).optional(),
  limit: z.number().optional(),
  delay: z.number().optional(),
  maxConcurrency: z.number().optional(),
  allowExternalLinks: z.boolean().optional(),
  deduplicateSimilarURLs: z.boolean().optional(),
  ignoreQueryParameters: z.boolean().optional(),
  webhook: z
    .union([
      z.string(),
      z.object({ url: z.string(), headers: z.record(z.string(), z.string()).optional() }),
    ])
    .optional(),
  webhookHeaders: z.record(z.string(), z.string()).optional(),
  scrapeOptions: scrapeOptionsBaseSchema.optional(),
});

export const statusCheckSchema = z.object({ id: z.string() });

export const crawlParamsPreviewSchema = z.object({
  url: z.string().url(),
  prompt: z.string(),
});

export const searchParamsSchema = z.object({
  query: z.string().min(1),
  sources: z
    .array(
      z.union([
        z.enum(['web', 'images', 'news']),
        z.object({ type: z.enum(['web', 'images', 'news']) }),
      ])
    )
    .optional(),
  limit: z.number().optional(),
  lang: z.string().optional(),
  country: z.string().optional(),
  tbs: z.string().optional(),
  filter: z.string().optional(),
  location: z
    .union([
      z.string(),
      locationSchema,
    ])
    .optional(),
  includeDomains: z.array(z.string()).optional(),
  excludeDomains: z.array(z.string()).optional(),
  scrapeOptions: scrapeOptionsBaseSchema.optional(),
});

export const extractParamsSchema = z.object({
  urls: z.array(z.string()).min(1),
  prompt: z.string().optional(),
  systemPrompt: z.string().optional(),
  schema: z.record(z.string(), z.any()).optional(),
  allowExternalLinks: z.boolean().optional(),
  enableWebSearch: z.boolean().optional(),
  includeSubdomains: z.boolean().optional(),
});

export const batchScrapeSchema = z.object({
  urls: z.array(z.string()).min(1).max(1000),
  scrapeOptions: scrapeOptionsBaseSchema.optional(),
});

export const deepResearchSchema = z.object({
  query: z.string().min(1),
  maxDepth: z.number().optional(),
  timeLimit: z.number().optional(),
  maxUrls: z.number().optional(),
});

export const generateLLMsTxtSchema = z.object({
  url: z.string().url(),
  maxUrls: z.number().optional(),
  showFullText: z.boolean().optional(),
});

const PARSE_FORMATS = [
  'markdown',
  'html',
  'rawHtml',
  'links',
  'summary',
  'json',
  'query',
] as const;

export const parseParamsSchema = z.object({
  filePath: z.string().min(1),
  contentType: z.string().optional(),
  formats: z
    .array(
      z.union([z.enum(PARSE_FORMATS), z.record(z.string(), z.any())])
    )
    .optional(),
  jsonOptions: jsonOptionsSchema.optional(),
  queryOptions: queryOptionsSchema.optional(),
  parsers: z.array(parserItemSchema).optional(),
  pdfOptions: pdfOptionsSchema.optional(),
  onlyMainContent: z.boolean().optional(),
  includeTags: z.array(z.string()).optional(),
  excludeTags: z.array(z.string()).optional(),
  removeBase64Images: z.boolean().optional(),
  skipTlsVerification: z.boolean().optional(),
  storeInCache: z.boolean().optional(),
  zeroDataRetention: z.boolean().optional(),
  maxAge: z.number().optional(),
  proxy: z.enum(['basic', 'auto']).optional(),
});

function parseArgs<S extends ZodTypeAny>(
  schema: S,
  args: unknown,
  toolName: string
): z.infer<S> {
  const result = schema.safeParse(args);
  if (!result.success) {
    const errs = (result.error as ZodError).issues
      .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('; ');
    throw new Error(`Invalid arguments for ${toolName}: ${errs}`);
  }
  return result.data;
}

// ---------------------------------------------------------------------------
// Content type inference for firecrawl_parse
// ---------------------------------------------------------------------------

const EXTENSION_CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.htm': 'text/html',
  '.xhtml': 'application/xhtml+xml',
  '.pdf': 'application/pdf',
  '.docx':
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.doc': 'application/msword',
  '.odt': 'application/vnd.oasis.opendocument.text',
  '.rtf': 'application/rtf',
  '.xlsx':
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xls': 'application/vnd.ms-excel',
};

function inferContentType(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  return EXTENSION_CONTENT_TYPES[ext] ?? 'application/octet-stream';
}

// ---------------------------------------------------------------------------
// FirecrawlToolsIntegration
// ---------------------------------------------------------------------------

export class FirecrawlToolsIntegration {
  private client: Firecrawl;
  private apiUrl: string | undefined;
  private apiKey: string | undefined;

  constructor() {
    this.apiUrl = process.env.FIRECRAWL_API_URL;
    this.apiKey = process.env.FIRECRAWL_API_KEY;

    this.client = new Firecrawl({
      ...(this.apiKey ? { apiKey: this.apiKey } : {}),
      ...(this.apiUrl ? { apiUrl: this.apiUrl } : {}),
    } as any);

    console.log('Firecrawl Tools Integration initialized:', {
      apiUrl: this.apiUrl || 'default',
      hasApiKey: !!this.apiKey,
    });
  }

  async executeToolCall(toolName: string, args: any): Promise<any> {
    const startTime = Date.now();
    console.log(
      `[${new Date().toISOString()}] Executing tool: ${toolName}`
    );

    try {
      let data: any;
      switch (toolName) {
        case 'firecrawl_scrape':
          data = await this.handleScrape(args);
          break;
        case 'firecrawl_map':
          data = await this.handleMap(args);
          break;
        case 'firecrawl_crawl':
          data = await this.handleCrawl(args);
          break;
        case 'firecrawl_check_crawl_status':
          data = await this.handleCheckCrawlStatus(args);
          break;
        case 'firecrawl_crawl_params_preview':
          data = await this.handleCrawlParamsPreview(args);
          break;
        case 'firecrawl_batch_scrape':
          data = await this.handleBatchScrape(args);
          break;
        case 'firecrawl_check_batch_status':
          data = await this.handleCheckBatchStatus(args);
          break;
        case 'firecrawl_search':
          data = await this.handleSearch(args);
          break;
        case 'firecrawl_extract':
          data = await this.handleExtract(args);
          break;
        case 'firecrawl_deep_research':
          data = await this.handleDeepResearch(args);
          break;
        case 'firecrawl_generate_llmstxt':
          data = await this.handleGenerateLLMsText(args);
          break;
        case 'firecrawl_parse':
          data = await this.handleParse(args);
          break;
        default:
          throw new Error(`Unknown tool: ${toolName}`);
      }

      const duration = Date.now() - startTime;
      console.log(`Tool ${toolName} completed in ${duration}ms`);

      return {
        success: true,
        data,
        executionTime: duration,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      const duration = Date.now() - startTime;
      console.error(`Tool ${toolName} failed after ${duration}ms:`, error);
      return {
        success: false,
        error: {
          message: error instanceof Error ? error.message : 'Unknown error',
          code: 'TOOL_EXECUTION_ERROR',
          tool: toolName,
          executionTime: duration,
        },
        timestamp: new Date().toISOString(),
      };
    }
  }

  // -------------------------------------------------------------------------
  // Handlers
  // -------------------------------------------------------------------------

  private async handleScrape(args: unknown): Promise<any> {
    const parsed = parseArgs(scrapeParamsSchema, args, 'firecrawl_scrape');
    const { url, ...options } = parsed;

    return withRetry(async () => {
      const transformed = transformScrapeParams(
        options as Record<string, unknown>
      );
      const cleaned = removeEmptyTopLevel(transformed);
      const res = await this.client.scrape(url, {
        ...cleaned,
        origin: ORIGIN,
      } as any);
      return res;
    }, `scrape ${url}`);
  }

  private async handleMap(args: unknown): Promise<any> {
    const parsed = parseArgs(mapParamsSchema, args, 'firecrawl_map');
    const { url, ...options } = parsed;

    return withRetry(async () => {
      const cleaned = removeEmptyTopLevel(options as Record<string, unknown>);
      const res = await this.client.map(url, {
        ...cleaned,
        origin: ORIGIN,
      } as any);
      return res;
    }, `map ${url}`);
  }

  private async handleCrawl(args: unknown): Promise<any> {
    const parsed = parseArgs(crawlParamsSchema, args, 'firecrawl_crawl');
    const { url, ...rest } = parsed;
    const opts = { ...rest } as Record<string, unknown>;

    if (opts.scrapeOptions) {
      opts.scrapeOptions = transformScrapeParams(
        opts.scrapeOptions as Record<string, unknown>
      );
    }

    const webhook = buildWebhook(opts);
    if (webhook) opts.webhook = webhook;
    delete opts.webhookHeaders;

    return withRetry(async () => {
      const cleaned = removeEmptyTopLevel(opts);
      const res = await this.client.startCrawl(url, {
        ...cleaned,
        origin: ORIGIN,
      } as any);
      return res;
    }, `crawl ${url}`);
  }

  private async handleCheckCrawlStatus(args: unknown): Promise<any> {
    const { id } = parseArgs(
      statusCheckSchema,
      args,
      'firecrawl_check_crawl_status'
    );
    return withRetry(
      () => this.client.getCrawlStatus(id),
      `crawl status ${id}`
    );
  }

  private async handleCrawlParamsPreview(args: unknown): Promise<any> {
    const { url, prompt } = parseArgs(
      crawlParamsPreviewSchema,
      args,
      'firecrawl_crawl_params_preview'
    );
    const apiUrl = (this.apiUrl || 'https://api.firecrawl.dev').replace(
      /\/$/,
      ''
    );
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.apiKey) headers['Authorization'] = `Bearer ${this.apiKey}`;

    return withRetry(async () => {
      const response = await fetch(`${apiUrl}/v2/crawl/params-preview`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ url, prompt, origin: ORIGIN }),
      });
      const text = await response.text();
      if (!response.ok) {
        throw new Error(
          `crawl/params-preview failed (${response.status}): ${text}`
        );
      }
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    }, `crawl-params-preview ${url}`);
  }

  private async handleBatchScrape(args: unknown): Promise<any> {
    const parsed = parseArgs(
      batchScrapeSchema,
      args,
      'firecrawl_batch_scrape'
    );
    const { urls, scrapeOptions } = parsed;

    const opts: Record<string, unknown> = {};
    if (scrapeOptions) {
      const transformed = transformScrapeParams(
        scrapeOptions as Record<string, unknown>
      );
      Object.assign(opts, removeEmptyTopLevel(transformed));
    }

    return withRetry(async () => {
      // batchScrape with `pollWaitUntil: false` returns the job id immediately
      // (kept default to keep it async — firecrawl-js v4 default behaviour
      //  differs by version, so we explicitly mirror upstream by passing the
      //  options object the SDK accepts).
      const res = await (this.client as any).batchScrape(urls, {
        ...opts,
        origin: ORIGIN,
        pollWaitUntil: false,
      });
      return res;
    }, `batch-scrape ${urls.length} urls`);
  }

  private async handleCheckBatchStatus(args: unknown): Promise<any> {
    const { id } = parseArgs(
      statusCheckSchema,
      args,
      'firecrawl_check_batch_status'
    );
    return withRetry(
      () => (this.client as any).getBatchScrapeStatus(id),
      `batch status ${id}`
    );
  }

  private async handleSearch(args: unknown): Promise<any> {
    const parsed = parseArgs(searchParamsSchema, args, 'firecrawl_search');
    const {
      query,
      includeDomains,
      excludeDomains,
      scrapeOptions,
      sources,
      ...rest
    } = parsed;

    const opts: Record<string, unknown> = { ...rest };

    if (sources) {
      opts.sources = sources.map((s) =>
        typeof s === 'string' ? { type: s } : s
      );
    }

    if (scrapeOptions) {
      opts.scrapeOptions = transformScrapeParams(
        scrapeOptions as Record<string, unknown>
      );
    }

    const cleaned = removeEmptyTopLevel(opts);
    const finalQuery = buildSearchQueryWithDomains(
      query,
      includeDomains,
      excludeDomains
    );

    return withRetry(async () => {
      const res = await this.client.search(finalQuery, {
        ...(cleaned as any),
        origin: ORIGIN,
      });
      return res;
    }, `search ${finalQuery}`);
  }

  private async handleExtract(args: unknown): Promise<any> {
    const parsed = parseArgs(extractParamsSchema, args, 'firecrawl_extract');

    return withRetry(async () => {
      const body = removeEmptyTopLevel({
        urls: parsed.urls,
        prompt: parsed.prompt,
        systemPrompt: parsed.systemPrompt,
        schema: parsed.schema,
        allowExternalLinks: parsed.allowExternalLinks,
        enableWebSearch: parsed.enableWebSearch,
        includeSubdomains: parsed.includeSubdomains,
        origin: ORIGIN,
      });
      const res = await this.client.extract(body as any);
      return res;
    }, `extract ${parsed.urls.length} urls`);
  }

  private async handleDeepResearch(args: unknown): Promise<any> {
    const parsed = parseArgs(
      deepResearchSchema,
      args,
      'firecrawl_deep_research'
    );
    const v1 = (this.client as any).v1;
    if (!v1 || typeof v1.deepResearch !== 'function') {
      throw new Error(
        'deepResearch is unavailable: SDK does not expose client.v1.deepResearch.'
      );
    }
    const params = removeEmptyTopLevel({
      maxDepth: parsed.maxDepth,
      timeLimit: parsed.timeLimit,
      maxUrls: parsed.maxUrls,
    });
    return withRetry(
      () => v1.deepResearch(parsed.query, params as any),
      `deep research ${parsed.query}`
    );
  }

  private async handleGenerateLLMsText(args: unknown): Promise<any> {
    const parsed = parseArgs(
      generateLLMsTxtSchema,
      args,
      'firecrawl_generate_llmstxt'
    );
    const v1 = (this.client as any).v1;
    if (!v1 || typeof v1.generateLLMsText !== 'function') {
      throw new Error(
        'generateLLMsText is unavailable: SDK does not expose client.v1.generateLLMsText.'
      );
    }
    const params = removeEmptyTopLevel({
      maxUrls: parsed.maxUrls,
      showFullText: parsed.showFullText,
    });
    return withRetry(
      () => v1.generateLLMsText(parsed.url, params as any),
      `generate-llmstxt ${parsed.url}`
    );
  }

  private async handleParse(args: unknown): Promise<any> {
    if (!this.apiUrl) {
      throw new Error(
        'firecrawl_parse requires FIRECRAWL_API_URL to be set to a self-hosted Firecrawl API instance.'
      );
    }
    const parsed = parseArgs(parseParamsSchema, args, 'firecrawl_parse');
    const { filePath, contentType: overrideContentType, ...options } = parsed;

    const absPath = path.resolve(filePath);
    const buffer = await readFile(absPath);
    const filename = path.basename(absPath);
    const fileContentType =
      overrideContentType && overrideContentType.length > 0
        ? overrideContentType
        : inferContentType(filename);

    const transformed = transformScrapeParams(
      options as Record<string, unknown>
    );
    const cleaned = removeEmptyTopLevel(transformed);

    return withRetry(async () => {
      const res = await (this.client as any).parse(
        {
          data: buffer,
          filename,
          contentType: fileContentType,
        },
        {
          ...cleaned,
          origin: ORIGIN,
        }
      );
      return res;
    }, `parse ${filename}`);
  }
}
