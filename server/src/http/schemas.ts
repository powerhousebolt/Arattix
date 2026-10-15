import { z } from 'zod';
import { EVENT_TYPES } from '../events/bus';

/**
 * Arattai chat ids are opaque; bound them and refuse characters that never appear in ids.
 * Ids end up in upstream URL paths, so "." and ".." (path segments) are refused too.
 */
const id = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_.:@-]+$/, 'must contain only letters, digits and _ . : @ -')
  .refine((v) => !/^\.+$/.test(v), 'must not consist of dots only');

const displayName = z.string().trim().min(1).max(100);
const ttlSeconds = z.coerce.number().int().min(5).max(24 * 60 * 60);

export const sendMessageSchema = z.preprocess(
  (body) => (body && typeof body === 'object' && !('type' in body) ? { ...body, type: 'text' } : body),
  z.discriminatedUnion('type', [
    z.object({
      type: z.literal('text'),
      chatId: id,
      text: z.string().max(10_000).refine((t) => t.trim().length > 0, 'must not be blank'),
      displayName: displayName.optional(),
      ttlSeconds: ttlSeconds.optional(),
    }),
    z.object({
      type: z.literal('reaction'),
      chatId: id,
      messageId: id,
      emoji: z.string().min(1).max(16),
      ttlSeconds: ttlSeconds.optional(),
    }),
  ]),
);

export const sendMediaFieldsSchema = z.object({
  chatId: id,
  caption: z.string().max(4_000).optional(),
  /** Overrides extension-based detection, e.g. "audio/ogg". */
  mimeType: z
    .string()
    .regex(/^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/i, 'must be a MIME type like image/png')
    .optional(),
  ttlSeconds: ttlSeconds.optional(),
});

export const createGroupSchema = z.object({
  name: z.string().trim().min(1).max(100),
  participants: z
    .array(id)
    .min(1)
    .max(256)
    .refine((a) => new Set(a).size === a.length, 'participants must be unique'),
  description: z.string().max(500).optional(),
});

export const groupMembersSchema = z
  .object({
    action: z.enum(['add', 'remove', 'promote', 'demote', 'transfer_ownership']),
    userIds: z
      .array(id)
      .min(1)
      .max(256)
      .refine((a) => new Set(a).size === a.length, 'userIds must be unique'),
  })
  .refine((b) => b.action !== 'transfer_ownership' || b.userIds.length === 1, {
    message: 'transfer_ownership takes exactly one user id',
    path: ['userIds'],
  });

export const groupIdParams = z.object({ id });

export function broadcastSchema(maxRecipients: number, minChunkDelayMs: number) {
  return z.object({
    recipients: z
      .array(id)
      .min(1)
      .max(maxRecipients)
      .transform((a) => [...new Set(a)]),
    text: z.string().max(10_000).refine((t) => t.trim().length > 0, 'must not be blank'),
    displayName: displayName.optional(),
    chunkSize: z.number().int().min(1).max(50).default(10),
    chunkDelayMs: z
      .number()
      .int()
      .min(minChunkDelayMs)
      .max(60 * 60 * 1000)
      .default(Math.max(minChunkDelayMs, 30_000)),
  });
}

export const authSessionSchema = z
  .object({ force: z.boolean().default(false) })
  .default({ force: false });

export const limitQuery = (fallback: number, max: number) =>
  z.object({ limit: z.coerce.number().int().min(1).max(max).default(fallback) });

export const chatParams = z.object({ chatId: id });

export const mediaDownloadQuery = z.object({
  chatId: id,
  thumbnail: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
});

export const fileIdParams = z.object({ fileId: id });

export const asyncQuery = z.object({
  async: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
});

export const subscribeSchema = z.object({
  url: z.string().min(1).max(2_048),
  events: z
    .array(z.enum([...EVENT_TYPES, '*']))
    .min(1)
    .default(['*']),
  description: z.string().max(500).optional(),
  /** Bring your own signing secret; otherwise one is generated and returned once. */
  secret: z.string().min(16).max(256).optional(),
});

export const webhookIdParams = z.object({ id: z.string().regex(/^wh_[a-f0-9]{32}$/, 'must be a webhook id') });

export const jobIdParams = z.object({ id: z.string().min(3).max(200) });

export const idempotencyKeyHeader = z.string().min(1).max(200).optional();
