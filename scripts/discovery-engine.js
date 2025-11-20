import axios from 'axios';
import { XMLParser } from 'fast-xml-parser';
import * as cheerio from 'cheerio';
import { URL } from 'url';

const DEFAULT_LIMIT = 50;
const UA =
  'UltraScrape/1.0 (+https://github.com/justfinethanku/Ultra-Scrape; respectful, 1rps default)';

export async function discover(targetUrl, options = {}) {
  const url = validateUrl(targetUrl);
  const limit = options.limit || DEFAULT_LIMIT;
  const html = await fetchText(url);

  // 1) If body is a feed, parse directly
  if (looksLikeFeed(html)) {
    const feed = parseFeed(html, url);
    return buildDiscovery(feed, { source: 'direct-feed', limit });
  }

  // 2) Try to find linked feeds
  const feedLink = findFeedLink(html, url);
  if (feedLink) {
    try {
      const feedHtml = await fetchText(feedLink);
      if (looksLikeFeed(feedHtml)) {
        const feed = parseFeed(feedHtml, feedLink);
        return buildDiscovery(feed, { source: 'linked-feed', limit });
      }
    } catch {
      // fall through to single-page fallback
    }
  }

  // 3) Fallback: treat as single page target
  const meta = extractPageMetadata(html, url);
  return {
    summary: {
      domain: new URL(url).hostname,
      platform: 'generic',
      totalPosts: 1,
      dateRange: { earliest: meta.date || null, latest: meta.date || null },
      discoveryMethod: 'single-page'
    },
    breakdown: {},
    posts: [meta]
  };
}

// ---- helpers ----

function validateUrl(value) {
  try {
    const u = new URL(value);
    if (!['http:', 'https:'].includes(u.protocol)) {
      throw new Error('URL must start with http:// or https://');
    }
    return u.toString();
  } catch (err) {
    throw new Error(`Invalid URL: ${err.message}`);
  }
}

async function fetchText(url) {
  const resp = await axios.get(url, {
    headers: { 'User-Agent': UA },
    timeout: 15000,
    maxRedirects: 5,
    responseType: 'text',
    validateStatus: (s) => s >= 200 && s < 400
  });
  return resp.data;
}

function looksLikeFeed(body) {
  const snippet = (body || '').slice(0, 1000).toLowerCase();
  return snippet.includes('<rss') || snippet.includes('<feed') || snippet.includes('<rdf');
}

function parseFeed(xml, baseUrl) {
  const parser = new XMLParser({ ignoreAttributes: false });
  const parsed = parser.parse(xml);
  // Try RSS
  if (parsed?.rss?.channel?.item) {
    return normalizeRss(parsed.rss.channel.item, baseUrl);
  }
  // Try Atom
  if (parsed?.feed?.entry) {
    return normalizeAtom(parsed.feed.entry, baseUrl);
  }
  return [];
}

function normalizeRss(items, baseUrl) {
  const list = Array.isArray(items) ? items : [items];
  return list.map((item) => {
    const link = item.link?.['#text'] || item.link || '';
    return {
      url: resolveUrl(link, baseUrl),
      title: safeString(item.title) || '(untitled)',
      date: item.pubDate || item['dc:date'] || null,
      tags: normalizeTags(item.category),
      author: item.author || item['dc:creator'] || null,
      excerpt: item.description ? truncate(item.description) : null
    };
  });
}

function normalizeAtom(entries, baseUrl) {
  const list = Array.isArray(entries) ? entries : [entries];
  return list.map((entry) => {
    const link =
      (Array.isArray(entry.link)
        ? entry.link.find((l) => l['@_href'])?.['@_href']
        : entry.link?.['@_href']) || entry.link || '';
    return {
      url: resolveUrl(link, baseUrl),
      title: safeString(entry.title) || '(untitled)',
      date: entry.updated || entry.published || null,
      tags: normalizeTags(entry.category),
      author: entry.author?.name || null,
      excerpt: entry.summary ? truncate(entry.summary) : null
    };
  });
}

function normalizeTags(value) {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value.map((v) => (typeof v === 'string' ? v : v['@_term'] || v['#text'])).filter(Boolean);
  }
  if (typeof value === 'string') return [value];
  return [];
}

function findFeedLink(html, baseUrl) {
  const $ = cheerio.load(html || '');
  const candidates = $('link[type="application/rss+xml"], link[type="application/atom+xml"]');
  if (candidates.length === 0) return null;
  const href = candidates.first().attr('href');
  return href ? resolveUrl(href, baseUrl) : null;
}

function extractPageMetadata(html, url) {
  const $ = cheerio.load(html || '');
  const title =
    $('meta[property="og:title"]').attr('content') ||
    $('title').text() ||
    '(untitled)';
  const date =
    $('meta[property="article:published_time"]').attr('content') ||
    $('time').attr('datetime') ||
    null;
  const tags = $('meta[property="article:tag"]')
    .map((_, el) => $(el).attr('content'))
    .get()
    .filter(Boolean);
  const excerpt =
    $('meta[name="description"]').attr('content') ||
    $('meta[property="og:description"]').attr('content') ||
    null;
  return { url, title: safeString(title), date, tags, excerpt, author: null };
}

function resolveUrl(possiblyRelative, baseUrl) {
  try {
    return new URL(possiblyRelative, baseUrl).toString();
  } catch {
    return possiblyRelative || '';
  }
}

function truncate(str, len = 240) {
  if (!str) return null;
  const clean = str.replace(/[ \\t\\n\\r]+/g, ' ').trim();
  return clean.length > len ? `${clean.slice(0, len)}…` : clean;
}

function safeString(value) {
  if (!value) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'object' && value['#text']) return String(value['#text']).trim();
  return String(value).trim();
}

function buildDiscovery(items, { source, limit }) {
  const limited = items.filter((p) => p.url).slice(0, limit || DEFAULT_LIMIT);
  const dates = limited.map((p) => (p.date ? new Date(p.date) : null)).filter((d) => d && !isNaN(d));
  const earliest = dates.length ? new Date(Math.min(...dates)).toISOString() : null;
  const latest = dates.length ? new Date(Math.max(...dates)).toISOString() : null;
  const byYear = limited.reduce((acc, post) => {
    if (!post.date) return acc;
    const y = new Date(post.date).getFullYear();
    if (!isNaN(y)) acc[y] = (acc[y] || 0) + 1;
    return acc;
  }, {});
  const domain = limited[0]?.url ? new URL(limited[0].url).hostname : null;
  return {
    summary: {
      domain,
      platform: 'generic',
      totalPosts: limited.length,
      dateRange: { earliest, latest },
      discoveryMethod: source
    },
    breakdown: { byYear },
    posts: limited
  };
}

function parseArgs(argv) {
  const [, , url, ...rest] = argv;
  const opts = { limit: DEFAULT_LIMIT };
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === '--limit') {
      opts.limit = parseInt(rest[i + 1], 10) || DEFAULT_LIMIT;
      i++;
    }
  }
  return { url, options: opts };
}

async function main() {
  try {
    const { url, options } = parseArgs(process.argv);
    if (!url) {
      console.error('ERROR: URL is required');
      process.exit(1);
    }
    const result = await discover(url, options);
    process.stdout.write(JSON.stringify(result, null, 2));
  } catch (err) {
    console.error(`ERROR: ${err.message}`);
    process.exit(1);
  }
}

if (process.argv[1] && process.argv[1].endsWith('discovery-engine.js')) {
  // Run only when executed directly
  main();
}
