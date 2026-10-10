/**
 * The boundary between this server and Arattai. Everything above this interface is
 * transport-agnostic; everything below it is allowed to know about cookies, CSRF and URLs.
 * Tests swap in a fake implementation.
 */

export interface SessionSnapshot {
  /** tough-cookie `CookieJar.serializeSync()` output. */
  cookies: unknown;
  userAgent: string;
  authenticatedAt: string;
  savedAt: string;
}

export interface QrChallenge {
  /** The string encoded in the QR code (an Arattai one-auth URL). Treat as a login secret. */
  data: string;
  issuedAt: string;
}

export interface QrPollResult {
  status: 'pending' | 'refreshed' | 'authenticated';
  /** Present when status is 'refreshed'. */
  challenge?: QrChallenge;
}

export interface Participant {
  id: string | null;
  name: string | null;
}

export interface ChatSummary {
  chatId: string;
  title: string | null;
  lastMessageId: string | null;
  lastMessagePreview: string | null;
  owner: Participant | null;
  participants: Participant[];
}

export interface MediaDescriptor {
  fileId: string;
  fileName: string | null;
  mimeType: string;
  size: number | null;
}

export interface ArattaiMessage {
  id: string;
  type: string | null;
  text: string | null;
  sender: Participant | null;
  /** Epoch milliseconds when the upstream payload carries a recognisable timestamp. */
  timestamp: number | null;
  media: MediaDescriptor | null;
  raw: unknown;
}

export interface SendMediaInput {
  chatId: string;
  filePath: string;
  fileName: string;
  mimeType: string;
  size: number;
  caption?: string;
}

export interface DownloadedMedia {
  data: Buffer;
  contentType: string;
  fileName: string | null;
}

export type GroupMemberAction = 'add' | 'remove' | 'promote' | 'demote' | 'transfer_ownership';

/**
 * Operations the API exposes. A capability is `true` only when the gateway has a verified
 * Arattai endpoint for it; the API answers 501 CAPABILITY_UNAVAILABLE for the rest.
 */
export interface Capabilities {
  'messages.text': boolean;
  'messages.media': boolean;
  'messages.reaction': boolean;
  'chats.read': boolean;
  'media.download': boolean;
  'groups.create': boolean;
  'groups.members': boolean;
  'events.polling': boolean;
}

export type Capability = keyof Capabilities;

export interface ArattaiGateway {
  readonly capabilities: Capabilities;

  /** Load a stored session into a fresh client and set up CSRF. Does not validate. */
  restore(snapshot: SessionSnapshot): Promise<void>;
  /** Serialise the current cookies so they can be persisted. */
  snapshot(): SessionSnapshot;
  /**
   * Cheap authenticated probe. Resolves when the session works; throws AuthExpiredError when it
   * does not, and a retryable AppError for transient failures.
   */
  validate(): Promise<void>;

  /** Start a new QR login in a fresh client (drops any current session from memory). */
  startQr(): Promise<QrChallenge>;
  pollQr(): Promise<QrPollResult>;
  /** Called once the QR is approved: switches the client to web-app CSRF and validates. */
  completeLogin(): Promise<void>;
  /** Forget the in-memory session. */
  reset(): void;

  listChats(limit: number): Promise<ChatSummary[]>;
  fetchMessages(chatId: string, limit: number): Promise<ArattaiMessage[]>;
  sendText(chatId: string, text: string, displayName?: string): Promise<unknown>;
  sendMedia(input: SendMediaInput): Promise<unknown>;
  downloadMedia(fileId: string, chatId: string, thumbnail: boolean): Promise<DownloadedMedia>;

  react(chatId: string, messageId: string, emoji: string): Promise<unknown>;
  createGroup(name: string, participantIds: string[], description?: string): Promise<unknown>;
  updateGroupMembers(groupId: string, action: GroupMemberAction, userIds: string[]): Promise<unknown>;
}
