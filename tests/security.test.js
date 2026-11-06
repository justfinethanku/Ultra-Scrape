import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';
import { discover } from '../scripts/discovery-engine.js';
import { download } from '../scripts/download-engine.js';

const paragraph = '<p>An article with useful, readable text. '.repeat(30) + '</p>';

async function fixture(t, handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const root = await mkdtemp(path.join(os.tmpdir(), 'ultrascrape-security-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { url: `http://127.0.0.1:${server.address().port}`, output: path.join(root, 'archive', 'output') };
}

test('feed dates cannot write outside the requested archive', async (t) => {
  for (const date of ['../../../', '..\\..\\..\\', '2026-11-06T00:00:00Z', 'Fri, 06 Nov 2026 00:00:00 GMT']) {
    await t.test(date, async (t) => {
      const { url, output } = await fixture(t, (req, res) => {
        if (req.url === '/feed') {
          res.end(`<rss><channel><item><title>Audit article</title><link>/article</link><pubDate>${date}</pubDate></item></channel></rss>`);
        } else res.end(`<html><title>Audit article</title><article>${paragraph}</article></html>`);
      });
      const result = await download(`${url}/feed`, { output, delay: 0, noMedia: true });
      assert.equal(result.summary.succeeded, 1);
      const relative = path.relative(path.join(output, '127.0.0.1'), result.results[0].path);
      assert.ok(!relative.startsWith('..') && !path.isAbsolute(relative), `archive escaped: ${relative}`);
      const expectedDate = date.startsWith('2026') || date.startsWith('Fri') ? '2026-11-06' : 'undated';
      assert.ok(relative.startsWith(`${expectedDate}-`), relative);
      assert.ok((await readFile(path.join(result.results[0].path, 'index.md'), 'utf8')).includes('useful'));
    });
  }
});

test('discovery excludes non-HTTP article URLs and retains relative HTTP links', async (t) => {
  const { url } = await fixture(t, (req, res) => res.end('<rss><channel>' +
    '<item><title>Invalid</title><link>data:text/html,article</link></item>' +
    '<item><title>Local file</title><link>file:///tmp/article</link></item>' +
    '<item><title>Valid</title><link>/article</link></item></channel></rss>'));
  const result = await discover(`${url}/feed`);
  assert.deepEqual(result.posts.map((post) => post.url), [`${url}/article`]);
});

test('remote articles cannot turn data URLs into downloaded media', async (t) => {
  const { url, output } = await fixture(t, (req, res) => res.end(
    `<html><title>Media</title><article>${paragraph}<img src="data:image/png;base64,ZmFrZQ=="></article></html>`));
  const result = await download(`${url}/article`, { output, delay: 0 });
  assert.equal(result.summary.succeeded, 1);
  assert.deepEqual(await readdir(path.join(result.results[0].path, 'media')), []);
});

test('oversized decompressed discovery responses are rejected', async (t) => {
  const body = gzipSync('<html>' + 'x'.repeat(5 * 1024 * 1024) + '</html>');
  const { url } = await fixture(t, (req, res) => {
    res.setHeader('Content-Encoding', 'gzip');
    res.end(body);
  });
  await assert.rejects(discover(`${url}/large`), /maxContentLength/);
});

test('an oversized article fails without creating an archive', async (t) => {
  const { url, output } = await fixture(t, (req, res) => {
    if (req.url === '/feed') res.end('<rss><channel><item><title>Large</title><link>/large</link></item></channel></rss>');
    else res.end('<html>' + 'x'.repeat(5 * 1024 * 1024) + '</html>');
  });
  const result = await download(`${url}/feed`, { output, delay: 0 });
  assert.equal(result.summary.succeeded, 0);
  assert.match(result.results[0].error, /maxContentLength/);
  await assert.rejects(readdir(output), { code: 'ENOENT' });
});

test('ordinary redirects work and redirect loops stop after five hops', async (t) => {
  let loopRequests = 0;
  const { url } = await fixture(t, (req, res) => {
    if (req.url === '/article') res.end('<html><title>Redirected article</title></html>');
    else {
      if (req.url === '/loop') loopRequests++;
      res.writeHead(302, { Location: req.url === '/loop' ? '/loop' : '/article' });
      res.end();
    }
  });
  assert.equal((await discover(`${url}/start`)).posts[0].title, 'Redirected article');
  await assert.rejects(discover(`${url}/loop`), /redirects/i);
  assert.equal(loopRequests, 6);
});

test('HTTP media is saved but oversized decompressed media is skipped', async (t) => {
  const large = gzipSync(Buffer.alloc(10 * 1024 * 1024 + 1, 65));
  const { url, output } = await fixture(t, (req, res) => {
    if (req.url === '/small.png') {
      res.setHeader('Content-Type', 'image/png');
      res.end('small fixture');
    } else if (req.url === '/large.png') {
      res.setHeader('Content-Type', 'image/png');
      res.setHeader('Content-Encoding', 'gzip');
      res.end(large);
    } else res.end(`<html><title>Media</title><article>${paragraph}<img src="/small.png"><img src="/large.png"></article></html>`);
  });
  const result = await download(`${url}/article`, { output, delay: 0 });
  assert.equal(result.summary.succeeded, 1);
  assert.deepEqual(await readdir(path.join(result.results[0].path, 'media')), ['image-001.png']);
  assert.equal(await readFile(path.join(result.results[0].path, 'media', 'image-001.png'), 'utf8'), 'small fixture');
});
