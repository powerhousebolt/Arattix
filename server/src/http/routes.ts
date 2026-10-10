import crypto from 'node:crypto';
import dns from 'node:dns';
import fs from 'node:fs';
import net from 'node:net';
import { pipeline } from 'node:stream/promises';
import express, { type Response, Router } from 'express';
import mime from 'mime-types';
import type { Capabilities, Capability } from '../arattai/gateway';
import type { Config } from '../config';
import { AppError, Errors } from '../errors';
import type { ArattaiEvent } from '../events/bus';
import type { CommandOutcome, CommandBus } from '../jobs/commands';
import type {
  BroadcastJob,
  GroupCreateJob,
  GroupMembersJob,
  MediaDownloadResult,
  ReactionJob,
  SendMediaJob,
  SendTextJob,
} from '../jobs/contracts';
import type { MediaSpool } from '../media/spool';
import type { StatusReader } from '../session/status';
import { isPrivateAddress, assertWebhookUrl } from '../webhooks/url-guard';
import { toPublic, type WebhookStore } from '../webhooks/store';
import {
  asyncQuery,
  authSessionSchema,
  broadcastSchema,
  chatParams,
  createGroupSchema,
  fileIdParams,
  groupIdParams,
  groupMembersSchema,
  jobIdParams,
  limitQuery,
  mediaDownloadQuery,
  sendMediaFieldsSchema,
  sendMessageSchema,
  subscribeSchema,
  webhookIdParams,
} from './schemas';
import { idempotencyKey, parse, sanitizeFileName, uploadSingle } from './middleware';

export interface RouteDeps {
  config: Config;
  commands: CommandBus;
  status: StatusReader;
  webhooks: WebhookStore;
  spool: MediaSpool;
  capabilities: Capabilities;
}

function send(res: Response, status: number, data: unknown): void {
  res.status(status).json({ data, requestId: res.locals.requestId });
}

/** 200 with the result when the job finished in time, 202 with a pollable job id otherwise. */
function sendOutcome(res: Response, outcome: CommandOutcome): void {
  if (outcome.status === 'completed') {
    send(res, 200, { jobId: outcome.jobId, status: 'completed', deduplicated: outcome.deduplicated, result: outcome.result });
  } else {
    send(res, 202, {
      jobId: outcome.jobId,
      status: 'queued',
      deduplicated: outcome.deduplicated,
      statusUrl: `/api/v1/jobs/${outcome.jobId}`,
    });
  }
}

/** Strip worker-internal fields (spool paths) from job results shown to clients. */
function publicResult(result: unknown): unknown {
  if (result && typeof result === 'object' && 'spoolPath' in result) {
    const { spoolPath: _p, ...rest } = result as Record<string, unknown>;
    return rest;
  }
  return result;
}

export function apiRouter(deps: RouteDeps): Router {
  const { config, commands, status, webhooks, spool, capabilities } = deps;
  const router = Router();
  const json = express.json({ limit: '256kb', strict: true });
  const outboundOpts = { attempts: config.JOB_ATTEMPTS, backoffMs: config.JOB_BACKOFF_MS };
  const expiresAt = (ttlSeconds?: number) => Date.now() + (ttlSeconds ? ttlSeconds * 1000 : config.MESSAGE_TTL_MS);

  const requireCapability = (cap: Capability) => {
    if (!capabilities[cap]) throw Errors.capabilityUnavailable(cap);
  };

  const requireWorker = async () => {
    const s = await status.read();
    if (!s.workerOnline) {
      throw new AppError({
        status: 503,
        code: 'WORKER_UNAVAILABLE',
        message: 'No worker currently owns the Arattai session',
        retryable: true,
        retryAfterMs: 10_000,
      });
    }
    return s;
  };

  /** Fail fast instead of queueing work that the worker would reject anyway. */
  const requireReady = async () => {
    const s = await requireWorker();
    if (s.state !== 'READY') throw Errors.sessionNotReady(s.state, s.reason);
  };

  // ─── auth ───────────────────────────────────────────────────────────
  router.post('/auth/session', json, async (req, res) => {
    const body = parse(authSessionSchema, req.body ?? undefined);
    await requireWorker();
    const outcome = await commands.submit('control', 'auth.start', { force: body.force }, { wait: true });
    sendOutcome(res, outcome);
  });

  router.get('/auth/status', async (_req, res) => {
    send(res, 200, await status.read());
  });

  router.delete('/auth/session', async (_req, res) => {
    await requireWorker();
    sendOutcome(res, await commands.submit('control', 'auth.logout', {}, { wait: true }));
  });

  router.get('/capabilities', (_req, res) => send(res, 200, capabilities));

  // ─── reads ──────────────────────────────────────────────────────────
  router.get('/chats', async (req, res) => {
    const { limit } = parse(limitQuery(20, 200), req.query);
    requireCapability('chats.read');
    await requireReady();
    sendOutcome(res, await commands.submit('control', 'chats.list', { limit }, { wait: true }));
  });

  router.get('/chats/:chatId/messages', async (req, res) => {
    const { chatId } = parse(chatParams, req.params);
    const { limit } = parse(limitQuery(20, 100), req.query);
    requireCapability('chats.read');
    await requireReady();
    sendOutcome(res, await commands.submit('control', 'messages.list', { chatId, limit }, { wait: true }));
  });

  router.get('/media/:fileId', async (req, res) => {
    const { fileId } = parse(fileIdParams, req.params);
    const { chatId, thumbnail } = parse(mediaDownloadQuery, req.query);
    requireCapability('media.download');
    await requireReady();
    const outcome = await commands.submit('control', 'media.download', { fileId, chatId, thumbnail }, { wait: true });
    if (outcome.status !== 'completed') {
      throw new AppError({ status: 504, code: 'DOWNLOAD_TIMEOUT', message: 'Media download did not finish in time', retryable: true });
    }
    const media = outcome.result as MediaDownloadResult;
    const file = spool.resolve(media.spoolPath);
    const name = sanitizeFileName(media.fileName ?? fileId);
    res.setHeader('Content-Type', media.contentType || 'application/octet-stream');
    res.setHeader('Content-Length', String(media.size));
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    try {
      await pipeline(fs.createReadStream(file), res);
    } finally {
      await spool.remove(file);
    }
  });

  // ─── messaging ──────────────────────────────────────────────────────
  router.post('/messages/send', json, async (req, res) => {
    const body = parse(sendMessageSchema, req.body);
    const { async } = parse(asyncQuery, req.query);
    const key = idempotencyKey(req);

    if (body.type === 'reaction') {
      requireCapability('messages.reaction');
      await requireReady();
      const data: ReactionJob = { chatId: body.chatId, messageId: body.messageId, emoji: body.emoji, expiresAt: expiresAt(body.ttlSeconds) };
      return sendOutcome(res, await commands.submit('outbound', 'message.reaction', data, { ...outboundOpts, wait: !async, idempotencyKey: key }));
    }

    requireCapability('messages.text');
    await requireReady();
    const data: SendTextJob = {
      chatId: body.chatId,
      text: body.text,
      ...(body.displayName ? { displayName: body.displayName } : {}),
      expiresAt: expiresAt(body.ttlSeconds),
    };
    sendOutcome(res, await commands.submit('outbound', 'message.text', data, { ...outboundOpts, wait: !async, idempotencyKey: key }));
  });

  router.post('/messages/media', uploadSingle(spool.dir, config.MEDIA_MAX_BYTES), async (req, res) => {
    const file = req.file;
    try {
      if (!file) throw Errors.validation([{ path: 'file', message: 'a multipart "file" part is required', code: 'required' }]);
      if (file.size === 0) throw Errors.validation([{ path: 'file', message: 'file is empty', code: 'too_small' }]);
      const fields = parse(sendMediaFieldsSchema, req.body);
      const { async } = parse(asyncQuery, req.query);
      const key = idempotencyKey(req);
      requireCapability('messages.media');
      await requireReady();

      const fileName = sanitizeFileName(file.originalname);
      const declared = file.mimetype && file.mimetype !== 'application/octet-stream' ? file.mimetype : null;
      const mimeType = fields.mimeType ?? (mime.lookup(fileName) || declared || 'application/octet-stream');
      const data: SendMediaJob = {
        chatId: fields.chatId,
        spoolPath: file.path,
        fileName,
        mimeType,
        size: file.size,
        ...(fields.caption ? { caption: fields.caption } : {}),
        expiresAt: expiresAt(fields.ttlSeconds),
      };
      const outcome = await commands.submit('outbound', 'message.media', data, { ...outboundOpts, wait: !async, idempotencyKey: key });
      // A replayed Idempotency-Key points at the original job and its own spooled file.
      if (outcome.deduplicated) await spool.remove(file.path);
      sendOutcome(res, outcome);
    } catch (err) {
      // Anything thrown here means no job will ever read this file.
      if (file) await spool.remove(file.path);
      throw err;
    }
  });

  // ─── groups ─────────────────────────────────────────────────────────
  router.post('/groups/create', json, async (req, res) => {
    const body = parse(createGroupSchema, req.body);
    const { async } = parse(asyncQuery, req.query);
    requireCapability('groups.create');
    await requireReady();
    const data: GroupCreateJob = { ...body, expiresAt: expiresAt() };
    sendOutcome(res, await commands.submit('outbound', 'groups.create', data, { ...outboundOpts, wait: !async, idempotencyKey: idempotencyKey(req) }));
  });

  router.put('/groups/:id/members', json, async (req, res) => {
    const { id } = parse(groupIdParams, req.params);
    const body = parse(groupMembersSchema, req.body);
    const { async } = parse(asyncQuery, req.query);
    requireCapability('groups.members');
    await requireReady();
    const data: GroupMembersJob = { groupId: id, action: body.action, userIds: body.userIds, expiresAt: expiresAt() };
    sendOutcome(res, await commands.submit('outbound', 'groups.members', data, { ...outboundOpts, wait: !async, idempotencyKey: idempotencyKey(req) }));
  });

  // ─── channels & broadcasts ──────────────────────────────────────────
  const broadcastBody = broadcastSchema(config.BROADCAST_MAX_RECIPIENTS, config.BROADCAST_MIN_CHUNK_DELAY_MS);

  router.post('/channels/broadcast', json, async (req, res) => {
    const body = parse(broadcastBody, req.body);
    requireCapability('messages.text');
    await requireReady();
    const data: BroadcastJob = body;
    const outcome = await commands.submit('broadcast', 'broadcast', data, { wait: false, attempts: 1, idempotencyKey: idempotencyKey(req) });
    const chunks = Math.ceil(body.recipients.length / body.chunkSize);
    send(res, 202, {
      broadcastId: outcome.jobId,
      status: 'queued',
      deduplicated: outcome.deduplicated,
      total: body.recipients.length,
      chunks,
      estimatedMinDurationMs: (chunks - 1) * body.chunkDelayMs,
      statusUrl: `/api/v1/channels/broadcast/${outcome.jobId}`,
    });
  });

  router.get('/channels/broadcast/:id', async (req, res) => {
    const { id } = parse(jobIdParams, req.params);
    if (!id.startsWith('bc_')) throw Errors.notFound('Broadcast');
    const job = await commands.getJob(id);
    if (!job) throw Errors.notFound('Broadcast');
    send(res, 200, job);
  });

  // ─── jobs ───────────────────────────────────────────────────────────
  router.get('/jobs/:id', async (req, res) => {
    const { id } = parse(jobIdParams, req.params);
    const job = await commands.getJob(id);
    if (!job) throw Errors.notFound('Job');
    send(res, 200, { ...job, ...('result' in job ? { result: publicResult(job.result) } : {}) });
  });

  // ─── webhooks ───────────────────────────────────────────────────────
  const urlPolicy = { allowHttp: config.WEBHOOK_ALLOW_HTTP, allowPrivate: config.WEBHOOK_ALLOW_PRIVATE };

  router.post('/webhooks/subscribe', json, async (req, res) => {
    const body = parse(subscribeSchema, req.body);
    const url = assertWebhookUrl(body.url, urlPolicy);
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (!urlPolicy.allowPrivate && !net.isIP(host)) {
      // Early feedback only; the authoritative check runs on every delivery's socket.
      const addrs = await dns.promises.lookup(host, { all: true }).catch(() => {
        throw new AppError({ status: 400, code: 'WEBHOOK_URL_UNRESOLVABLE', message: `Cannot resolve ${host}` });
      });
      if (addrs.some((a) => isPrivateAddress(a.address))) {
        throw new AppError({ status: 400, code: 'WEBHOOK_URL_REJECTED', message: 'Webhook URL resolves to a private address' });
      }
    }
    const { subscription, secret } = await webhooks.create({
      url: url.toString(),
      events: body.events,
      ...(body.description ? { description: body.description } : {}),
      ...(body.secret ? { secret: body.secret } : {}),
    });
    send(res, 201, { ...toPublic(subscription), secret });
  });

  router.get('/webhooks', async (_req, res) => {
    send(res, 200, (await webhooks.list()).map(toPublic));
  });

  router.get('/webhooks/:id', async (req, res) => {
    const { id } = parse(webhookIdParams, req.params);
    const sub = await webhooks.get(id);
    if (!sub) throw Errors.notFound('Webhook subscription');
    send(res, 200, toPublic(sub));
  });

  router.delete('/webhooks/:id', async (req, res) => {
    const { id } = parse(webhookIdParams, req.params);
    if (!(await webhooks.delete(id))) throw Errors.notFound('Webhook subscription');
    send(res, 200, { id, deleted: true });
  });

  router.post('/webhooks/:id/test', async (req, res) => {
    const { id } = parse(webhookIdParams, req.params);
    const sub = await webhooks.get(id);
    if (!sub) throw Errors.notFound('Webhook subscription');
    if (!sub.active) {
      throw new AppError({ status: 409, code: 'WEBHOOK_INACTIVE', message: 'Subscription is disabled', details: { reason: sub.disabledReason } });
    }
    const event: ArattaiEvent = {
      id: `evt_${crypto.randomUUID().replace(/-/g, '')}`,
      type: 'webhook.test',
      sessionId: config.SESSION_ID,
      occurredAt: new Date().toISOString(),
      data: { message: 'Test delivery from arattix-server', subscriptionId: id },
    };
    const outcome = await commands.submit('webhooks', 'deliver', { subscriptionId: id, event }, { wait: true, attempts: 1 });
    if (outcome.status !== 'completed') return sendOutcome(res, outcome);
    send(res, 200, { jobId: outcome.jobId, eventId: event.id, delivered: true, result: outcome.result });
  });

  return router;
}
