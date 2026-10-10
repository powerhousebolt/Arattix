import dns from 'node:dns';
import net from 'node:net';
import { AppError } from '../errors';

/** Address ranges a webhook must never reach (SSRF into the host, cluster or cloud metadata). */
const blocked = new net.BlockList();
for (const [addr, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 3],
] as const) {
  blocked.addSubnet(addr, prefix, 'ipv4');
}
for (const [addr, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
  ['64:ff9b::', 96],
] as const) {
  blocked.addSubnet(addr, prefix, 'ipv6');
}

export function isPrivateAddress(address: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped) return blocked.check(mapped[1]!, 'ipv4');
  const family = net.isIP(address);
  if (family === 4) return blocked.check(address, 'ipv4');
  if (family === 6) return blocked.check(address, 'ipv6');
  return false;
}

export interface UrlPolicy {
  allowHttp: boolean;
  allowPrivate: boolean;
}

const invalid = (message: string) => new AppError({ status: 400, code: 'WEBHOOK_URL_REJECTED', message });

/** Static checks on a webhook URL. DNS-based checks happen per connection in `guardedLookup`. */
export function assertWebhookUrl(raw: string, policy: UrlPolicy): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw invalid('Webhook URL is not a valid absolute URL');
  }
  if (url.protocol !== 'https:' && !(policy.allowHttp && url.protocol === 'http:')) {
    throw invalid(policy.allowHttp ? 'Webhook URL must use http or https' : 'Webhook URL must use https');
  }
  if (url.username || url.password) throw invalid('Webhook URL must not embed credentials');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!policy.allowPrivate) {
    if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal')) {
      throw invalid('Webhook URL points at a local host');
    }
    if (net.isIP(host) && isPrivateAddress(host)) throw invalid('Webhook URL points at a private address');
  }
  return url;
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void;

/**
 * dns.lookup replacement for outbound webhook sockets. Checking the address the socket really
 * connects to (not a separate pre-flight lookup) closes the DNS-rebinding hole.
 */
export function guardedLookup(allowPrivate: boolean) {
  return (hostname: string, options: dns.LookupOptions, callback: LookupCallback): void => {
    dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return callback(err, []);
      const list = addresses as dns.LookupAddress[];
      if (!allowPrivate) {
        const bad = list.find((a) => isPrivateAddress(a.address));
        if (bad) {
          const e: NodeJS.ErrnoException = new Error(`Webhook host ${hostname} resolves to private address ${bad.address}`);
          e.code = 'EWEBHOOKPRIVATE';
          return callback(e, []);
        }
      }
      if (options.all) return callback(null, list);
      const first = list[0];
      if (!first) return callback(Object.assign(new Error(`No address for ${hostname}`), { code: 'ENOTFOUND' }), []);
      callback(null, first.address, first.family);
    });
  };
}
