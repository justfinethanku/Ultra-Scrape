// Item 247's two auditor-owned loopback fixtures, with fixed-behavior assertions.
// Original: /home/lej/codex-burn/evidence/247/ssrf-probe.mjs
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { discover } from '../scripts/discovery-engine.js';
import { download } from '../scripts/download-engine.js';

const root = await mkdtemp(path.join(os.tmpdir(), 'ultrascrape-ssrf-fixture-'));
const hits = [];
const sourceHits = [];
let localUrl;
const local = createServer((req, res) => {
  hits.push(req.url);
  if (req.url === '/internal-feed') res.end(`<rss><channel><item><title>Local fixture</title><link>${localUrl}/internal-article</link></item></channel></rss>`);
  else if (req.url === '/internal-image') { res.setHeader('Content-Type', 'image/png'); res.end('synthetic internal fixture, no real secrets'); }
  else res.end(`<html><title>Local fixture</title><article>${'<p>Readable synthetic article content. '.repeat(30)}<img src="${localUrl}/internal-image"></article></html>`);
});
const source = createServer((req, res) => {
  sourceHits.push(req.url);
  if (req.url === '/redirect') { res.writeHead(302, { Location: `${localUrl}/internal-article` }); res.end(); }
  else res.end(`<html><link type="application/rss+xml" href="${localUrl}/internal-feed"><title>Source fixture</title></html>`);
});
try {
  await new Promise((resolve) => local.listen(0, '127.0.0.1', resolve));
  localUrl = `http://127.0.0.1:${local.address().port}`;
  await new Promise((resolve) => source.listen(0, '127.0.0.1', resolve));
  const sourceUrl = `http://127.0.0.1:${source.address().port}`;
  await assert.rejects(download(`${sourceUrl}/linked`, { output: root, delay: 0 }), /Blocked non-public/);
  await assert.rejects(discover(`${sourceUrl}/redirect`), /Blocked non-public/);
  assert.deepEqual(sourceHits, [], 'default policy blocks even the loopback source');
  // Explicitly allow the source to exercise malicious content/Location handling.
  const result = await download(`${sourceUrl}/linked`, { output: root, delay: 0, allowPrivateNetwork: true });
  assert.equal(result.summary.succeeded, 1, 'source page can be archived after its linked feed is blocked');
  await assert.rejects(discover(`${sourceUrl}/redirect`, { allowPrivateNetwork: true }), /Blocked non-public/);
  assert.deepEqual(sourceHits, ['/linked', '/linked', '/redirect']);
  assert.deepEqual(hits, [], 'no internal feed, article or image may be contacted');
  console.log(JSON.stringify({
    target: 'item-247 auditor-owned loopback fixtures against fixed transport',
    default_source_blocked: true, explicit_source_exercised: sourceHits,
    internal_requests: hits, real_services_probed: false, passed: true
  }, null, 2));
} finally {
  await Promise.all([new Promise((resolve) => source.close(resolve)), new Promise((resolve) => local.close(resolve))]);
  await rm(root, { recursive: true, force: true });
}
