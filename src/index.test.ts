import {
  describe,
  expect,
  jest,
  test,
  beforeEach,
  afterEach,
  beforeAll,
} from '@jest/globals';
import { writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// ESM mock — must be set up BEFORE any dynamic import of code that pulls in
// '@mendable/firecrawl-js'.
const fc = {
  scrape: jest.fn(),
  map: jest.fn(),
  search: jest.fn(),
  startCrawl: jest.fn(),
  getCrawlStatus: jest.fn(),
  crawl: jest.fn(),
  batchScrape: jest.fn(),
  getBatchScrapeStatus: jest.fn(),
  extract: jest.fn(),
  parse: jest.fn(),
  deepResearch: jest.fn(),
  generateLLMsText: jest.fn(),
};

jest.unstable_mockModule('@mendable/firecrawl-js', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    scrape: fc.scrape,
    map: fc.map,
    search: fc.search,
    startCrawl: fc.startCrawl,
    getCrawlStatus: fc.getCrawlStatus,
    crawl: fc.crawl,
    batchScrape: fc.batchScrape,
    getBatchScrapeStatus: fc.getBatchScrapeStatus,
    extract: fc.extract,
    parse: fc.parse,
    v1: {
      deepResearch: fc.deepResearch,
      generateLLMsText: fc.generateLLMsText,
    },
  })),
}));

const { FirecrawlToolsIntegration } = await import(
  './firecrawl-tools-integration.js'
);

describe('FirecrawlToolsIntegration', () => {
  let integration: InstanceType<typeof FirecrawlToolsIntegration>;

  beforeAll(() => {
    process.env.FIRECRAWL_API_KEY = 'test-key';
    process.env.FIRECRAWL_API_URL = 'http://localhost:3002';
  });

  beforeEach(() => {
    Object.values(fc).forEach((m) => m.mockReset());
    integration = new FirecrawlToolsIntegration();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // --- scrape ---------------------------------------------------------------

  test('firecrawl_scrape passes basic args through', async () => {
    fc.scrape.mockResolvedValueOnce({ markdown: '# Hi', metadata: {} } as never);

    const res = await integration.executeToolCall('firecrawl_scrape', {
      url: 'https://example.com',
      formats: ['markdown'],
      maxAge: 3600000,
    });

    expect(res.success).toBe(true);
    expect(fc.scrape).toHaveBeenCalledTimes(1);
    const [url, options] = fc.scrape.mock.calls[0] as [string, any];
    expect(url).toBe('https://example.com');
    expect(options.formats).toEqual(['markdown']);
    expect(options.maxAge).toBe(3600000);
    expect(options.origin).toBe('mcp-mocha');
  });

  test('firecrawl_scrape expands string formats with sibling options', async () => {
    fc.scrape.mockResolvedValueOnce({ markdown: '' } as never);

    await integration.executeToolCall('firecrawl_scrape', {
      url: 'https://example.com',
      formats: ['json', 'markdown'],
      jsonOptions: { prompt: 'Extract title', schema: { type: 'object' } },
    });

    const options = fc.scrape.mock.calls[0]![1] as any;
    expect(options.formats).toEqual([
      { type: 'json', prompt: 'Extract title', schema: { type: 'object' } },
      'markdown',
    ]);
    expect(options.jsonOptions).toBeUndefined();
  });

  test('firecrawl_scrape rejects invalid args via zod', async () => {
    const res = await integration.executeToolCall('firecrawl_scrape', {
      url: 'not-a-url',
    });
    expect(res.success).toBe(false);
    expect(res.error.message).toMatch(/Invalid arguments/);
    expect(fc.scrape).not.toHaveBeenCalled();
  });

  test('firecrawl_scrape surfaces SDK errors', async () => {
    fc.scrape.mockRejectedValueOnce(new Error('boom') as never);
    const res = await integration.executeToolCall('firecrawl_scrape', {
      url: 'https://example.com',
    });
    expect(res.success).toBe(false);
    expect(res.error.message).toBe('boom');
  });

  // --- map ------------------------------------------------------------------

  test('firecrawl_map forwards sitemap option', async () => {
    fc.map.mockResolvedValueOnce({ links: [] } as never);
    await integration.executeToolCall('firecrawl_map', {
      url: 'https://example.com',
      sitemap: 'only',
      includeSubdomains: true,
    });
    const [, options] = fc.map.mock.calls[0] as [string, any];
    expect(options.sitemap).toBe('only');
    expect(options.includeSubdomains).toBe(true);
  });

  // --- crawl ----------------------------------------------------------------

  test('firecrawl_crawl uses startCrawl and forwards v2 params', async () => {
    fc.startCrawl.mockResolvedValueOnce({ id: 'job-123' } as never);
    await integration.executeToolCall('firecrawl_crawl', {
      url: 'https://example.com',
      prompt: 'docs only',
      maxDiscoveryDepth: 3,
      crawlEntireDomain: true,
      sitemap: 'include',
      delay: 200,
      maxConcurrency: 4,
      scrapeOptions: { formats: ['markdown'], onlyMainContent: true },
    });
    const [url, options] = fc.startCrawl.mock.calls[0] as [string, any];
    expect(url).toBe('https://example.com');
    expect(options.prompt).toBe('docs only');
    expect(options.maxDiscoveryDepth).toBe(3);
    expect(options.crawlEntireDomain).toBe(true);
    expect(options.sitemap).toBe('include');
    expect(options.delay).toBe(200);
    expect(options.maxConcurrency).toBe(4);
    expect(options.scrapeOptions.formats).toEqual(['markdown']);
  });

  test('firecrawl_check_crawl_status calls getCrawlStatus', async () => {
    fc.getCrawlStatus.mockResolvedValueOnce({ status: 'completed' } as never);
    const res = await integration.executeToolCall(
      'firecrawl_check_crawl_status',
      { id: 'job-1' }
    );
    expect(res.success).toBe(true);
    expect(fc.getCrawlStatus).toHaveBeenCalledWith('job-1');
  });

  // --- batch ----------------------------------------------------------------

  test('firecrawl_batch_scrape returns job id', async () => {
    fc.batchScrape.mockResolvedValueOnce({ id: 'batch-1' } as never);
    const res = await integration.executeToolCall('firecrawl_batch_scrape', {
      urls: ['https://a.com', 'https://b.com'],
      scrapeOptions: { formats: ['markdown'] },
    });
    expect(res.success).toBe(true);
    expect(res.data.id).toBe('batch-1');
    const [urls, options] = fc.batchScrape.mock.calls[0] as [string[], any];
    expect(urls).toEqual(['https://a.com', 'https://b.com']);
    expect(options.formats).toEqual(['markdown']);
    expect(options.pollWaitUntil).toBe(false);
  });

  test('firecrawl_check_batch_status calls getBatchScrapeStatus', async () => {
    fc.getBatchScrapeStatus.mockResolvedValueOnce({
      status: 'completed',
    } as never);
    await integration.executeToolCall('firecrawl_check_batch_status', {
      id: 'batch-1',
    });
    expect(fc.getBatchScrapeStatus).toHaveBeenCalledWith('batch-1');
  });

  // --- crawl_params_preview -------------------------------------------------

  test('firecrawl_crawl_params_preview hits /v2/crawl/params-preview', async () => {
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ derived: { limit: 50 } }), {
          status: 200,
        })
      );

    const res = await integration.executeToolCall(
      'firecrawl_crawl_params_preview',
      { url: 'https://docs.example.com', prompt: 'extract docs' }
    );

    expect(res.success).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [endpoint, init] = fetchMock.mock.calls[0] as [string, any];
    expect(endpoint).toBe('http://localhost:3002/v2/crawl/params-preview');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string);
    expect(body.url).toBe('https://docs.example.com');
    expect(body.prompt).toBe('extract docs');
    fetchMock.mockRestore();
  });

  // --- search ---------------------------------------------------------------

  test('firecrawl_search builds site: operators from includeDomains', async () => {
    fc.search.mockResolvedValueOnce({ data: [] } as never);
    await integration.executeToolCall('firecrawl_search', {
      query: 'hello',
      includeDomains: ['example.com', 'docs.example.com'],
    });
    const [query] = fc.search.mock.calls[0] as [string, any];
    expect(query).toBe('hello (site:example.com OR site:docs.example.com)');
  });

  test('firecrawl_search normalizes string sources to {type}', async () => {
    fc.search.mockResolvedValueOnce({ data: [] } as never);
    await integration.executeToolCall('firecrawl_search', {
      query: 'hello',
      sources: ['web', 'news'],
    });
    const options = fc.search.mock.calls[0]![1] as any;
    expect(options.sources).toEqual([{ type: 'web' }, { type: 'news' }]);
  });

  // --- extract --------------------------------------------------------------

  test('firecrawl_extract forwards advanced flags', async () => {
    fc.extract.mockResolvedValueOnce({ data: {} } as never);
    await integration.executeToolCall('firecrawl_extract', {
      urls: ['https://a.com'],
      prompt: 'pull title',
      enableWebSearch: true,
      includeSubdomains: true,
    });
    const body = fc.extract.mock.calls[0]![0] as any;
    expect(body.urls).toEqual(['https://a.com']);
    expect(body.enableWebSearch).toBe(true);
    expect(body.includeSubdomains).toBe(true);
  });

  // --- deep research / llmstxt (v1 namespace) -------------------------------

  test('firecrawl_deep_research routes through client.v1.deepResearch', async () => {
    fc.deepResearch.mockResolvedValueOnce({
      data: { finalAnalysis: 'ok' },
    } as never);
    await integration.executeToolCall('firecrawl_deep_research', {
      query: 'EVs vs gas',
      maxDepth: 2,
      timeLimit: 60,
      maxUrls: 10,
    });
    expect(fc.deepResearch).toHaveBeenCalledTimes(1);
    const [query, params] = fc.deepResearch.mock.calls[0] as [string, any];
    expect(query).toBe('EVs vs gas');
    expect(params).toEqual({ maxDepth: 2, timeLimit: 60, maxUrls: 10 });
  });

  test('firecrawl_generate_llmstxt routes through client.v1.generateLLMsText', async () => {
    fc.generateLLMsText.mockResolvedValueOnce({
      data: { llmstxt: 'x' },
    } as never);
    await integration.executeToolCall('firecrawl_generate_llmstxt', {
      url: 'https://example.com',
      maxUrls: 20,
      showFullText: true,
    });
    expect(fc.generateLLMsText).toHaveBeenCalledTimes(1);
    const [url, params] = fc.generateLLMsText.mock.calls[0] as [string, any];
    expect(url).toBe('https://example.com');
    expect(params).toEqual({ maxUrls: 20, showFullText: true });
  });

  // --- parse ----------------------------------------------------------------

  test('firecrawl_parse reads file and forwards to SDK parse()', async () => {
    fc.parse.mockResolvedValueOnce({ markdown: '# parsed' } as never);
    const dir = await mkdtemp(path.join(tmpdir(), 'fc-parse-'));
    const file = path.join(dir, 'test.html');
    await writeFile(file, '<html><body>hi</body></html>', 'utf8');

    const res = await integration.executeToolCall('firecrawl_parse', {
      filePath: file,
      formats: ['markdown'],
    });

    expect(res.success).toBe(true);
    expect(fc.parse).toHaveBeenCalledTimes(1);
    const [filePayload, options] = fc.parse.mock.calls[0] as [any, any];
    expect(filePayload.filename).toBe('test.html');
    expect(filePayload.contentType).toBe('text/html');
    expect(Buffer.isBuffer(filePayload.data)).toBe(true);
    expect(options.formats).toEqual(['markdown']);
  });

  test('firecrawl_parse fails fast if FIRECRAWL_API_URL is unset', async () => {
    const oldUrl = process.env.FIRECRAWL_API_URL;
    delete process.env.FIRECRAWL_API_URL;
    integration = new FirecrawlToolsIntegration();
    const res = await integration.executeToolCall('firecrawl_parse', {
      filePath: '/tmp/whatever.pdf',
    });
    expect(res.success).toBe(false);
    expect(res.error.message).toMatch(/FIRECRAWL_API_URL/);
    process.env.FIRECRAWL_API_URL = oldUrl;
  });

  // --- unknown tool ---------------------------------------------------------

  test('unknown tool returns error', async () => {
    const res = await integration.executeToolCall('firecrawl_nope', {});
    expect(res.success).toBe(false);
    expect(res.error.message).toMatch(/Unknown tool/);
  });
});
