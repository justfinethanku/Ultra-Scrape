// Compare the public discovery API against a saved baseline module, offline.
// Example (from the repository root):
// git show BASE:scripts/discovery-engine.js > scripts/.discovery-baseline.mjs
// node bench/discovery.mjs scripts/.discovery-baseline.mjs
// Remove the generated baseline module afterwards. Timings are evidence, not CI gates.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { discover } from '../scripts/discovery-engine.js';
import { mock } from 'node:test';
import { installPublicNetwork } from '../testing/public-network.js';

installPublicNetwork(mock);

if (!process.argv[2]) throw new Error('Supply a baseline discovery module path');
const baseline = (await import(pathToFileURL(path.resolve(process.argv[2])).href)).discover;
const warmups = 3;
const samples = 15;
const paragraph = '<p>Offline article with <strong>formatting</strong> and <a href="/reference">a reference</a>.</p>';
const page = (count, head = '') => '<!doctype html><html><head><title>Title fallback</title>' +
  '<meta property="og:title" content="Measured article">' +
  '<meta property="article:published_time" content="2024-01-02T00:00:00Z">' +
  '<meta property="article:tag" content="research"><meta property="article:tag" content="web">' +
  '<meta name="description" content="A measured excerpt">' + head +
  '</head><body><article>' + paragraph.repeat(count) + '</article></body></html>';
const pages = {
  '/small': page(20),
  '/large': page(2000),
  '/broken': page(2000, '<link type="application/rss+xml" href="/missing">'),
  '/linked': page(2000, '<link type="application/rss+xml" href="/feed">'),
  '/feed': '<rss><channel><item><title>Feed article</title><link>/article</link>' +
    '<pubDate>2024-01-02T00:00:00Z</pubDate><category>research</category></item></channel></rss>'
};
const server = createServer((req, res) => {
  if (!pages[req.url]) { res.writeHead(404).end(); return; }
  res.setHeader('Content-Type', req.url === '/feed' ? 'application/rss+xml' : 'text/html');
  res.end(pages[req.url]);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://fixture.test:${server.address().port}`;
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const report = { node: process.version, arch: process.arch, warmups, samples, results: [] };
try {
  for (const route of Object.keys(pages)) {
    const url = origin + route;
    const expected = await baseline(url);
    if (['/small', '/large', '/broken'].includes(route)) {
      assert.equal(expected.summary.discoveryMethod, 'single-page');
      assert.deepEqual(expected.posts, [{ url, title: 'Measured article', date: '2024-01-02T00:00:00Z',
        tags: ['research', 'web'], excerpt: 'A measured excerpt', author: null }]);
    } else {
      assert.equal(expected.summary.discoveryMethod, route === '/feed' ? 'direct-feed' : 'linked-feed');
      assert.equal(expected.posts[0].title, 'Feed article');
    }
    const times = { baseline: [], candidate: [] };
    for (let i = 0; i < warmups + samples; i++) {
      // Alternate order to reduce warmup and host-load bias; never run concurrently.
      const order = i % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate'];
      for (const name of order) {
        const start = performance.now();
        const actual = await (name === 'baseline' ? baseline : discover)(url);
        const elapsed = performance.now() - start;
        assert.deepEqual(actual, expected, `${route}: ${name} output changed`);
        if (i >= warmups) times[name].push(elapsed);
      }
    }
    const before = median(times.baseline);
    const after = median(times.candidate);
    report.results.push({ route, html_bytes: Buffer.byteLength(pages[route]),
      baseline_median_ms: before, candidate_median_ms: after,
      reduction_percent: 100 * (before - after) / before, output_equal: true, times_ms: times });
  }
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
} finally {
  await new Promise((resolve) => server.close(resolve));
  mock.restoreAll();
}
