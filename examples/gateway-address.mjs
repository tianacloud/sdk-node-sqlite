import { isIP } from 'node:net';

// Example-only input adapter: the SDK still accepts an explicit gateway object.
export function gatewayAddress(value) {
  if (value === undefined) return undefined;
  const match = /^(?:\[([^\]]+)\]|([^:\s/?#@\[\]]+)):([1-9][0-9]{0,4})$/.exec(value);
  if (!match || match[0] !== value || (match[1] && isIP(match[1]) !== 6) || Number(match[3]) > 65535) {
    throw new Error('TIANA_GATEWAY_ADDRESS must be host:port or [IPv6]:port (1-65535)');
  }
  return { host: match[1] ?? match[2], port: Number(match[3]) };
}
