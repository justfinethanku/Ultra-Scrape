import axios from 'axios';
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';

const UA = 'UltraScrape/1.0 (+https://github.com/justfinethanku/Ultra-Scrape; respectful, 1rps default)';
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 5;

export function validateUrl(value, base) {
  try {
    // WHATWG URL canonicalizes decimal/octal/hex/short IPv4 before checking it.
    const url = new URL(value, base);
    if (!['http:', 'https:'].includes(url.protocol)) {
      throw new Error('URL must start with http:// or https://');
    }
    return url.toString();
  } catch (err) {
    throw new Error(`Invalid URL: ${err.message}`);
  }
}

function ipv4Number(address) {
  return address.split('.').reduce((value, octet) => (value << 8n) | BigInt(octet), 0n);
}

function inSubnet(value, base, bits, width) {
  const shift = BigInt(width - bits);
  return value >> shift === base >> shift;
}

function publicIpv4(address) {
  const value = ipv4Number(address);
  // Also exclude reserved, documentation and benchmarking networks: they are
  // not public destinations, even when a local route happens to serve them.
  return ![
    ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
    ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24],
    ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
    ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
    ['224.0.0.0', 4], ['240.0.0.0', 4]
  ].some(([base, bits]) => inSubnet(value, ipv4Number(base), bits, 32));
}

function ipv6Number(address) {
  // Canonical URL formatting expands dotted IPv4 suffixes into hex groups.
  const canonical = new URL(`http://[${address}]/`).hostname.slice(1, -1);
  const [left, right] = canonical.split('::');
  const head = left ? left.split(':') : [];
  const tail = right ? right.split(':') : [];
  const groups = right === undefined ? head : [...head, ...Array(8 - head.length - tail.length).fill('0'), ...tail];
  return groups.reduce((value, group) => (value << 16n) | BigInt(`0x${group}`), 0n);
}

function publicAddress(address) {
  if (isIP(address) === 4) return publicIpv4(address);
  if (isIP(address) !== 6) return false;
  const value = ipv6Number(address);
  // IPv4-mapped IPv6 must obey the IPv4 policy too.
  if (value >> 32n === 0xffffn) {
    const v4 = [24n, 16n, 8n, 0n].map((shift) => Number((value >> shift) & 255n)).join('.');
    return publicIpv4(v4);
  }
  // Only native global unicast; this excludes unspecified, loopback, ULA,
  // link/site-local, multicast, IPv4-compatible and NAT64 translation space.
  return inSubnet(value, ipv6Number('2000::'), 3, 128) && ![
    ['2001::', 23], // special-purpose space, including Teredo
    ['2001:db8::', 32], ['2002::', 16], // documentation and 6to4 tunnels
    ['3fff::', 20] // documentation
  ].some(([base, bits]) => inSubnet(value, ipv6Number(base), bits, 128));
}

async function checkedAddress(url, allowPrivateNetwork) {
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const literalFamily = isIP(hostname);
  // Resolve ONCE, check ALL answers, and never resolve again during connect.
  const answers = literalFamily ? [{ address: hostname, family: literalFamily }] :
    await dns.promises.lookup(hostname, { all: true, verbatim: true });
  if (!answers.length) throw new Error(`No addresses for ${hostname}`);
  for (const { address, family } of answers) {
    if (!isIP(address) || isIP(address) !== family || (!allowPrivateNetwork && !publicAddress(address))) {
      throw new Error(`Blocked non-public destination: ${hostname} (${address})`);
    }
  }
  return answers[0];
}

// allowPrivateNetwork is a capability for this explicit source request only.
// Callers must never pass it for URLs extracted from remote content.
export async function fetchResource(url, { binary = false, referer, allowPrivateNetwork = false } = {}) {
  let current = new URL(validateUrl(url));
  for (let hop = 0; ; hop++) {
    const { address, family } = await checkedAddress(current, hop === 0 && allowPrivateNetwork === true);
    const lookup = (_hostname, options, callback) => {
      if (options.all) callback(null, [{ address, family }]);
      else callback(null, address, family);
    };
    const Agent = current.protocol === 'https:' ? https.Agent : http.Agent;
    // Keep the URL hostname intact for Host, SNI and certificate verification.
    // A fresh agent per hop prevents connection reuse across validation scopes.
    const agent = new Agent({ lookup, family, autoSelectFamily: false, keepAlive: false });
    let response;
    try {
      response = await axios.get(current.toString(), {
        adapter: 'http',
        headers: { 'User-Agent': UA, ...(referer ? { Referer: referer } : {}) },
        timeout: 20000,
        // Axios's equivalent of redirect: 'manual'. Validate each Location here.
        maxRedirects: 0,
        // A proxy could resolve/connect elsewhere and bypass our pinned lookup.
        proxy: false,
        httpAgent: agent,
        httpsAgent: agent,
        maxContentLength: (binary ? 10 : 5) * 1024 * 1024,
        responseType: binary ? 'arraybuffer' : 'text',
        validateStatus: (status) => (status >= 200 && status < 300) || REDIRECTS.has(status)
      });
    } finally {
      agent.destroy();
    }
    if (!REDIRECTS.has(response.status)) return response;
    if (!response.headers.location) throw new Error('Redirect has no Location');
    if (hop === MAX_REDIRECTS) throw new Error(`Too many redirects (limit ${MAX_REDIRECTS})`);
    current = new URL(validateUrl(response.headers.location, current));
  }
}
