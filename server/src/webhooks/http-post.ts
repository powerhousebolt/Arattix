import http from 'node:http';
import https from 'node:https';
import { guardedLookup } from './url-guard';

export interface PostResult {
  status: number;
  /** First bytes of the response body, for diagnostics only. */
  bodySnippet: string;
}

const MAX_SNIPPET = 1024;

/**
 * POST a JSON body without following redirects (a redirect could point at a private address).
 * Resolves for any HTTP status; rejects on network errors and timeouts.
 */
export function postJson(
  url: URL,
  body: string,
  headers: Record<string, string>,
  opts: { timeoutMs: number; allowPrivate: boolean },
): Promise<PostResult> {
  const client = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = client.request(
      url,
      {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        lookup: guardedLookup(opts.allowPrivate) as unknown as typeof import('node:dns').lookup,
        timeout: opts.timeoutMs,
        agent: false,
      },
      (res) => {
        let snippet = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          if (snippet.length < MAX_SNIPPET) snippet += chunk.slice(0, MAX_SNIPPET - snippet.length);
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, bodySnippet: snippet }));
        res.on('error', reject);
      },
    );
    // Hard deadline for the whole exchange, not just socket idleness.
    const deadline = setTimeout(() => req.destroy(Object.assign(new Error('Webhook request timed out'), { code: 'ETIMEDOUT' })), opts.timeoutMs);
    req.on('timeout', () => req.destroy(Object.assign(new Error('Webhook request timed out'), { code: 'ETIMEDOUT' })));
    req.on('error', reject);
    req.on('close', () => clearTimeout(deadline));
    req.end(body);
  });
}
