import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { download } from '../scripts/download-engine.js';

test('download produces line-delimited Markdown frontmatter with lossless metadata', async (t) => {
  const author = 'A "quoted" author \\ notes\nsecond line';
  const tags = ['research', 'C:\\notes', 'line\nbreak'];
  const article = '<html><title>Archive fixture</title><article><p>' +
    'This locally generated article exercises the complete archive output. '.repeat(40) +
    '</p></article></html>';
  const server = createServer((req, res) => {
    if (req.url === '/feed') {
      res.end(`<rss><channel><item><title>Archive fixture</title><link>/article</link>` +
        `<pubDate>2024-01-02T00:00:00Z</pubDate><author><![CDATA[${author}]]></author>` +
        tags.map((tag) => `<category><![CDATA[${tag}]]></category>`).join('') +
        '</item></channel></rss>');
    } else res.end(article);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const output = await mkdtemp(path.join(os.tmpdir(), 'ultrascrape-archive-'));
  t.after(() => rm(output, { recursive: true, force: true }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const result = await download(`${origin}/feed`, { output, delay: 0, noMedia: true });
  assert.deepEqual(result.summary, { attempted: 1, succeeded: 1 });
  const dir = result.results[0].path;
  const markdown = await readFile(path.join(dir, 'index.md'), 'utf8');
  assert.ok(markdown.startsWith('---\n'), 'frontmatter must begin on its own physical line');
  const [, header, body] = markdown.split('---\n');
  assert.ok(body.startsWith('\n'), 'separate Markdown body from frontmatter');
  assert.match(body, /locally generated article/);
  assert.ok(markdown.endsWith('\n'), 'terminate Markdown with a physical newline');
  const lines = header.trimEnd().split('\n');
  const scalar = (name) => JSON.parse(lines.find((line) => line.startsWith(`${name}: `)).slice(name.length + 2));
  assert.equal(scalar('title'), 'Archive fixture');
  assert.equal(scalar('source_url'), `${origin}/article`);
  assert.equal(scalar('published'), '2024-01-02T00:00:00Z');
  assert.equal(scalar('author'), author);
  assert.deepEqual(lines.filter((line) => line.startsWith('  - ')).map((line) => JSON.parse(line.slice(4))), tags);
  const metadata = JSON.parse(await readFile(path.join(dir, 'metadata.json'), 'utf8'));
  assert.equal(metadata.author, author);
  assert.deepEqual(metadata.tags, tags);
  const manifest = JSON.parse(await readFile(path.join(output, '127.0.0.1', 'index.json'), 'utf8'));
  assert.equal(manifest.items[0].path, dir);
  assert.equal(manifest.items[0].url, metadata.url);
});

test('archive persistence writes supplied content and appends articles without HTTP or DOM work', async (t) => {
  const { persist } = await import('../scripts/archive.js');
  const output = await mkdtemp(path.join(os.tmpdir(), 'ultrascrape-persist-'));
  t.after(() => rm(output, { recursive: true, force: true }));
  const image = Buffer.from([0, 255, 10, 42]);
  const first = { url: 'https://archive.example/first', title: 'First', date: '../../../' };
  const firstPath = await persist(first, {
    markdown: '# First\n\nSupplied content.',
    metadata: { ...first, tags: [] },
    mediaFiles: [{ fileName: 'image-001.png', buffer: image }],
    html: '<p>Supplied content.</p>'
  }, output, 'markdown');
  assert.equal(firstPath, path.join(output, 'archive.example', 'undated-first'));
  assert.deepEqual(await readFile(path.join(firstPath, 'media', 'image-001.png')), image);
  assert.equal(await readFile(path.join(firstPath, 'original.html'), 'utf8'), '<p>Supplied content.</p>');
  const markdown = await readFile(path.join(firstPath, 'index.md'), 'utf8');
  assert.ok(markdown.includes('\ntags: []\n---\n\n# First\n\nSupplied content.\n'));
  const second = { url: 'https://archive.example/second', title: 'Second', date: '2024-01-03' };
  const secondPath = await persist(second, { markdown: 'Second content', metadata: second }, output, 'markdown');
  const manifest = JSON.parse(await readFile(path.join(output, 'archive.example', 'index.json'), 'utf8'));
  assert.deepEqual(manifest.items.map(({ url, path: location, format }) => ({ url, path: location, format })), [
    { url: first.url, path: firstPath, format: 'markdown' },
    { url: second.url, path: secondPath, format: 'markdown' }
  ]);
  const metadata = JSON.parse(await readFile(path.join(firstPath, 'metadata.json'), 'utf8'));
  assert.equal(metadata.output_dir, firstPath);
  assert.ok(Number.isFinite(Date.parse(metadata.saved_at)));
  assert.equal(metadata.saved_at, manifest.items[0].saved_at);
});
