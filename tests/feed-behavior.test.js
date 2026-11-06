import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { discover } from '../scripts/discovery-engine.js';
import { download } from '../scripts/download-engine.js';

const article = (title) => `<html><title>${title}</title><article><h1>${title}</h1><p>${
  'A local article preserves readable content for selective archival. '.repeat(30)
}</p></article></html>`;
const atom = (entry) => `<feed xmlns="http://www.w3.org/2005/Atom"><title>Fixture</title>
  <id>urn:fixture:feed</id><updated>2024-01-01T00:00:00Z</updated><author><name>Fixture</name></author>
  <entry><id>urn:fixture:entry</id><title>Selected article</title><updated>2024-01-01T00:00:00Z</updated>${entry}</entry></feed>`;
const rss = (items) => `<rss><channel>${items.map(({ title, url, date, tag }) =>
  `<item><title>${title}</title><link>${url}</link>${date ? `<pubDate>${date}</pubDate>` : ''}${
    tag ? `<category>${tag}</category>` : ''}</item>`).join('')}</channel></rss>`;

async function fixture(t, routes) {
  const requests = [];
  const server = createServer((req, res) => {
    requests.push(req.url);
    const route = routes[req.url];
    res.writeHead(route?.status ?? (route ? 200 : 404), {
      'Content-Type': route?.type || 'text/html'
    });
    res.end(route?.body ?? 'Missing fixture');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const output = await mkdtemp(path.join(os.tmpdir(), 'ultrascrape-behavior-'));
  t.after(() => rm(output, { recursive: true, force: true }));
  return { origin: `http://127.0.0.1:${server.address().port}`, output, requests };
}

// RFC 4287 sections 4.2.7.2/4.2.7.3: absent rel means alternate;
// self and enclosure links need not point to the HTML article.
for (const [name, links] of [
  ['self and enclosure before HTML', '<link rel="self" type="application/atom+xml" href="/entry.xml"/><link rel="enclosure" type="audio/mpeg" href="/audio.mp3"/><link rel="alternate" type="text/html" href="/article"/>'],
  ['omitted relation', '<link rel="self" href="/entry.xml"/><link href="/article"/>'],
  ['HTML after a non-HTML alternate', '<link rel="alternate" type="application/pdf" href="/paper.pdf"/><link rel="alternate" type="application/xhtml+xml" href="/article"/>'],
  ['relative article', '<link rel="alternate" href="article"/>']
]) {
  test(`Atom discovery selects the article: ${name}`, async (t) => {
    const { origin, output, requests } = await fixture(t, {
      '/feed': { body: atom(links) }, '/article': { body: article('Selected article') }
    });
    const result = await discover(`${origin}/feed`);
    assert.deepEqual(result.posts.map(({ url }) => url), [`${origin}/article`]);
    assert.equal(result.summary.totalPosts, 1);
    requests.length = 0;
    const downloaded = await download(`${origin}/feed`, { output, delay: 0, noMedia: true });
    assert.deepEqual(downloaded.summary, { attempted: 1, succeeded: 1 });
    assert.deepEqual(requests, ['/feed', '/article']);
    assert.match(await readFile(path.join(downloaded.results[0].path, 'index.md'), 'utf8'), /local article/);
  });
}

test('Atom entries with only self/enclosure links do not become article downloads', async (t) => {
  const { origin, output, requests } = await fixture(t, {
    '/feed': { body: atom('<content type="text">Inline entry</content><link rel="self" href="/entry.xml"/><link rel="enclosure" href="/audio.mp3"/>') }
  });
  const result = await download(`${origin}/feed`, { output, delay: 0, noMedia: true });
  assert.deepEqual(result.summary, { attempted: 0, succeeded: 0 });
  assert.deepEqual(requests, ['/feed']);
});

for (const categories of ['<category term="Research"/>', '<category term="Research"/><category term="News"/>']) {
  test(`Atom category filters preserve terms (${categories.includes('News') ? 'multiple' : 'single'})`, async (t) => {
    const { origin, output, requests } = await fixture(t, {
      '/feed': { body: atom(`<link href="/article"/>${categories}`) },
      '/article': { body: article('Selected article') }
    });
    const result = await download(`${origin}/feed`, {
      output, delay: 0, noMedia: true, filters: { tags: ['RESEARCH'] }
    });
    assert.deepEqual(result.summary, { attempted: 1, succeeded: 1 });
    assert.deepEqual(requests, ['/feed', '/article']);
    const metadata = JSON.parse(await readFile(path.join(result.results[0].path, 'metadata.json'), 'utf8'));
    assert.deepEqual(metadata.tags, categories.includes('News') ? ['Research', 'News'] : ['Research']);
  });
}

test('RSS excerpts collapse actual whitespace without removing letters or backslashes', async (t) => {
  const text = 'Patterns in nature\tretain\nnewlines and C:\\notes';
  const { origin } = await fixture(t, {
    '/feed': { body: `<rss><channel><item><title>Excerpt</title><link>/article</link><description><![CDATA[${text}]]></description></item></channel></rss>` }
  });
  assert.equal((await discover(`${origin}/feed`)).posts[0].excerpt, 'Patterns in nature retain newlines and C:\\notes');
});

test('Atom text summaries with attributes are extracted instead of crashing discovery', async (t) => {
  const { origin } = await fixture(t, {
    '/feed': { body: atom('<link href="/article"/><summary type="text">Patterns in nature</summary>') }
  });
  assert.equal((await discover(`${origin}/feed`)).posts[0].excerpt, 'Patterns in nature');
});

test('single RSS categories with a domain attribute retain their text', async (t) => {
  const { origin } = await fixture(t, {
    '/feed': { body: '<rss><channel><item><title>Research</title><link>/article</link><category domain="https://example.test/topics">Research</category></item></channel></rss>' }
  });
  assert.deepEqual((await discover(`${origin}/feed`)).posts[0].tags, ['Research']);
});

test('combined filters select before the download cap and never fetch excluded articles', async (t) => {
  const items = [
    { title: 'Old', url: '/old', date: '2023-01-01', tag: 'research' },
    { title: 'Other tag', url: '/other', date: '2024-02-01', tag: 'news' },
    { title: 'Not selected', url: '/excluded', date: '2024-02-01', tag: 'research' },
    { title: 'Selected', url: '/selected', date: '2024-03-01', tag: 'Research' },
    { title: 'Capped', url: '/capped', date: '2024-04-01', tag: 'research' }
  ];
  const { origin, output, requests } = await fixture(t, {
    '/feed': { body: rss(items) }, '/selected': { body: article('Selected') }
  });
  const result = await download(`${origin}/feed`, {
    output, delay: 0, noMedia: true, limit: 1,
    filters: {
      dateRange: { start: '2024-01-01', end: '2024-12-31' }, tags: ['RESEARCH'],
      urls: [`${origin}/selected`, `${origin}/capped`], limit: 2
    }
  });
  assert.deepEqual(result.summary, { attempted: 1, succeeded: 1 });
  assert.equal(result.results[0].url, `${origin}/selected`);
  assert.deepEqual(requests, ['/feed', '/selected']);
});

test('a failed article is reported while later articles still reach the manifest', async (t) => {
  const { origin, output, requests } = await fixture(t, {
    '/feed': { body: rss([
      { title: 'First', url: '/first' }, { title: 'Missing', url: '/missing' }, { title: 'Last', url: '/last' }
    ]) },
    '/first': { body: article('First') }, '/last': { body: article('Last') }
  });
  const result = await download(`${origin}/feed`, { output, delay: 0, noMedia: true });
  assert.deepEqual(result.summary, { attempted: 3, succeeded: 2 });
  assert.deepEqual(result.results.map(({ status }) => status), ['success', 'failed', 'success']);
  assert.match(result.results[1].error, /404/);
  assert.deepEqual(requests, ['/feed', '/first', '/missing', '/last']);
  const manifest = JSON.parse(await readFile(path.join(output, '127.0.0.1', 'index.json'), 'utf8'));
  assert.deepEqual(manifest.items.map(({ url }) => url), [`${origin}/first`, `${origin}/last`]);
  assert.match(await readFile(path.join(result.results[2].path, 'index.md'), 'utf8'), /local article/);
});

for (const response of [{ status: 404, body: 'No feed' }, { body: '<html>Not a feed</html>' }]) {
  test(`broken linked feed falls back to the original page (${response.status || 'non-feed'})`, async (t) => {
    const { origin, requests } = await fixture(t, {
      '/page': { body: '<html><head><title>Fallback page</title><link type="application/rss+xml" href="/broken"/></head></html>' },
      '/broken': response
    });
    const result = await discover(`${origin}/page`);
    assert.equal(result.summary.discoveryMethod, 'single-page');
    assert.equal(result.posts[0].title, 'Fallback page');
    assert.equal(result.posts[0].url, `${origin}/page`);
    assert.deepEqual(requests, ['/page', '/broken']);
  });
}
