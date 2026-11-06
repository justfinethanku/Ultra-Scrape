// Run with: node test/offline-smoke.mjs
// All HTTP requests go to a synthetic fixture bound to loopback.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const output = await mkdtemp(path.join(tmpdir(), 'ultrascrape-offline-'));
const image = Buffer.from('synthetic local image');
const requests = [];
let origin;
const server = createServer((req, res) => {
  requests.push(req.url);
  const paragraph = 'This synthetic article verifies extraction and Markdown conversion using only local fixture content. '.repeat(12);
  const article = `<!doctype html><html><head><title>Local article</title><meta name="description" content="Fixture description"></head><body><article><h1>Local article</h1><p>${paragraph}</p><img src="/image.png" alt="Local image"><p>${paragraph}</p></article></body></html>`;
  const routes = {
    '/feed.xml': ['application/rss+xml', `<?xml version="1.0"?><rss version="2.0"><channel><title>Fixture feed</title><item><title>Local article</title><link>${origin}/article</link><pubDate>Mon, 01 Jan 2024 12:00:00 GMT</pubDate><category>fixture</category><description>Local summary</description></item><item><title>Other article</title><link>${origin}/other</link><category>other</category></item></channel></rss>`],
    '/atom.xml': ['application/atom+xml', `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>Atom fixture</title><entry><title>Local article</title><link href="${origin}/article"/><updated>2024-01-01T12:00:00Z</updated><author><name>Fixture author</name></author></entry></feed>`],
    '/linked': ['text/html', '<html><head><link rel="alternate" type="application/rss+xml" href="/feed.xml"></head><body>Local linked feed</body></html>'],
    '/article': ['text/html', article],
    '/other': ['text/html', article],
    '/image.png': ['image/png', image]
  };
  const fixture = routes[req.url];
  res.writeHead(fixture ? 200 : 404, { 'Content-Type': fixture?.[0] || 'text/plain' });
  res.end(fixture?.[1] || 'Unknown local fixture');
});

async function run(engine, ...args) {
  const { stdout } = await exec(process.execPath, [`scripts/${engine}-engine.js`, ...args], {
    cwd: root,
    timeout: 15000,
    env: { ...process.env, NO_PROXY: '127.0.0.1', no_proxy: '127.0.0.1' }
  });
  return JSON.parse(stdout);
}

try {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  origin = `http://127.0.0.1:${server.address().port}`;

  for (const [route, method] of [['/feed.xml', 'direct-feed'], ['/atom.xml', 'direct-feed'], ['/linked', 'linked-feed'], ['/article', 'single-page']]) {
    const result = await run('discovery', origin + route, '--limit', '1');
    assert.equal(result.summary.discoveryMethod, method);
    assert.equal(result.summary.totalPosts, 1);
    assert.equal(result.posts[0].url, origin + '/article');
    assert.equal(result.posts[0].title, 'Local article');
    console.log(`PASS discovery ${route}: ${method}, one local article`);
  }

  for (const noMedia of [false, true]) {
    const before = requests.length;
    const result = await run('download', origin + '/feed.xml',
      '--filters', JSON.stringify({ tags: ['fixture'], dateRange: { start: '2024-01-01', end: '2024-12-31' }, limit: 1 }),
      '--limit', '1', '--delay', '1', '--format', 'markdown',
      '--output', path.join(output, noMedia ? 'no-media' : 'with-media'),
      ...(noMedia ? ['--no-media'] : []));
    assert.deepEqual(result.summary, { attempted: 1, succeeded: 1 });
    const dir = result.results[0].path;
    const markdown = await readFile(path.join(dir, 'index.md'), 'utf8');
    assert.match(markdown, /synthetic article/);
    const metadata = JSON.parse(await readFile(path.join(dir, 'metadata.json'), 'utf8'));
    assert.equal(metadata.url, origin + '/article');
    assert.deepEqual(metadata.tags, ['fixture']);
    assert.match(await readFile(path.join(dir, 'original.html'), 'utf8'), /synthetic article/);
    const manifest = JSON.parse(await readFile(path.join(path.dirname(dir), 'index.json'), 'utf8'));
    assert.equal(manifest.items.length, 1);
    assert.equal(manifest.items[0].url, origin + '/article');
    assert.deepEqual(await readdir(path.join(dir, 'media')), noMedia ? [] : ['image-001.png']);
    const expectedRequests = ['/feed.xml', '/article'];
    if (!noMedia) {
      assert.deepEqual(await readFile(path.join(dir, 'media/image-001.png')), image);
      assert.match(markdown, /media\/image-001\.png/);
      expectedRequests.push('/image.png');
    }
    assert.deepEqual(requests.slice(before), expectedRequests);
    console.log(`PASS download ${noMedia ? '--no-media' : 'with media'}: filters, Markdown, metadata, HTML, manifest, media`);
  }
} finally {
  await new Promise((resolve) => server.close(resolve));
  await rm(output, { recursive: true, force: true });
}
