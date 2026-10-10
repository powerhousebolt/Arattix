import fs from 'node:fs';
import { ArattixBot, Bot, Defaults, QRLogin, type ArattixSession } from 'arattix';
import type { AxiosResponse } from 'axios';
import { AppError, AuthExpiredError, Errors, UpstreamContractError } from '../errors';
import type { CircuitBreaker } from '../circuit-breaker';
import type { Logger } from '../logger';
import type { Metrics } from '../metrics';
import { classifyUpstreamError, countsAgainstCircuit, looksLikeLoginPage } from './classify';
import { parseChatList, parseMessages } from './normalize';
import type {
  ArattaiGateway,
  ArattaiMessage,
  Capabilities,
  ChatSummary,
  DownloadedMedia,
  GroupMemberAction,
  QrChallenge,
  QrPollResult,
  SendMediaInput,
  SessionSnapshot,
} from './gateway';

/**
 * What the arattix fork can actually do today. Reactions and group management have no
 * known web-client endpoint in the library; flip a flag only together with a verified
 * implementation of the matching method below.
 */
export const ARATTIX_CAPABILITIES: Capabilities = Object.freeze({
  'messages.text': true,
  'messages.media': true,
  'messages.reaction': false,
  'chats.read': true,
  'media.download': true,
  'groups.create': false,
  'groups.members': false,
  'events.polling': true,
});

/** Redirect targets that mean "not logged in". */
const LOGIN_LOCATION = /accounts\.|signin|login/i;

export interface ArattixGatewayOptions {
  breaker: CircuitBreaker;
  logger: Logger;
  metrics: Metrics;
  userAgent?: string;
}

export class ArattixGateway implements ArattaiGateway {
  readonly capabilities = ARATTIX_CAPABILITIES;
  private session: ArattixSession | null = null;
  private bot: Bot | null = null;
  private qr: QRLogin | null = null;
  private authenticatedAt: string | null = null;
  private readonly userAgent: string;

  constructor(private readonly opts: ArattixGatewayOptions) {
    this.userAgent = opts.userAgent ?? Defaults.DEFAULT_USER_AGENT;
  }

  // ─── session lifecycle ──────────────────────────────────────────────

  async restore(snapshot: SessionSnapshot): Promise<void> {
    const { session, bot } = this.freshClient();
    const Jar = session.defaults.jar.constructor;
    try {
      session.defaults.jar = Jar.deserializeSync(snapshot.cookies);
    } catch (err) {
      throw new AppError({ status: 500, code: 'SESSION_CORRUPT', message: 'Stored cookie jar could not be deserialised', cause: err });
    }
    session.defaults.headers.common['User-Agent'] = snapshot.userAgent || this.userAgent;
    this.session = session;
    this.bot = bot;
    this.qr = null;
    this.authenticatedAt = snapshot.authenticatedAt;
    await this.call('setupCsrf', true, () => bot.setupCsrf());
  }

  snapshot(): SessionSnapshot {
    const session = this.requireSession();
    const now = new Date().toISOString();
    return {
      cookies: session.defaults.jar.serializeSync(),
      userAgent: String(session.defaults.headers.common['User-Agent'] ?? this.userAgent),
      authenticatedAt: this.authenticatedAt ?? now,
      savedAt: now,
    };
  }

  async validate(): Promise<void> {
    const session = this.requireSession();
    await this.call('validate', true, async () => {
      // The library's own validity signal: the web root redirects to accounts.* when logged out.
      const root = await session.get(`${Defaults.WEB_BASE_URL}/`, {
        maxRedirects: 0,
        validateStatus: () => true,
        responseType: 'text',
      });
      this.inspect(root, 'validate');

      const chats = await session.get(Defaults.CHAT_API, {
        params: { pinned: 'false', limit: 1, fromtime: '-1', nocache: Date.now() },
        maxRedirects: 0,
        validateStatus: () => true,
      });
      this.inspect(chats, 'validate');
      if (chats.status >= 300 || looksLikeLoginPage(chats.data)) {
        throw new AuthExpiredError('Chat API did not return data for the stored session');
      }
      parseChatList(chats.data); // throws UpstreamContractError when the shape changed
    });
  }

  async startQr(): Promise<QrChallenge> {
    const { session, bot } = this.freshClient();
    this.session = session;
    this.bot = bot;
    this.authenticatedAt = null;
    const qr = new QRLogin(session, { showQr: false });
    this.qr = qr;
    await this.call('startQr', true, () => qr.requestQrData());
    return this.challenge();
  }

  async pollQr(): Promise<QrPollResult> {
    const qr = this.qr;
    if (!qr) throw new AppError({ status: 409, code: 'QR_NOT_STARTED', message: 'No QR login in progress' });
    const status = await this.call('pollQr', true, () => qr.pollOnce());
    return status === 'refreshed' ? { status, challenge: this.challenge() } : { status };
  }

  async completeLogin(): Promise<void> {
    const bot = this.requireBot();
    await this.call('completeLogin', true, () => bot.setupCsrf());
    this.qr = null;
    this.authenticatedAt = new Date().toISOString();
    await this.validate();
  }

  reset(): void {
    this.session = null;
    this.bot = null;
    this.qr = null;
    this.authenticatedAt = null;
  }

  // ─── reads ──────────────────────────────────────────────────────────

  async listChats(limit: number): Promise<ChatSummary[]> {
    const bot = this.requireBot();
    const body = await this.call('listChats', true, () => bot.fetchChatsRaw({ limit }));
    if (looksLikeLoginPage(body)) throw new AuthExpiredError('Chat list returned the login page');
    return parseChatList(body);
  }

  async fetchMessages(chatId: string, limit: number): Promise<ArattaiMessage[]> {
    const session = this.requireSession();
    // Not bot.fetchMessages(): it turns a login-page response into [] and hides an expired session.
    const resp = await this.call('fetchMessages', true, () =>
      session.get(Defaults.MESSAGES_API(chatId), {
        params: { limit, nocache: Date.now() },
        timeout: Defaults.DEFAULT_TIMEOUT,
      }),
    );
    if (looksLikeLoginPage(resp.data)) throw new AuthExpiredError('Messages API returned the login page');
    return parseMessages(resp.data);
  }

  async downloadMedia(fileId: string, chatId: string, thumbnail: boolean): Promise<DownloadedMedia> {
    const bot = this.requireBot();
    return this.call('downloadMedia', true, () => bot.downloadMedia(fileId, chatId, { thumbnail }));
  }

  // ─── writes ─────────────────────────────────────────────────────────

  async sendText(chatId: string, text: string, displayName?: string): Promise<unknown> {
    const bot = this.requireBot();
    const data = await this.call('sendText', false, () =>
      bot.sender.sendMessage(text, { chatId, ...(displayName ? { dname: displayName } : {}) }),
    );
    if (looksLikeLoginPage(data)) throw new AuthExpiredError('Send returned the login page; the message was not sent');
    return data;
  }

  async sendMedia(input: SendMediaInput): Promise<unknown> {
    const bot = this.requireBot();
    const stat = await fs.promises.stat(input.filePath).catch(() => null);
    if (!stat || stat.size !== input.size) {
      throw new AppError({
        status: 500,
        code: 'MEDIA_SPOOL_MISSING',
        message: 'Spooled upload is missing or truncated; was MEDIA spool shared with the worker?',
      });
    }
    const stream = fs.createReadStream(input.filePath);
    try {
      const data = await this.call('sendMedia', false, () =>
        bot.sender.sendStream(stream, input.fileName, {
          chatId: input.chatId,
          size: input.size,
          mimeType: input.mimeType,
          caption: input.caption ?? '',
        }),
      );
      if (looksLikeLoginPage(data)) throw new AuthExpiredError('Upload returned the login page; the file was not sent');
      return data;
    } finally {
      stream.destroy();
    }
  }

  async react(): Promise<unknown> {
    throw Errors.capabilityUnavailable('messages.reaction');
  }

  async createGroup(): Promise<unknown> {
    throw Errors.capabilityUnavailable('groups.create');
  }

  async updateGroupMembers(_groupId: string, _action: GroupMemberAction): Promise<unknown> {
    throw Errors.capabilityUnavailable('groups.members');
  }

  // ─── internals ──────────────────────────────────────────────────────

  private freshClient(): { session: ArattixSession; bot: Bot } {
    const client = new ArattixBot({ isShowQr: false });
    client.session.defaults.headers.common['User-Agent'] = this.userAgent;
    return { session: client.session, bot: new Bot(client.session) };
  }

  private requireSession(): ArattixSession {
    if (!this.session) throw Errors.sessionNotReady('DISCONNECTED', 'NO_CLIENT');
    return this.session;
  }

  private requireBot(): Bot {
    if (!this.bot) throw Errors.sessionNotReady('DISCONNECTED', 'NO_CLIENT');
    return this.bot;
  }

  private challenge(): QrChallenge {
    const data = this.qr?.qrResp?.qrcodeauth?.oneauth_url;
    if (typeof data !== 'string' || data.length === 0) {
      throw new UpstreamContractError('startQr', 'missing qrcodeauth.oneauth_url in QR response');
    }
    return { data, issuedAt: new Date().toISOString() };
  }

  /** Turn a non-throwing response (validateStatus: () => true) into the error model. */
  private inspect(resp: AxiosResponse, operation: string): void {
    const { status } = resp;
    if (status >= 300 && status < 400) {
      const location = String(resp.headers?.location ?? '');
      if (LOGIN_LOCATION.test(location)) throw new AuthExpiredError(`Redirected to login during ${operation}`);
      return;
    }
    if (status >= 400) {
      throw classifyUpstreamError({ response: { status, headers: resp.headers as Record<string, unknown> } }, operation, true);
    }
  }

  private async call<T>(operation: string, idempotent: boolean, fn: () => Promise<T>): Promise<T> {
    try {
      return await this.opts.breaker.exec(async () => {
        try {
          return await fn();
        } catch (err) {
          throw classifyUpstreamError(err, operation, idempotent);
        }
      }, countsAgainstCircuit);
    } catch (err) {
      const code = err instanceof AppError ? err.code : 'UNKNOWN';
      this.opts.metrics.inc('arattai_upstream_errors_total', 'Failed calls to Arattai by operation and error code.', {
        operation,
        code,
      });
      if (code === 'UPSTREAM_CONTRACT_CHANGED') {
        this.opts.logger.error('Arattai response contract changed', { component: 'gateway', operation, err });
      }
      throw err;
    }
  }
}

/**
 * Apply ARATTAI_ENDPOINT_OVERRIDES to the library's Defaults so a moved endpoint can be
 * re-pointed by configuration. Function-valued keys take a template with {chatId} / {fileId}.
 */
export function applyEndpointOverrides(json: string | undefined, logger: Logger): void {
  if (!json) return;
  let overrides: unknown;
  try {
    overrides = JSON.parse(json);
  } catch {
    throw new Error('ARATTAI_ENDPOINT_OVERRIDES is not valid JSON');
  }
  if (typeof overrides !== 'object' || overrides === null || Array.isArray(overrides)) {
    throw new Error('ARATTAI_ENDPOINT_OVERRIDES must be a JSON object');
  }
  const target = Defaults as Record<string, unknown>;
  for (const [key, value] of Object.entries(overrides)) {
    const current = target[key];
    if (current === undefined) throw new Error(`ARATTAI_ENDPOINT_OVERRIDES: unknown key ${key}`);
    if (typeof current === 'function') {
      if (typeof value !== 'string') throw new Error(`ARATTAI_ENDPOINT_OVERRIDES: ${key} needs a URL template string`);
      target[key] = (id: string) => value.replace(/\{(chatId|fileId)\}/g, encodeURIComponent(id));
    } else if (typeof current === typeof value) {
      target[key] = value;
    } else {
      throw new Error(`ARATTAI_ENDPOINT_OVERRIDES: ${key} must be a ${typeof current}`);
    }
    logger.warn('Arattai endpoint overridden by configuration', { component: 'gateway', key, value });
  }
}
