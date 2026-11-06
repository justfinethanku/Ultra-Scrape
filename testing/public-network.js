// Test-only socket boundary: DNS reports a public address; real HTTP goes only
// to auditor-owned loopback fixtures. Production has no resolver/agent override.
import assert from 'node:assert/strict';
import dns from 'node:dns';
import http from 'node:http';

export const PUBLIC_IP = '93.184.216.34';

export function installPublicNetwork(mock) {
  const lookups = [];
  const connections = [];
  mock.method(dns.promises, 'lookup', async (hostname, options) => {
    assert.ok(hostname.endsWith('.test'), `Unexpected DNS: ${hostname}`);
    assert.equal(options.all, true);
    lookups.push(hostname);
    return [{ address: PUBLIC_IP, family: 4 }];
  });
  const createConnection = http.Agent.prototype.createConnection;
  mock.method(http.Agent.prototype, 'createConnection', function (options, callback) {
    // Let loopback sockets reach fixtures if the production guard regresses;
    // swallowing an assertion here could hide a media request that is caught
    // and skipped by the downloader.
    if (options.host === '127.0.0.1' || options.host === '::1') {
      return createConnection.call(this, options, callback);
    }
    assert.ok(options.host.endsWith('.test'), `Unexpected connection: ${options.host}`);
    assert.equal(typeof options.lookup, 'function', 'Must pin DNS on the agent');
    const pinnedLookup = options.lookup;
    return createConnection.call(this, {
      ...options,
      lookup(hostname, opts, done) {
        pinnedLookup(hostname, opts, (err, address, family) => {
          assert.ifError(err);
          const selected = opts.all ? address[0] : { address, family };
          assert.deepEqual(selected, { address: PUBLIC_IP, family: 4 });
          connections.push({ hostname, ...selected });
          if (opts.all) done(null, [{ address: '127.0.0.1', family: 4 }]);
          else done(null, '127.0.0.1', 4);
        });
      }
    }, callback);
  });
  return { lookups, connections };
}
