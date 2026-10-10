import { hmacSha256Hex, safeEqual } from '../crypto';

export const SIGNATURE_HEADER = 'X-Arattai-Signature';

/**
 * `X-Arattai-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>`
 * The timestamp is signed too, so a captured delivery cannot be replayed outside the tolerance.
 */
export function signPayload(secret: string, body: string, timestampSec = Math.floor(Date.now() / 1000)): string {
  return `t=${timestampSec},v1=${hmacSha256Hex(secret, `${timestampSec}.${body}`)}`;
}

/** Reference verifier for receivers (the same logic is shown in the README in plain Node). */
export function verifySignature(
  secret: string,
  header: string | undefined,
  rawBody: string,
  { toleranceSec = 300, nowSec = Math.floor(Date.now() / 1000) } = {},
): boolean {
  if (!header) return false;
  const parts = Object.fromEntries(
    header.split(',').map((p) => {
      const i = p.indexOf('=');
      return [p.slice(0, i).trim(), p.slice(i + 1).trim()];
    }),
  );
  const t = Number(parts.t);
  if (!Number.isInteger(t) || !parts.v1) return false;
  if (Math.abs(nowSec - t) > toleranceSec) return false;
  return safeEqual(hmacSha256Hex(secret, `${t}.${rawBody}`), parts.v1);
}
