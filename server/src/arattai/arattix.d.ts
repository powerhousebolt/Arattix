/** Type declarations for the parts of the (untyped, CommonJS) arattix library this server uses. */
declare module 'arattix' {
  import type { AxiosInstance } from 'axios';
  import type { Readable } from 'node:stream';

  export interface CookieJarLike {
    serializeSync(): unknown;
    getCookies(url: string): Promise<Array<{ key: string; value: string }>>;
    constructor: { deserializeSync(serialized: unknown): CookieJarLike };
  }

  export type ArattixSession = AxiosInstance & {
    defaults: AxiosInstance['defaults'] & { jar: CookieJarLike };
  };

  export class ArattixBot {
    constructor(options?: { isShowQr?: boolean; proxy?: string | null });
    session: ArattixSession;
    loginWithQr(): Promise<Bot>;
  }

  export interface QrAuthResponse {
    qrcodeauth?: { token?: string; oneauth_url?: string };
    [key: string]: unknown;
  }

  export class QRLogin {
    constructor(session: ArattixSession, options?: { showQr?: boolean });
    qrResp: QrAuthResponse | null;
    requestQrData(): Promise<QrAuthResponse>;
    pollOnce(): Promise<'pending' | 'refreshed' | 'authenticated'>;
  }

  export interface SendTarget {
    chatId: string;
    dname?: string;
  }

  export class MessageSender {
    constructor(session: ArattixSession);
    sendMessage(message: string, options: SendTarget): Promise<unknown>;
    sendStream(
      stream: Readable,
      fileName: string,
      options: SendTarget & { size: number; mimeType?: string; caption?: string },
    ): Promise<unknown>;
  }

  export class Bot {
    constructor(session: ArattixSession);
    session: ArattixSession;
    readonly sender: MessageSender;
    setupCsrf(): Promise<void>;
    fetchChatsRaw(options?: { limit?: number }): Promise<unknown>;
    downloadMedia(
      fileId: string,
      chatId: string,
      options?: { thumbnail?: boolean },
    ): Promise<{ data: Buffer; contentType: string; fileName: string | null }>;
  }

  export const Defaults: Record<string, unknown> & {
    WEB_BASE_URL: string;
    CHAT_API: string;
    MESSAGES_API: (chatId: string) => string;
    DEFAULT_USER_AGENT: string;
    DEFAULT_TIMEOUT: number;
  };
}
