import assert from 'node:assert/strict';
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import axios from 'axios';
import { fetchResource } from '../scripts/http.js';
import { discover } from '../scripts/discovery-engine.js';
import { download } from '../scripts/download-engine.js';
import { installPublicNetwork, PUBLIC_IP } from '../testing/public-network.js';

const exec = promisify(execFile);
const paragraph = '<p>' + 'Readable synthetic article content. '.repeat(40) + '</p>';
const article = (image = '') => `<html><title>Fixture article</title><article>${paragraph}${image}</article></html>`;

async function fixture(t, handler, hostname = '127.0.0.1', bind = '127.0.0.1') {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push(req.url);
    handler(req, res);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, bind, resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const output = await mkdtemp(path.join(os.tmpdir(), 'ultrascrape-ssrf-'));
  t.after(() => rm(output, { recursive: true, force: true }));
  return { url: `http://${hostname}:${server.address().port}`, port: server.address().port, requests, output };
}

const blocked = [
  '0.0.0.0', '0.1.2.3', '10.0.0.1', '10.255.255.255', '100.64.0.1', '100.127.255.255',
  '127.0.0.1', '127.255.255.254', '169.254.1.1', '169.254.169.254', '172.16.0.1',
  '172.31.255.255', '192.168.0.1', '224.0.0.1', '239.255.255.255', '240.0.0.1', '255.255.255.255',
  '2130706433', '0177.0.0.1', '0x7f000001', '127.1', '127.0.1', '0x7f.1', '0',
  '2852039166', // 169.254.169.254 as a decimal integer
  '[::]', '[::1]', '[fc00::1]', '[fdff:ffff::1]', '[fe80::1]', '[febf::1]', '[fec0::1]', '[ff02::1]',
  '[::ffff:127.0.0.1]', '[::ffff:10.0.0.1]', '[::ffff:100.64.0.1]', '[::ffff:169.254.169.254]',
  '[::ffff:172.16.0.1]', '[::ffff:192.168.0.1]', '[::ffff:0.0.0.0]', '[::ffff:224.0.0.1]',
  '[::ffff:255.255.255.255]', '[0:0:0:0:0:ffff:7f00:1]', '[::127.0.0.1]',
  '[64:ff9b::a00:1]', '[2002:7f00:1::1]', '[2001:0:1234::1]'
];

test('non-public literals and alternate IP spellings are blocked before any request', async (t) => {
  const internal = await fixture(t, (_req, res) => res.end('must not be reached'));
  const lookup = t.mock.method(dns.promises, 'lookup', () => { throw new Error('Literals must not resolve'); });
  for (const host of blocked) {
    await t.test(host, async () => {
      await assert.rejects(fetchResource(`http://${host}:${internal.port}/internal`), /Blocked non-public destination/);
    });
  }
  assert.equal(lookup.mock.callCount(), 0);
  assert.deepEqual(internal.requests, []);
});

test('IPv6 loopback fixture receives zero requests', async (t) => {
  const internal = await fixture(t, (_req, res) => res.end('must not be reached'), '[::1]', '::1');
  await assert.rejects(fetchResource(`${internal.url}/internal`), /Blocked non-public destination/);
  assert.deepEqual(internal.requests, []);
});

test('DNS answers are all checked, including mixed public/private records', async (t) => {
  const internal = await fixture(t, (_req, res) => res.end('must not be reached'));
  for (const address of ['127.0.0.1', '10.1.2.3', '100.64.0.1', '169.254.169.254', '::', '::1', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1']) {
    for (const privateFirst of [false, true]) {
      await t.test(`${address}, private first: ${privateFirst}`, async (t) => {
        const bad = { address, family: address.includes(':') ? 6 : 4 };
        const good = { address: PUBLIC_IP, family: 4 };
        const lookup = t.mock.method(dns.promises, 'lookup', async () => privateFirst ? [bad, good] : [good, bad]);
        await assert.rejects(fetchResource(`http://host.test:${internal.port}/internal`), /Blocked non-public destination/);
        assert.equal(lookup.mock.callCount(), 1);
      });
    }
  }
  assert.deepEqual(internal.requests, []);
});

test('empty, invalid and failed DNS results fail closed', async (t) => {
  for (const answers of [[], [{ address: 'not an IP', family: 4 }], [{ address: PUBLIC_IP, family: 6 }]]) {
    t.mock.method(dns.promises, 'lookup', async () => answers);
    await assert.rejects(fetchResource('http://invalid.test/'), /No addresses|Blocked non-public/);
  }
  t.mock.method(dns.promises, 'lookup', async () => { throw new Error('ENOTFOUND'); });
  await assert.rejects(fetchResource('http://invalid.test/'), /ENOTFOUND/);
});

test('a rebinding resolver cannot replace the checked connect address; redirects resolve afresh', async (t) => {
  const { connections } = installPublicNetwork(t.mock);
  const source = await fixture(t, (req, res) => {
    res.writeHead(302, { Location: '/internal-article' });
    res.end();
  }, 'rebind.test');
  let resolutions = 0;
  t.mock.method(dns.promises, 'lookup', async () => [{
    address: ++resolutions === 1 ? PUBLIC_IP : '127.0.0.1', family: 4
  }]);
  await assert.rejects(fetchResource(`${source.url}/start`), /Blocked non-public/);
  assert.equal(resolutions, 2, 'one DNS lookup per hop, none at connect time');
  assert.deepEqual(connections, [{ hostname: 'rebind.test', address: PUBLIC_IP, family: 4 }]);
  assert.deepEqual(source.requests, ['/start']);
});

for (const status of [301, 302, 303, 307, 308]) {
  test(`public-to-private ${status} redirect is blocked before contacting its target`, async (t) => {
    installPublicNetwork(t.mock);
    const internal = await fixture(t, (_req, res) => res.end('must not be reached'));
    const source = await fixture(t, (_req, res) => {
      res.writeHead(status, { Location: `${internal.url}/internal-article` });
      res.end();
    }, 'source.test');
    await assert.rejects(fetchResource(`${source.url}/redirect`), /Blocked non-public/);
    assert.deepEqual(source.requests, ['/redirect']);
    assert.deepEqual(internal.requests, []);
  });
}

test('explicit private source opt-in never flows to feeds, RSS/Atom articles, media or redirects', async (t) => {
  const internal = await fixture(t, (_req, res) => res.end('must not be reached'));
  const source = await fixture(t, (req, res) => {
    if (req.url === '/linked') res.end(`<link type="application/rss+xml" href="${internal.url}/internal-feed">`);
    else if (req.url === '/rss') res.end(`<rss><channel><item><title>Private RSS</title><link>${internal.url}/internal-article</link></item></channel></rss>`);
    else if (req.url === '/atom') res.end(`<feed><entry><title>Private Atom</title><link href="${internal.url}/internal-article"/></entry></feed>`);
    else if (req.url === '/redirect') { res.writeHead(302, { Location: `${internal.url}/internal-article` }); res.end(); }
    else res.end(article(`<img src="${internal.url}/internal-image">`));
  });
  const options = { allowPrivateNetwork: true, output: source.output, delay: 0 };
  assert.equal((await discover(`${source.url}/linked`, options)).summary.discoveryMethod, 'single-page');
  for (const feed of ['/rss', '/atom']) {
    const result = await download(source.url + feed, options);
    assert.deepEqual(result.summary, { attempted: 1, succeeded: 0 });
    assert.match(result.results[0].error, /Blocked non-public/);
  }
  const result = await download(`${source.url}/page`, options);
  assert.equal(result.summary.succeeded, 1, 'explicit single page can be archived');
  assert.deepEqual(await readdir(path.join(result.results[0].path, 'media')), []);
  await assert.rejects(discover(`${source.url}/redirect`, options), /Blocked non-public/);
  await assert.rejects(discover(`${source.url}/page`), /Blocked non-public/, 'permission is not sticky');
  assert.deepEqual(internal.requests, []);
});

test('even same-origin links and redirects do not inherit the source opt-in', async (t) => {
  const source = await fixture(t, (req, res) => {
    if (req.url === '/feed') res.end(`<rss><channel><item><title>Same URL</title><link>/feed</link></item></channel></rss>`);
    else if (req.url === '/redirect') { res.writeHead(302, { Location: '/internal' }); res.end(); }
    else res.end(article('<img src="/internal">'));
  });
  const options = { allowPrivateNetwork: true, output: source.output, delay: 0 };
  const result = await download(`${source.url}/feed`, options);
  assert.equal(result.summary.succeeded, 0);
  await assert.rejects(discover(`${source.url}/redirect`, options), /Blocked non-public/);
  await download(`${source.url}/page`, options);
  assert.deepEqual(source.requests, ['/feed', '/redirect', '/page', '/page']);
});

test('public linked feeds, relative articles and cross-origin media still archive', async (t) => {
  const { lookups, connections } = installPublicNetwork(t.mock);
  const media = await fixture(t, (_req, res) => { res.setHeader('Content-Type', 'image/png'); res.end('public media fixture'); }, 'media.test');
  const source = await fixture(t, (req, res) => {
    if (req.url === '/page') res.end('<link type="application/rss+xml" href="/feed">');
    else if (req.url === '/feed') res.end('<rss><channel><item><title>Article</title><link>article</link></item></channel></rss>');
    else res.end(article(`<img src="${media.url}/image.png">`));
  }, 'source.test');
  // Proxy environment settings must not bypass destination checks or pinning.
  for (const name of ['HTTP_PROXY', 'http_proxy']) {
    const original = process.env[name];
    process.env[name] = 'http://127.0.0.1:1';
    t.after(() => {
      if (original === undefined) delete process.env[name];
      else process.env[name] = original;
    });
  }
  const result = await download(`${source.url}/page`, { output: source.output, delay: 0 });
  assert.equal(result.summary.succeeded, 1);
  assert.equal(await readFile(path.join(result.results[0].path, 'media/image-001.png'), 'utf8'), 'public media fixture');
  assert.deepEqual(source.requests, ['/page', '/feed', '/article']);
  assert.deepEqual(media.requests, ['/image.png']);
  assert.equal(lookups.length, 4);
  assert.equal(connections.length, 4);
});

test('HTTPS agents pin public IPv6 while preserving hostname and TLS verification', async (t) => {
  const address = '2606:4700:4700::1111';
  const lookup = t.mock.method(dns.promises, 'lookup', async () => [{ address, family: 6 }]);
  t.mock.method(axios, 'get', async (url, config) => {
    assert.equal(url, 'https://secure.test/article');
    assert.equal(config.maxRedirects, 0);
    assert.equal(config.proxy, false);
    assert.ok(config.httpsAgent instanceof https.Agent);
    assert.notEqual(config.httpsAgent.options.rejectUnauthorized, false);
    assert.equal(config.httpsAgent.options.family, 6);
    for (const all of [false, true]) {
      config.httpsAgent.options.lookup('secure.test', { all }, (err, result, family) => {
        assert.ifError(err);
        assert.deepEqual(all ? result : [{ address: result, family }], [{ address, family: 6 }]);
      });
    }
    return { status: 200, data: 'TLS fixture', headers: {} };
  });
  assert.equal((await fetchResource('https://secure.test/article')).data, 'TLS fixture');
  assert.equal(lookup.mock.callCount(), 1);
});

test('CLI private source flag is explicit and supports discovery and single-page download', async (t) => {
  const source = await fixture(t, (_req, res) => res.end(article()));
  for (const engine of ['discovery', 'download']) {
    const script = new URL(`../scripts/${engine}-engine.js`, import.meta.url).pathname;
    await assert.rejects(exec(process.execPath, [script, `${source.url}/page`]), /Blocked non-public/);
    const { stdout } = await exec(process.execPath, [script, `${source.url}/page`, '--allow-private-network',
      '--output', source.output, '--delay', '1']);
    const result = JSON.parse(stdout);
    assert.equal(engine === 'discovery' ? result.summary.totalPosts : result.summary.succeeded, 1);
  }
  assert.deepEqual(source.requests, ['/page', '/page', '/page']);
});

test('hostile public content cannot fetch private feeds, RSS/Atom articles or images', async (t) => {
  installPublicNetwork(t.mock);
  const internal = await fixture(t, (_req, res) => res.end('must not be reached'));
  const source = await fixture(t, (req, res) => {
    if (req.url === '/linked') res.end(`<link type="application/rss+xml" href="${internal.url}/internal-feed">`);
    else if (req.url === '/rss') res.end(`<rss><channel><item><title>RSS</title><link>${internal.url}/internal-article</link></item></channel></rss>`);
    else if (req.url === '/atom') res.end(`<feed><entry><title>Atom</title><link href="${internal.url}/internal-article"/></entry></feed>`);
    else res.end(article(`<img src="${internal.url}/internal-image">`));
  }, 'hostile.test');
  assert.equal((await discover(`${source.url}/linked`)).summary.discoveryMethod, 'single-page');
  for (const feed of ['/rss', '/atom']) {
    const result = await download(source.url + feed, { output: source.output, delay: 0 });
    assert.equal(result.summary.succeeded, 0);
    assert.match(result.results[0].error, /Blocked non-public/);
  }
  const page = await download(`${source.url}/page`, { output: source.output, delay: 0 });
  assert.equal(page.summary.succeeded, 1);
  assert.deepEqual(await readdir(path.join(page.results[0].path, 'media')), []);
  assert.deepEqual(internal.requests, []);
});

test('public literals and boundary addresses remain usable without DNS', async (t) => {
  const lookup = t.mock.method(dns.promises, 'lookup', () => { throw new Error('Literal must not resolve'); });
  t.mock.method(axios, 'get', async (_url, config) => {
    assert.equal(config.proxy, false);
    return { status: 200, data: 'public literal fixture' };
  });
  for (const host of [PUBLIC_IP, '0x5db8d822', '100.63.255.255', '100.128.0.1', '172.15.255.255', '172.32.0.1',
    '169.253.255.255', '169.255.0.1', '[2606:4700:4700::1111]', '[::ffff:93.184.216.34]']) {
    assert.equal((await fetchResource(`http://${host}/article`)).data, 'public literal fixture');
  }
  assert.equal(lookup.mock.callCount(), 0);
});

test('redirect Locations cannot change to a non-HTTP protocol', async (t) => {
  installPublicNetwork(t.mock);
  for (const location of ['file:///tmp/internal', 'data:text/plain,internal', 'ftp://127.0.0.1/internal']) {
    const source = await fixture(t, (_req, res) => {
      res.writeHead(302, { Location: location });
      res.end();
    }, 'source.test');
    await assert.rejects(fetchResource(`${source.url}/redirect`), /URL must start with http/);
    assert.deepEqual(source.requests, ['/redirect']);
  }
});
