import { UpstreamContractError } from '../errors';
import type { ArattaiMessage, ChatSummary, MediaDescriptor, Participant } from './gateway';

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null =>
  typeof v === 'string' ? v : typeof v === 'number' && Number.isFinite(v) ? String(v) : null;

/** Some v1 fields arrive JSON-encoded as strings, others as objects; accept both. */
function maybeJson(v: unknown): unknown {
  if (typeof v !== 'string' || v === '') return v === '' ? null : v;
  try {
    return JSON.parse(v);
  } catch {
    return null;
  }
}

function participant(v: unknown, idKey: string, nameKey: string): Participant | null {
  if (!isObj(v)) return null;
  return { id: str(v[idKey]), name: str(v[nameKey]) };
}

/** Parse a `GET /v1/chats` body. Throws UpstreamContractError when the envelope is unrecognisable. */
export function parseChatList(body: unknown): ChatSummary[] {
  const chats = isObj(body) && isObj(body.data) ? body.data.chats : undefined;
  if (!Array.isArray(chats)) {
    throw new UpstreamContractError('listChats', 'expected data.chats to be an array');
  }

  const out: ChatSummary[] = [];
  for (const c of chats) {
    if (!isObj(c)) continue;
    const chatId = str(c.chatid);
    if (!chatId) continue; // one malformed row should not hide the others

    const recipients = maybeJson(c.recipants);
    const lastInfo = maybeJson(c.lastmsginfo);
    out.push({
      chatId,
      title: str(c.title),
      lastMessageId: isObj(lastInfo) ? str(lastInfo.msguid) : null,
      lastMessagePreview: isObj(lastInfo) ? str(lastInfo.msg) : null,
      owner: participant(c.owner, 'id', 'name'),
      participants: Array.isArray(recipients)
        ? recipients.map((r) => participant(r, 'zuid', 'dname')).filter((p): p is Participant => p !== null)
        : [],
    });
  }
  return out;
}

const TIMESTAMP_KEYS = ['time', 'created_time', 'msgtime', 'timestamp', 'ts'];

function timestampOf(m: Obj): number | null {
  for (const key of TIMESTAMP_KEYS) {
    const raw = m[key];
    const n = typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : raw;
    if (typeof n === 'number' && Number.isFinite(n) && n > 0) {
      return n < 1e12 ? n * 1000 : n; // seconds vs milliseconds
    }
  }
  return null;
}

function media(m: Obj): MediaDescriptor | null {
  if (m.type !== 'file' || !isObj(m.content) || !isObj(m.content.file)) return null;
  const f = m.content.file;
  const id = str(f.id);
  if (!id) return null;
  const size = isObj(f.dimensions) && typeof f.dimensions.size === 'number' ? f.dimensions.size : null;
  return { fileId: id, fileName: str(f.name), mimeType: str(f.type) ?? 'application/octet-stream', size };
}

/** Parse a `GET /v2/chats/:id/messages` body. Messages are returned oldest-first. */
export function parseMessages(body: unknown): ArattaiMessage[] {
  const list = isObj(body) ? body.data : undefined;
  if (!Array.isArray(list)) {
    throw new UpstreamContractError('fetchMessages', 'expected data to be an array');
  }

  const out: ArattaiMessage[] = [];
  for (const m of list) {
    if (!isObj(m)) continue;
    const id = str(m.id);
    if (!id) continue;
    out.push({
      id,
      type: str(m.type),
      text: isObj(m.content) ? str(m.content.text) : null,
      sender: participant(m.sender, 'id', 'name'),
      timestamp: timestampOf(m),
      media: media(m),
      raw: m,
    });
  }
  return out;
}
