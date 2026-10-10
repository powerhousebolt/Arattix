import fs from 'node:fs';
import { ARATTIX_CAPABILITIES } from '../../src/arattai/arattix-gateway';
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
} from '../../src/arattai/gateway';
import { Errors } from '../../src/errors';

/** Scriptable in-memory Arattai used by every test that does not exercise the real library. */
export class FakeGateway implements ArattaiGateway {
  capabilities: Capabilities = { ...ARATTIX_CAPABILITIES };
  hasClient = false;
  restoredFrom: SessionSnapshot | null = null;
  cookieVersion = 1;
  /** Override to make validate() fail (throw) for restore and heartbeats. */
  validateImpl: () => Promise<void> = async () => {};
  validateCalls = 0;
  /** Sequence of pollQr outcomes; 'pending' once exhausted. */
  qrScript: Array<'pending' | 'refreshed' | 'authenticated' | Error> = [];
  qrIssued = 0;
  startQrImpl: (() => Promise<void>) | null = null;
  chats: ChatSummary[] = [];
  messages: Record<string, ArattaiMessage[]> = {};
  sent: Array<{ chatId: string; text: string; displayName?: string }> = [];
  media: Array<SendMediaInput & { bytes: number }> = [];
  sendImpl: ((chatId: string, text: string) => Promise<unknown>) | null = null;
  listChatsImpl: (() => Promise<ChatSummary[]>) | null = null;

  async restore(snapshot: SessionSnapshot): Promise<void> {
    this.hasClient = true;
    this.restoredFrom = snapshot;
  }

  snapshot(): SessionSnapshot {
    if (!this.hasClient) throw Errors.sessionNotReady('DISCONNECTED', 'NO_CLIENT');
    return {
      cookies: { fake: this.cookieVersion },
      userAgent: 'fake-agent',
      authenticatedAt: '2026-01-01T00:00:00.000Z',
      savedAt: new Date().toISOString(),
    };
  }

  async validate(): Promise<void> {
    this.validateCalls += 1;
    await this.validateImpl();
  }

  async startQr(): Promise<QrChallenge> {
    if (this.startQrImpl) await this.startQrImpl();
    this.hasClient = true;
    this.qrIssued += 1;
    return { data: `https://oneauth.example/qr/${this.qrIssued}`, issuedAt: new Date().toISOString() };
  }

  async pollQr(): Promise<QrPollResult> {
    const next = this.qrScript.shift() ?? 'pending';
    if (next instanceof Error) throw next;
    if (next === 'refreshed') {
      this.qrIssued += 1;
      return { status: 'refreshed', challenge: { data: `https://oneauth.example/qr/${this.qrIssued}`, issuedAt: new Date().toISOString() } };
    }
    return { status: next };
  }

  async completeLogin(): Promise<void> {}

  reset(): void {
    this.hasClient = false;
  }

  async listChats(limit: number): Promise<ChatSummary[]> {
    if (this.listChatsImpl) return this.listChatsImpl();
    return this.chats.slice(0, limit);
  }

  async fetchMessages(chatId: string, limit: number): Promise<ArattaiMessage[]> {
    return (this.messages[chatId] ?? []).slice(-limit);
  }

  async sendText(chatId: string, text: string, displayName?: string): Promise<unknown> {
    if (this.sendImpl) return this.sendImpl(chatId, text);
    this.sent.push({ chatId, text, ...(displayName ? { displayName } : {}) });
    return { status: 'ok', msgid: String(this.sent.length) };
  }

  async sendMedia(input: SendMediaInput): Promise<unknown> {
    const bytes = (await fs.promises.readFile(input.filePath)).length;
    this.media.push({ ...input, bytes });
    return { status: 'uploaded' };
  }

  async downloadMedia(fileId: string): Promise<DownloadedMedia> {
    return { data: Buffer.from(`content-of-${fileId}`), contentType: 'text/plain', fileName: `${fileId}.txt` };
  }

  async react(): Promise<unknown> {
    throw Errors.capabilityUnavailable('messages.reaction');
  }

  async createGroup(): Promise<unknown> {
    throw Errors.capabilityUnavailable('groups.create');
  }

  async updateGroupMembers(_g: string, _a: GroupMemberAction): Promise<unknown> {
    throw Errors.capabilityUnavailable('groups.members');
  }
}

export function message(id: string, text: string, extra: Partial<ArattaiMessage> = {}): ArattaiMessage {
  return { id, type: 'text', text, sender: { id: 'u1', name: 'Alice' }, timestamp: null, media: null, raw: { id, text }, ...extra };
}

export function chat(chatId: string, lastMessageId: string | null, title = chatId): ChatSummary {
  return { chatId, title, lastMessageId, lastMessagePreview: null, owner: null, participants: [] };
}
