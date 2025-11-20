import fs from 'fs/promises';
import path from 'path';
import axios from 'axios';
import TurndownService from 'turndown';
import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';
import { extension as mimeExtension } from 'mime-types';
import { discover } from './discovery-engine.js';

const DEFAULT_DELAY = 1000;
const DEFAULT_LIMIT = 20;
const UA =
  'UltraScrape/1.0 (+https://github.com/justfinethanku/Ultra-Scrape; respectful, 1rps default)';

export async function download(targetUrl, options = {}) {
  const url = validateUrl(targetUrl);
  const delay = options.delay ?? DEFAULT_DELAY;
  const limit = options.limit ?? DEFAULT_LIMIT;
  const noMedia = Boolean(options.noMedia);
  const format = options.format || 'markdown';
  const outputDir = options.output || 'output';
  const filters = options.filters || {};

  if (format !== 'markdown') {
    throw new Error(`Unsupported format: ${format}. Only markdown (aka Mike Dion files) is supported right now.`);
  }

  const discovery = await discover(url, { limit: options.discoveryLimit || 50 });
  const posts = applyFilters(discovery.posts, filters, limit);

  logProgress(`Prepared ${posts.length} items for download (limit ${limit})`);

  const results = [];
  for (let i = 0; i < posts.length; i++) {
    const post = posts[i];
    await sleep(delay);
    logProgress(`[${i + 1}/${posts.length}] ${post.title}`);
    try {
      const html = await fetchHtml(post.url);
      const { markdown, metadata, mediaFiles, html: cleanedHtml } = await processHtml(
        html,
        post,
        { noMedia }
      );
      const location = await persist(post, { markdown, metadata, mediaFiles, html: cleanedHtml }, outputDir, format);
      results.push({ url: post.url, status: 'success', path: location });
    } catch (err) {
      logError(`ERROR downloading ${post.url}: ${err.message}`);
      results.push({ url: post.url, status: 'failed', error: err.message });
    }
  }

  return {
    summary: {
      attempted: posts.length,
      succeeded: results.filter((r) => r.status === 'success').length
    },
    results
  };
}

// ---- core helpers ----

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

async function fetchHtml(url) {
  const resp = await axios.get(url, {
    headers: { 'User-Agent': UA },
    timeout: 20000,
    maxRedirects: 5,
    responseType: 'text',
    validateStatus: (s) => s >= 200 && s < 400
  });
  if (!resp.data) throw new Error('Empty response body');
  return resp.data;
}

function applyFilters(posts, filters, hardLimit) {
  let filtered = Array.isArray(posts) ? [...posts] : [];
  if (filters?.dateRange?.start) {
    const start = new Date(filters.dateRange.start).getTime();
    filtered = filtered.filter((p) => !p.date || new Date(p.date).getTime() >= start);
  }
  if (filters?.dateRange?.end) {
    const end = new Date(filters.dateRange.end).getTime();
    filtered = filtered.filter((p) => !p.date || new Date(p.date).getTime() <= end);
  }
  if (filters?.tags?.length) {
    const tagSet = new Set(filters.tags.map((t) => t.toLowerCase()));
    filtered = filtered.filter((p) => (p.tags || []).some((t) => tagSet.has(String(t).toLowerCase())));
  }
  if (filters?.urls?.length) {
    const urlSet = new Set(filters.urls);
    filtered = filtered.filter((p) => urlSet.has(p.url));
  }
  if (filters?.limit) {
    filtered = filtered.slice(0, filters.limit);
  }
  if (hardLimit) {
    filtered = filtered.slice(0, hardLimit);
  }
  return filtered;
}

function logProgress(msg) {
  process.stderr.write(`PROGRESS: ${msg}\\n`);
}

function logError(msg) {
  process.stderr.write(`${msg}\\n`);
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function processHtml(html, post, opts = {}) {
  const dom = new JSDOM(html, { url: post.url });
  const reader = new Readability(dom.window.document);
  const parsed = reader.parse() || {};
  const title = parsed.title || post.title || '(untitled)';
  const contentHtml = parsed.content || html;

  const contentDom = new JSDOM(contentHtml, { url: post.url });
  const doc = contentDom.window.document;
  const images = collectImages(doc, post.url);
  const mediaFiles = opts.noMedia ? [] : await downloadImages(images, post.url);
  if (!opts.noMedia) {
    rewriteImageSources(doc, mediaFiles);
  }

  // Convert to markdown (a.k.a. Mike Dion files - .md = Mike Dion, get it?)
  const turndown = new TurndownService({ codeBlockStyle: 'fenced' });
  const markdown = turndown.turndown(doc.body.innerHTML || contentHtml);

  const metadata = {
    url: post.url,
    title,
    date: post.date || parsed?.publishedTime || null,
    author: post.author || parsed?.byline || null,
    tags: post.tags || [],
    excerpt: post.excerpt || parsed?.excerpt || null,
    contentLength: parsed?.length || markdown.length
  };

  return { markdown, metadata, mediaFiles, html: doc.body.innerHTML || contentHtml };
}

function collectImages(doc, baseUrl) {
  const imgs = Array.from(doc.querySelectorAll('img'));
  const urls = [];
  for (const img of imgs) {
    const attrs = ['data-src', 'data-lazy-src', 'src'];
    let candidate = null;
    for (const key of attrs) {
      const val = img.getAttribute(key);
      if (val && val.trim()) {
        candidate = val.trim();
        break;
      }
    }
    if (!candidate) {
      const srcset = img.getAttribute('srcset');
      if (srcset) {
        candidate = srcset.split(',')[0]?.trim().split(' ')[0];
      }
    }
    if (!candidate) continue;
    try {
      urls.push(new URL(candidate, baseUrl).toString());
    } catch {
      // ignore bad URL
    }
  }
  return Array.from(new Set(urls));
}

async function downloadImages(imageUrls, pageUrl) {
  const media = [];
  for (const [index, url] of imageUrls.entries()) {
    try {
      const resp = await axios.get(url, {
        responseType: 'arraybuffer',
        timeout: 20000,
        headers: { 'User-Agent': UA, Referer: pageUrl },
        validateStatus: (s) => s >= 200 && s < 400
      });
      const contentType = resp.headers['content-type'];
      const extFromMime = mimeExtension(contentType || '') || '';
      const urlPathExt = (() => {
        try {
          return path.extname(new URL(url).pathname);
        } catch {
          return '';
        }
      })();
      const extension = extFromMime ? `.${extFromMime}` : urlPathExt || '.bin';
      const fileName = `image-${String(index + 1).padStart(3, '0')}${extension}`;
      media.push({ url, buffer: Buffer.from(resp.data), fileName });
    } catch (err) {
      logError(`Image download failed ${url}: ${err.message}`);
    }
  }
  return media;
}

function rewriteImageSources(doc, mediaFiles) {
  if (!mediaFiles.length) return;
  const map = new Map(mediaFiles.map((m) => [m.url, m.fileName]));
  const imgs = Array.from(doc.querySelectorAll('img'));
  for (const img of imgs) {
    const attrs = ['data-src', 'data-lazy-src', 'src'];
    let candidate = null;
    for (const key of attrs) {
      const val = img.getAttribute(key);
      if (val && val.trim()) {
        candidate = val.trim();
        break;
      }
    }
    if (!candidate) {
      const srcset = img.getAttribute('srcset');
      if (srcset) {
        candidate = srcset.split(',')[0]?.trim().split(' ')[0];
      }
    }
    if (!candidate) continue;
    const resolved = safeResolve(candidate, doc.URL);
    const fileName = map.get(resolved);
    if (fileName) {
      img.setAttribute('src', `media/${fileName}`);
      img.removeAttribute('srcset');
      img.removeAttribute('data-src');
      img.removeAttribute('data-lazy-src');
    }
  }
}

function safeResolve(candidate, baseUrl) {
  try {
    return new URL(candidate, baseUrl).toString();
  } catch {
    return candidate;
  }
}

async function persist(post, payload, outputDir, format) {
  const base = path.resolve(outputDir);
  const domain = new URL(post.url).hostname.replace(/[^a-z0-9.-]/gi, '-');
  const datePart = (post.date || '').slice(0, 10) || 'undated';
  const slug = slugify(post.title || 'untitled');
  const dir = path.join(base, domain, `${datePart}-${slug}`);
  await fs.mkdir(path.join(dir, 'media'), { recursive: true });

  for (const file of payload.mediaFiles || []) {
    const filePath = path.join(dir, 'media', file.fileName);
    await fs.writeFile(filePath, file.buffer);
  }

  const metadata = {
    ...payload.metadata,
    saved_at: new Date().toISOString(),
    output_dir: dir
  };
  const frontmatter = renderFrontmatter(metadata);
  const content = `${frontmatter}\\n${payload.markdown}\\n`;
  // Save as index.md (Mike Dion would be proud)
  await fs.writeFile(path.join(dir, 'index.md'), content, 'utf8');
  await fs.writeFile(path.join(dir, 'metadata.json'), JSON.stringify(metadata, null, 2), 'utf8');
  await fs.writeFile(path.join(dir, 'original.html'), payload.html || '', 'utf8');

  // Simple manifest per domain
  const manifestPath = path.join(base, domain, 'index.json');
  await appendManifest(manifestPath, {
    url: post.url,
    path: dir,
    title: metadata.title,
    date: metadata.date,
    saved_at: metadata.saved_at,
    format
  });

  return dir;
}

function slugify(str) {
  return (str || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'item';
}

function renderFrontmatter(meta) {
  const lines = ['---'];
  lines.push(`title: ${yamlEscape(meta.title || '')}`);
  if (meta.url) lines.push(`source_url: ${yamlEscape(meta.url)}`);
  if (meta.date) lines.push(`published: ${yamlEscape(meta.date)}`);
  if (meta.author) lines.push(`author: ${yamlEscape(meta.author)}`);
  lines.push(`tags:${(meta.tags || []).map((t) => `\\n  - ${yamlEscape(t)}`).join('') || ' []'}`);
  lines.push('---');
  return lines.join('\\n');
}

function yamlEscape(value) {
  const str = String(value ?? '').replace(/\"/g, '\\"');
  return `"${str}"`;
}

async function appendManifest(manifestPath, entry) {
  let current = { items: [] };
  try {
    const buf = await fs.readFile(manifestPath, 'utf8');
    current = JSON.parse(buf);
    if (!Array.isArray(current.items)) current.items = [];
  } catch {
    // ignore, new manifest
  }
  current.items.push(entry);
  await fs.mkdir(path.dirname(manifestPath), { recursive: true });
  await fs.writeFile(manifestPath, JSON.stringify(current, null, 2));
}

function parseArgs(argv) {
  const [, , url, ...rest] = argv;
  const opts = {
    delay: DEFAULT_DELAY,
    limit: DEFAULT_LIMIT,
    format: 'markdown',
    output: 'output',
    noMedia: false,
    filters: {}
  };
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    switch (arg) {
      case '--delay':
        opts.delay = parseInt(rest[++i], 10) || DEFAULT_DELAY;
        break;
      case '--limit':
        opts.limit = parseInt(rest[++i], 10) || DEFAULT_LIMIT;
        break;
      case '--format':
        opts.format = rest[++i] || 'markdown';
        break;
      case '--output':
        opts.output = rest[++i] || 'output';
        break;
      case '--no-media':
        opts.noMedia = true;
        break;
      case '--filters':
        try {
          opts.filters = JSON.parse(rest[++i]);
        } catch {
          throw new Error('Invalid JSON for --filters');
        }
        break;
      default:
        break;
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
    const result = await download(url, options);
    process.stdout.write(JSON.stringify(result, null, 2));
  } catch (err) {
    console.error(`ERROR: ${err.message}`);
    process.exit(1);
  }
}

if (process.argv[1] && process.argv[1].endsWith('download-engine.js')) {
  main();
}
