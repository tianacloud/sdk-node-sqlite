import test from 'node:test';
import assert from 'node:assert/strict';
import { gatewayAddress } from '../examples/gateway-address.mjs';

test('gateway address: optional, hostname, IPv4 and bracketed IPv6', () => {
  assert.equal(gatewayAddress(undefined), undefined);
  for (const [input, host, port] of [
    ['localhost:443', 'localhost', 443], ['127.0.0.1:8443', '127.0.0.1', 8443],
    ['[::1]:1', '::1', 1], ['[2001:db8::1]:65535', '2001:db8::1', 65535],
  ]) assert.deepEqual(gatewayAddress(input), { host, port });
});

test('gateway address rejects ambiguous or invalid authority syntax', () => {
  for (const input of ['', 'localhost', 'host:', ':443', 'host:0', 'host:65536',
    'host:0443', 'host:-1', 'host:1e3', 'host:1.5', 'host:NaN', 'host:443 ',
    ' host:443', 'https://host:443', 'user@host:443', 'host:443/path',
    'host:443\n', 'host:443\r\n', 'host:443?query', 'host:443#fragment', '::1:443', '[host]:443', '[::1]']) {
    assert.throws(() => gatewayAddress(input), /TIANA_GATEWAY_ADDRESS/);
  }
});
