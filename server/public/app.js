// Arattix admin UI. Plain ES module, no build step: served by the API server at /ui and
// talking only to /api/v1 with the operator's API key (kept in this browser only).

const KEY_STORAGE = 'arattix.apiKey';
const THEME_STORAGE = 'arattix.theme';
const EVENT_TYPES = ['message.received', 'message.sent', 'message.failed', 'session.state_changed', 'session.qr', 'broadcast.completed', 'webhook.test'];
const QUEUES = ['control', 'outbound', 'broadcast', 'webhooks'];
const JOB_STATES = ['waiting', 'delayed', 'active', 'completed', 'failed'];
const LOG_LEVELS = ['error', 'warn', 'info', 'http', 'verbose', 'debug'];

// ─── storage (may throw in private windows) ──────────────────────────
const store = {
  get(k) {
    try { return sessionStorage.getItem(k) ?? localStorage.getItem(k); } catch { return null; }
  },
  set(k, v, persist) {
    try {
      (persist ? localStorage : sessionStorage).setItem(k, v);
      (persist ? sessionStorage : localStorage).removeItem(k);
    } catch { /* ignore */ }
  },
  remembered(k) {
    try { return localStorage.getItem(k) !== null; } catch { return false; }
  },
  del(k) {
    try { sessionStorage.removeItem(k); localStorage.removeItem(k); } catch { /* ignore */ }
  },
};

// ─── DOM helpers (never innerHTML with data) ─────────────────────────
function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k === 'value') el.value = v;
      else if (k === 'checked') el.checked = Boolean(v);
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, String(v));
    }
  }
  append(el, children);
  return el;
}
function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}
function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}
/** Replace an element's children; arrays are flattened like in h(). */
function put(el, ...children) {
  return append(clear(el), children);
}
const $ = (sel, root = document) => root.querySelector(sel);

function toast(message, kind = 'info', ms = 4500) {
  const t = h('div', { class: `toast ${kind}`, role: 'status' }, message);
  $('#toasts').append(t);
  setTimeout(() => t.remove(), ms);
}

// ─── formatting ──────────────────────────────────────────────────────
function rel(iso) {
  if (!iso) return '—';
  const t = typeof iso === 'number' ? iso : Date.parse(iso);
  if (Number.isNaN(t)) return '—';
  const s = Math.round((Date.now() - t) / 1000);
  const abs = Math.abs(s);
  const f = abs < 60 ? `${abs}s` : abs < 3600 ? `${Math.round(abs / 60)}m` : abs < 86400 ? `${Math.round(abs / 3600)}h` : `${Math.round(abs / 86400)}d`;
  return s >= 0 ? `${f} ago` : `in ${f}`;
}
function time(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString();
}
function clock(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour12: false }) + '.' + String(d.getMilliseconds()).padStart(3, '0');
}
function bytes(n) {
  if (n === null || n === undefined) return '—';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i += 1; }
  return `${n.toFixed(i ? 1 : 0)} ${u[i]}`;
}
function duration(sec) {
  const d = Math.floor(sec / 86400), hh = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  return d ? `${d}d ${hh}h` : hh ? `${hh}h ${m}m` : `${m}m ${sec % 60}s`;
}
function json(v) {
  return JSON.stringify(v, null, 2);
}

const STATE_KIND = {
  READY: 'ok', SYNCING: 'info', AUTHENTICATED: 'info', CONNECTING: 'info', QR_READY: 'warn', DISCONNECTED: 'bad',
  completed: 'ok', active: 'info', waiting: 'neutral', delayed: 'warn', failed: 'bad', unknown: 'neutral',
  CLOSED: 'ok', HALF_OPEN: 'warn', OPEN: 'bad',
};
function badge(text, kind = STATE_KIND[text] ?? 'neutral', dot = false) {
  return h('span', { class: `badge ${kind}` }, dot ? h('span', { class: 'dot' }) : null, text);
}

// ─── API client ──────────────────────────────────────────────────────
class ApiError extends Error {
  constructor(status, body) {
    super(body?.error?.message ?? `HTTP ${status}`);
    this.status = status;
    this.code = body?.error?.code ?? 'HTTP_ERROR';
    this.details = body?.error?.details;
  }
}

let apiKey = store.get(KEY_STORAGE);

async function api(method, path, { body, query, form, headers, raw } = {}) {
  const url = new URL(`/api/v1${path}`, location.origin);
  for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  const init = { method, headers: { Authorization: `Bearer ${apiKey}`, ...(headers ?? {}) }, cache: 'no-store' };
  if (form) init.body = form;
  else if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(url, init);
  if (res.status === 401) {
    signOut('Your API key was rejected. Sign in again.');
    throw new ApiError(401, { error: { code: 'UNAUTHORIZED', message: 'Missing or invalid API key' } });
  }
  if (raw && res.ok) return res;
  const text = await res.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  if (!res.ok) throw new ApiError(res.status, parsed);
  return { status: res.status, data: parsed?.data, requestId: parsed?.requestId };
}

/** Run a command endpoint; when it answers 202 + job id, poll the job until it settles. */
async function command(method, path, opts, { timeoutMs = 120_000 } = {}) {
  const res = await api(method, path, opts);
  const d = res.data;
  if (d?.status === 'completed') return d.result;
  if (d?.status === 'queued' && d.jobId) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1500));
      const job = (await api('GET', `/jobs/${encodeURIComponent(d.jobId)}`)).data;
      if (job.state === 'completed') return job.result;
      if (job.state === 'failed') throw new ApiError(job.error?.status ?? 500, { error: job.error });
    }
    throw new Error(`Still running; follow job ${d.jobId} on the Tasks page`);
  }
  return d;
}

function errText(err) {
  if (err instanceof ApiError) return `${err.code}: ${err.message}`;
  return err?.message ?? String(err);
}

// ─── shell & routing ─────────────────────────────────────────────────
const ROUTES = [
  { id: 'dashboard', label: 'Dashboard', view: viewDashboard },
  { id: 'session', label: 'Arattai login', view: viewSession },
  { id: 'chats', label: 'Chats', view: viewChats },
  { id: 'send', label: 'Send & broadcast', view: viewSend },
  { id: 'tasks', label: 'Tasks', view: viewTasks },
  { id: 'logs', label: 'Logs', view: viewLogs },
  { id: 'events', label: 'Events', view: viewEvents },
  { id: 'webhooks', label: 'Webhooks', view: viewWebhooks },
  { id: 'settings', label: 'Settings', view: viewSettings },
];

let cleanup = [];
let caps = null;
let navState = null;

function onCleanup(fn) { cleanup.push(fn); }
function every(ms, fn) {
  let stopped = false;
  let timer = null;
  const tick = async () => {
    if (stopped) return;
    try { await fn(); } catch (err) { if (!(err instanceof ApiError && err.status === 401)) console.warn(err); }
    if (!stopped) timer = setTimeout(tick, document.hidden ? ms * 3 : ms);
  };
  // First tick on the next turn, so callers can finish wiring up (and hold `stop`) first.
  timer = setTimeout(tick, 0);
  const stop = () => { stopped = true; clearTimeout(timer); };
  onCleanup(stop);
  return stop;
}

function applyTheme() {
  const t = store.get(THEME_STORAGE);
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
}

function signOut(message) {
  apiKey = null;
  store.del(KEY_STORAGE);
  renderLogin(message);
}

function renderLogin(message) {
  for (const fn of cleanup.splice(0)) fn();
  const input = h('input', { type: 'password', autocomplete: 'current-password', placeholder: 'API key', required: true, minlength: 24 });
  const remember = h('input', { type: 'checkbox' });
  const status = h('div', { class: message ? 'callout bad' : 'hidden' }, message ?? '');
  const submit = h('button', { class: 'primary', type: 'submit' }, 'Sign in');
  const form = h(
    'form',
    {
      class: 'form',
      onsubmit: async (e) => {
        e.preventDefault();
        submit.disabled = true;
        apiKey = input.value.trim();
        try {
          const res = await fetch('/api/v1/capabilities', { headers: { Authorization: `Bearer ${apiKey}` } });
          if (res.status === 401) throw new Error('That API key was rejected.');
          if (res.status === 429) throw new Error('Too many wrong keys from this address. Try again in 15 minutes.');
          if (!res.ok) throw new Error(`Server answered ${res.status}`);
          store.set(KEY_STORAGE, apiKey, remember.checked);
          start();
        } catch (err) {
          apiKey = null;
          status.className = 'callout bad';
          status.textContent = err.message;
        } finally {
          submit.disabled = false;
        }
      },
    },
    h('label', { class: 'field' }, 'API key', input, h('span', { class: 'hint' }, 'One of the keys in the server’s API_KEYS. It stays in this browser.')),
    h('label', { class: 'check' }, remember, 'Remember on this device'),
    status,
    submit,
  );
  const app = clear($('#app'));
  app.append(
    h('div', { class: 'login' },
      h('div', { class: 'card' },
        h('div', { class: 'brand' }, h('img', { src: 'favicon.svg', alt: '' }), 'Arattix Admin'),
        h('p', { class: 'muted' }, 'Manage the Arattai session, messages, tasks, logs and settings of this server.'),
        form,
      ),
    ),
  );
  input.focus();
}

function renderShell() {
  const nav = h('nav', { class: 'nav' }, ROUTES.map((r) => h('a', { href: `#/${r.id}`, dataset: { route: r.id } }, h('span', null, r.label))));
  const stateBadge = h('span', { id: 'nav-state' });
  const themeBtn = h('button', {
    class: 'ghost small',
    onclick: () => {
      const cur = document.documentElement.dataset.theme;
      const dark = cur ? cur === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
      store.set(THEME_STORAGE, dark ? 'light' : 'dark', true);
      applyTheme();
    },
  }, 'Toggle theme');
  const app = clear($('#app'));
  app.append(
    h('aside', { class: 'sidebar' },
      h('div', { class: 'brand' }, h('img', { src: 'favicon.svg', alt: '' }), 'Arattix'),
      nav,
      h('div', { class: 'sidebar-foot' },
        h('div', { class: 'row small' }, h('span', { class: 'muted' }, 'Session'), stateBadge),
        themeBtn,
        h('button', { class: 'ghost small', onclick: () => signOut() }, 'Sign out'),
      ),
    ),
    h('main', { class: 'main', id: 'view' }),
  );
  navState = stateBadge;
}

async function refreshNavState() {
  try {
    const s = (await api('GET', '/auth/status')).data;
    if (navState) put(navState, badge(s.workerOnline ? s.state : 'WORKER OFFLINE', s.workerOnline ? undefined : 'bad', true));
  } catch { /* shown elsewhere */ }
}

function route() {
  for (const fn of cleanup.splice(0)) fn();
  const [id, ...rest] = location.hash.replace(/^#\/?/, '').split('/');
  const r = ROUTES.find((x) => x.id === id) ?? ROUTES[0];
  for (const a of document.querySelectorAll('.nav a')) a.classList.toggle('active', a.dataset.route === r.id);
  const view = clear($('#view'));
  document.title = `${r.label} · Arattix Admin`;
  r.view(view, rest.map(decodeURIComponent));
  every(10_000, refreshNavState);
}

async function start() {
  renderShell();
  try {
    caps = (await api('GET', '/capabilities')).data;
  } catch { caps = {}; }
  window.onhashchange = route;
  route();
}

function pageHead(title, subtitle, ...actions) {
  return h('div', { class: 'page-head' },
    h('div', null, h('h1', null, title), subtitle ? h('p', null, subtitle) : null),
    h('div', { class: 'row' }, actions),
  );
}

function card(title, ...children) {
  return h('section', { class: 'card' }, title ? (typeof title === 'string' ? h('h2', null, title) : title) : null, children);
}

function kv(pairs) {
  return h('dl', { class: 'kv' }, pairs.filter(Boolean).map(([k, v]) => [h('dt', null, k), h('dd', null, v ?? '—')]));
}

function drawer(title, body, actions = []) {
  const close = () => { backdrop.remove(); panel.remove(); document.removeEventListener('keydown', esc); };
  const esc = (e) => { if (e.key === 'Escape') close(); };
  const backdrop = h('div', { class: 'drawer-backdrop', onclick: close });
  const panel = h('aside', { class: 'drawer', role: 'dialog', 'aria-label': title },
    h('div', { class: 'drawer-head' }, h('h2', null, title), h('div', { class: 'row' }, actions, h('button', { class: 'ghost', onclick: close, 'aria-label': 'Close' }, 'Close'))),
    h('div', { class: 'drawer-body' }, body),
  );
  document.addEventListener('keydown', esc);
  document.body.append(backdrop, panel);
  onCleanup(close);
  return { close, panel };
}

function capNote(capability) {
  return h('div', { class: 'callout warn' },
    h('p', null, `Not available yet: the library has no verified Arattai endpoint for "${capability}", so the server answers 501 for it.`));
}

// ─── Dashboard ───────────────────────────────────────────────────────
function viewDashboard(root) {
  const sessionCard = card('Arattai session');
  const serverCard = card('Server');
  const queuesCard = card('Task queues');
  const eventsCard = card(h('div', { class: 'card-head' }, h('h2', null, 'Recent events'), h('a', { href: '#/events' }, 'All events')));
  const problemsCard = card(h('div', { class: 'card-head' }, h('h2', null, 'Recent warnings and errors'), h('a', { href: '#/logs' }, 'All logs')));
  const capsCard = card('Capabilities');

  root.append(
    pageHead('Dashboard', 'Live state of this Arattix server.'),
    h('div', { class: 'stack' },
      h('div', { class: 'grid' }, sessionCard, serverCard, capsCard),
      queuesCard,
      h('div', { class: 'grid two' }, eventsCard, problemsCard),
    ),
  );

  const fill = (c, ...content) => {
    const head = c.firstChild;
    put(c, head, ...content);
  };

  every(5000, async () => {
    const sys = (await api('GET', '/system')).data;
    const s = sys.session;
    fill(sessionCard,
      h('div', { class: 'state-hero' }, h('span', { class: 'big' }, s.state), badge(s.workerOnline ? 'worker online' : 'worker offline', s.workerOnline ? 'ok' : 'bad', true)),
      h('div', { class: 'small muted' }, s.reason ? `Reason: ${s.reason}` : ' '),
      kv([
        ['Since', rel(s.since)],
        ['Logged in', s.authenticatedAt ? rel(s.authenticatedAt) : '—'],
        ['Heartbeat', s.lastHeartbeatAt ? rel(s.lastHeartbeatAt) : '—'],
        ['Circuit', badge(s.circuit)],
        s.reconnect ? ['Reconnect', `attempt ${s.reconnect.attempt}, next ${rel(s.reconnect.nextRetryAt)}`] : null,
        s.lastError ? ['Last error', `${s.lastError.code} (${rel(s.lastError.at)})`] : null,
      ]),
      s.state !== 'READY' ? h('div', { class: 'row' }, h('a', { class: 'btn', href: '#/session' }, 'Open Arattai login')) : null,
    );
    fill(serverCard, kv([
      ['Version', sys.version],
      ['Role', `${sys.role} · ${sys.storeDriver} store · ${sys.queueDriver} queue`],
      ['Session id', h('code', null, sys.sessionId)],
      ['Uptime', duration(sys.uptimeSeconds)],
      ['Memory', `${bytes(sys.memory.rss)} RSS · ${bytes(sys.memory.heapUsed)} heap`],
      ['Node', sys.node],
      ['Log level', sys.logLevel],
    ]));
    fill(capsCard, h('div', { class: 'chips' }, Object.entries(sys.capabilities).map(([k, v]) => badge(k, v ? 'ok' : 'neutral'))),
      h('p', { class: 'small muted' }, 'Grey capabilities have no verified Arattai endpoint yet and answer 501.'));
    fill(queuesCard, h('div', { class: 'table-wrap' }, h('table', null,
      h('thead', null, h('tr', null, h('th', null, 'Queue'), JOB_STATES.map((st) => h('th', { class: 'num' }, st)))),
      h('tbody', null, QUEUES.map((q) => {
        const c = sys.queues[q] ?? {};
        return h('tr', { class: 'clickable', onclick: () => (location.hash = `#/tasks/${q}`) },
          h('td', null, h('strong', null, q)),
          JOB_STATES.map((st) => h('td', { class: 'num' }, c.error ? '!' : (c[st] ?? 0))));
      })),
    )));
  });

  every(8000, async () => {
    const ev = (await api('GET', '/events', { query: { limit: 8 } })).data.entries.reverse();
    const head = eventsCard.firstChild;
    put(eventsCard, head, ev.length ? h('div', { class: 'stack' }, ev.map(eventRow)) : h('div', { class: 'empty' }, 'No events yet.'));
    const logs = (await api('GET', '/logs', { query: { limit: 8, level: 'warn' } })).data.entries.reverse();
    const head2 = problemsCard.firstChild;
    put(problemsCard, head2, logs.length
      ? h('div', { class: 'table-wrap' }, h('table', { class: 'log-table' }, h('tbody', null, logs.map((l) =>
        h('tr', null, h('td', null, rel(l.at)), h('td', { class: `level-${l.level}` }, l.level), h('td', { class: 'msg-cell' }, l.component ? `[${l.component}] ` : '', l.message))))))
      : h('div', { class: 'empty' }, 'Nothing to worry about.'));
  });
}

function eventRow(e) {
  const summary = summarizeEvent(e);
  return h('div', { class: 'event' },
    h('div', { class: 'event-head' }, badge(e.type, e.type.endsWith('failed') ? 'bad' : e.type.startsWith('session') ? 'info' : 'neutral'), h('span', { class: 'small muted' }, rel(e.occurredAt)), h('span', null, summary)));
}

function summarizeEvent(e) {
  const d = e.data ?? {};
  switch (e.type) {
    case 'message.received': {
      const m = d.message ?? {};
      return `${m.sender?.name ?? m.sender?.id ?? 'Someone'} in ${d.chatTitle ?? d.chatId ?? 'a chat'}: ${m.text ?? (m.media ? '[media]' : '')}`;
    }
    case 'message.sent': return `Sent ${d.kind ?? 'message'} to ${d.chatId ?? '?'}`;
    case 'message.failed': return `${d.kind ?? 'message'} to ${d.chatId ?? '?'} failed: ${d.error?.code ?? ''}`;
    case 'session.state_changed': return `${d.from ?? '?'} → ${d.to ?? d.state ?? '?'}${d.reason ? ` (${d.reason})` : ''}`;
    case 'broadcast.completed': return `Broadcast ${d.broadcastId}: ${d.sent}/${d.total} sent, ${d.failed} failed`;
    case 'session.qr': return 'New QR code issued';
    default: return '';
  }
}

// ─── Arattai login ───────────────────────────────────────────────────
function viewSession(root) {
  const statusCard = card('Session status');
  const qrCard = card('Link this server to Arattai');
  const actions = h('div', { class: 'row' });
  root.append(
    pageHead('Arattai login', 'Sign this server in to Arattai with a QR code, check the session and log out.'),
    h('div', { class: 'stack' }, qrCard, statusCard),
  );
  let busy = false;
  let last = null;

  const act = (label, fn, cls = '') => h('button', {
    class: cls,
    onclick: async (e) => {
      if (busy) return;
      const btn = e.currentTarget;
      busy = true;
      btn.disabled = true;
      try { await fn(); await refresh(); } catch (err) { toast(errText(err), 'bad'); } finally { busy = false; btn.disabled = false; }
    },
  }, label);

  const startLogin = (force) => act(force ? 'Force a new QR code' : 'Start QR login', async () => {
    if (force && last?.state === 'READY' && !confirm('This drops the current Arattai session and starts a new login. Continue?')) return;
    await api('POST', '/auth/session', { body: { force } });
    toast('Login started. Scan the QR code with the Arattai app.', 'ok');
  }, force ? '' : 'primary');
  const logout = act('Log out of Arattai', async () => {
    if (!confirm('Log this server out of Arattai? Sending stops until you scan a new QR code.')) return;
    await api('DELETE', '/auth/session');
    toast('Logged out.', 'ok');
  }, 'danger');

  const refresh = async () => {
    const s = (await api('GET', '/auth/status')).data;
    last = s;
    clear(actions);
    if (!s.workerOnline) actions.append(h('div', { class: 'callout bad' }, h('p', null, 'No worker owns the session right now, so login and sending are unavailable. Check the worker process.')));
    else if (s.state === 'READY') actions.append(startLogin(true), logout);
    else if (s.state === 'QR_READY') actions.append(startLogin(true), logout);
    else append(actions, [startLogin(false), s.state !== 'DISCONNECTED' ? logout : null]);

    const head = qrCard.firstChild;
    put(qrCard, head);
    if (s.state === 'QR_READY' && s.qr) {
      qrCard.append(h('div', { class: 'qr-box' },
        h('img', { src: s.qr.dataUrl, alt: 'Arattai login QR code' }),
        h('div', { class: 'stack' },
          h('ol', { class: 'steps' },
            h('li', null, 'Open Arattai on your phone.'),
            h('li', null, 'Go to Settings → Linked devices (or Arattai Web login).'),
            h('li', null, 'Scan this code. This page updates once the login is approved.')),
          kv([
            ['Issued', rel(s.qr.issuedAt)],
            ['Gives up', rel(s.qr.expiresAt)],
            ['Refreshes', String(s.qr.refreshCount)],
          ]),
          actions,
        )));
    } else if (s.state === 'READY') {
      qrCard.append(h('div', { class: 'callout ok' }, h('p', null, `Signed in${s.authenticatedAt ? ` since ${time(s.authenticatedAt)}` : ''}. The session is stored encrypted and restored on restart.`)), h('div', { class: 'row' }, actions));
    } else if (['CONNECTING', 'AUTHENTICATED', 'SYNCING'].includes(s.state)) {
      qrCard.append(h('div', { class: 'callout info' }, h('p', null, `Connecting (${s.state})…`)), h('div', { class: 'row' }, actions));
    } else {
      qrCard.append(h('p', { class: 'muted' }, s.reason === 'QR_TIMEOUT' ? 'The last QR code expired before it was scanned. Start a new login.' : 'This server is not signed in to Arattai.'), h('div', { class: 'row' }, actions));
    }

    const head2 = statusCard.firstChild;
    put(statusCard, head2,
      kv([
        ['State', badge(s.state, undefined, true)],
        ['Reason', s.reason],
        ['Worker', s.workerOnline ? badge('online', 'ok') : badge('offline', 'bad')],
        ['Since', time(s.since)],
        ['Logged in', time(s.authenticatedAt)],
        ['Last heartbeat', s.lastHeartbeatAt ? `${time(s.lastHeartbeatAt)} (${rel(s.lastHeartbeatAt)})` : '—'],
        ['Circuit breaker', badge(s.circuit)],
        ['Reconnect', s.reconnect ? `attempt ${s.reconnect.attempt}, next ${rel(s.reconnect.nextRetryAt)}` : '—'],
        ['Last error', s.lastError ? `${s.lastError.code}: ${s.lastError.message} (${rel(s.lastError.at)})` : '—'],
        ['Session id', h('code', null, s.sessionId)],
      ]));
  };
  every(2500, refresh);
}

// ─── Chats ───────────────────────────────────────────────────────────
function viewChats(root, [initialChat]) {
  if (caps && !caps['chats.read']) {
    root.append(pageHead('Chats', null), capNote('chats.read'));
    return;
  }
  const list = h('div', { class: 'chat-list' }, h('div', { class: 'empty' }, 'Loading chats…'));
  const filter = h('input', { type: 'search', placeholder: 'Filter chats' });
  const openId = h('input', { placeholder: 'Open chat by id' });
  const pane = h('section', { class: 'card' }, h('div', { class: 'empty' }, 'Pick a chat to read and reply.'));
  let chats = [];
  let current = null;

  const renderList = () => {
    const f = filter.value.trim().toLowerCase();
    const shown = chats.filter((c) => !f || `${c.title ?? ''} ${c.chatId}`.toLowerCase().includes(f));
    put(list, shown.length ? shown.map((c) => h('button', {
      class: `chat-item${current === c.chatId ? ' active' : ''}`,
      onclick: () => { location.hash = `#/chats/${encodeURIComponent(c.chatId)}`; },
    }, h('span', { class: 'title' }, c.title ?? c.chatId), h('span', { class: 'preview' }, c.lastMessagePreview ?? c.chatId))) : h('div', { class: 'empty' }, 'No chats.'));
  };

  const loadChats = async () => {
    try {
      chats = (await command('GET', '/chats', { query: { limit: 100 } })) ?? [];
      renderList();
    } catch (err) {
      put(list, h('div', { class: 'callout bad' }, h('p', null, errText(err))));
    }
  };

  filter.addEventListener('input', renderList);
  root.append(
    pageHead('Chats', 'Read conversations and reply. Inbound messages also arrive as events and webhooks.',
      h('button', { onclick: loadChats }, 'Refresh')),
    h('div', { class: 'chat-layout' },
      h('section', { class: 'card' }, h('div', { class: 'stack' }, filter,
        h('form', { class: 'row', onsubmit: (e) => { e.preventDefault(); if (openId.value.trim()) location.hash = `#/chats/${encodeURIComponent(openId.value.trim())}`; } }, openId, h('button', { type: 'submit' }, 'Open')),
        list)),
      pane,
    ),
  );
  const loaded = loadChats();
  if (initialChat) openChat(initialChat);

  async function openChat(chatId) {
    current = chatId;
    await loaded;
    renderList();
    const chat = chats.find((c) => c.chatId === chatId);
    const msgs = h('div', { class: 'messages' }, h('div', { class: 'empty' }, 'Loading messages…'));
    const text = h('textarea', { placeholder: 'Write a message', rows: 3 });
    const file = h('input', { type: 'file' });
    const caption = h('input', { placeholder: 'Caption (optional)' });
    const sendBtn = h('button', { class: 'primary', type: 'submit' }, 'Send');
    const loadMessages = async () => {
      try {
        const items = (await command('GET', `/chats/${encodeURIComponent(chatId)}/messages`, { query: { limit: 50 } })) ?? [];
        items.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
        put(msgs, items.length ? items.map((m) => messageBubble(m, chatId)) : h('div', { class: 'empty' }, 'No messages.'));
        msgs.scrollTop = msgs.scrollHeight;
      } catch (err) {
        put(msgs, h('div', { class: 'callout bad' }, h('p', null, errText(err))));
      }
    };
    put(pane, 
      h('div', { class: 'card-head' },
        h('div', null, h('h2', null, chat?.title ?? chatId), h('div', { class: 'small muted mono' }, chatId)),
        h('button', { class: 'small', onclick: loadMessages }, 'Reload')),
      msgs,
      h('form', {
        class: 'composer',
        onsubmit: async (e) => {
          e.preventDefault();
          sendBtn.disabled = true;
          try {
            if (file.files?.length) {
              if (caps && !caps['messages.media']) throw new Error('Media sending is not available');
              const fd = new FormData();
              fd.append('chatId', chatId);
              if (caption.value.trim()) fd.append('caption', caption.value.trim());
              fd.append('file', file.files[0]);
              await command('POST', '/messages/media', { form: fd });
              file.value = '';
              caption.value = '';
            }
            if (text.value.trim()) {
              await command('POST', '/messages/send', { body: { chatId, text: text.value } });
              text.value = '';
            }
            toast('Sent.', 'ok');
            loadMessages();
          } catch (err) {
            toast(errText(err), 'bad', 7000);
          } finally {
            sendBtn.disabled = false;
          }
        },
      }, text, h('div', { class: 'row' }, file, caption, h('span', { class: 'spacer' }), sendBtn)),
    );
    text.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) e.currentTarget.form.requestSubmit(); });
    loadMessages();
  }
}

function messageBubble(m, chatId) {
  const media = m.media
    ? h('div', { class: 'attach' }, badge(m.media.mimeType ?? 'file'), h('span', { class: 'small' }, m.media.fileName ?? m.media.fileId, m.media.size ? ` · ${bytes(m.media.size)}` : ''),
      caps?.['media.download'] ? h('button', { class: 'small', onclick: () => downloadMedia(m.media, chatId) }, 'Download') : null)
    : null;
  return h('div', { class: 'msg' },
    h('div', { class: 'meta' }, h('strong', null, m.sender?.name ?? m.sender?.id ?? 'unknown'), m.timestamp ? h('span', null, time(m.timestamp)) : null, h('span', { class: 'mono' }, m.id)),
    m.text ? h('div', { class: 'text' }, m.text) : null,
    media);
}

async function downloadMedia(media, chatId) {
  try {
    const res = await api('GET', `/media/${encodeURIComponent(media.fileId)}`, { query: { chatId }, raw: true });
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = h('a', { href: url, download: media.fileName ?? media.fileId });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  } catch (err) {
    toast(errText(err), 'bad');
  }
}

// ─── Send & broadcast ────────────────────────────────────────────────
function viewSend(root) {
  const tabs = [
    { id: 'text', label: 'Text message', render: sendTextForm },
    { id: 'media', label: 'Media', render: sendMediaForm },
    { id: 'broadcast', label: 'Broadcast', render: broadcastForm },
    { id: 'reaction', label: 'Reaction', render: reactionForm },
    { id: 'groups', label: 'Groups', render: groupsForm },
  ];
  const bar = h('div', { class: 'tabs', role: 'tablist' });
  const body = h('div');
  const show = (id) => {
    for (const b of bar.children) b.classList.toggle('on', b.dataset.id === id);
    put(body, tabs.find((t) => t.id === id).render());
  };
  for (const t of tabs) bar.append(h('button', { dataset: { id: t.id }, role: 'tab', onclick: () => show(t.id) }, t.label));
  root.append(pageHead('Send & broadcast', 'Queue messages and actions through the paced outbound queue. Each one becomes a task you can follow.'), bar, body);
  show('text');
}

function resultBox() {
  const box = h('div', { class: 'hidden' });
  return {
    box,
    show(res) {
      box.className = 'stack';
      const d = res.data ?? {};
      const jobId = d.jobId ?? d.broadcastId;
      put(box, 
        h('div', { class: d.status === 'completed' ? 'callout ok' : 'callout info' },
          h('p', null, d.status === 'completed' ? 'Done.' : 'Queued.', ' ', jobId ? h('a', { href: `#/tasks/all/${encodeURIComponent(jobId)}` }, `Task ${jobId}`) : null, d.deduplicated ? ' (deduplicated: same Idempotency-Key as an earlier request)' : '')),
        h('pre', null, json(d)));
    },
    error(err) {
      box.className = 'stack';
      put(box, h('div', { class: 'callout bad' }, h('p', null, errText(err))), err.details ? h('pre', null, json(err.details)) : null);
    },
  };
}

function idemField() {
  return h('input', { placeholder: 'Idempotency-Key (optional)', maxlength: 200 });
}

function sendTextForm() {
  if (caps && !caps['messages.text']) return capNote('messages.text');
  const chatId = h('input', { required: true, placeholder: 'CT_…' });
  const text = h('textarea', { required: true, rows: 5, maxlength: 10000 });
  const displayName = h('input', { maxlength: 100 });
  const ttl = h('input', { type: 'number', min: 5, max: 86400, placeholder: 'default' });
  const asyncBox = h('input', { type: 'checkbox' });
  const idem = idemField();
  const out = resultBox();
  const submit = h('button', { class: 'primary', type: 'submit' }, 'Send message');
  return card(null, h('form', {
    class: 'form',
    onsubmit: async (e) => {
      e.preventDefault();
      submit.disabled = true;
      try {
        const res = await api('POST', '/messages/send', {
          query: { async: asyncBox.checked ? 'true' : undefined },
          headers: idem.value.trim() ? { 'Idempotency-Key': idem.value.trim() } : undefined,
          body: { chatId: chatId.value.trim(), text: text.value, ...(displayName.value.trim() ? { displayName: displayName.value.trim() } : {}), ...(ttl.value ? { ttlSeconds: Number(ttl.value) } : {}) },
        });
        out.show(res);
      } catch (err) { out.error(err); } finally { submit.disabled = false; }
    },
  },
  h('label', { class: 'field' }, 'Chat id', chatId),
  h('label', { class: 'field' }, 'Text', text),
  h('div', { class: 'inline' },
    h('label', { class: 'field' }, 'Display name', displayName),
    h('label', { class: 'field' }, 'Expires after (s)', ttl),
    h('label', { class: 'field' }, 'Idempotency key', idem)),
  h('label', { class: 'check' }, asyncBox, 'Queue and return immediately (async)'),
  h('div', { class: 'row' }, submit),
  out.box));
}

function sendMediaForm() {
  if (caps && !caps['messages.media']) return capNote('messages.media');
  const chatId = h('input', { required: true, placeholder: 'CT_…' });
  const file = h('input', { type: 'file', required: true });
  const caption = h('input', { maxlength: 4000 });
  const mimeType = h('input', { placeholder: 'auto' });
  const asyncBox = h('input', { type: 'checkbox' });
  const out = resultBox();
  const submit = h('button', { class: 'primary', type: 'submit' }, 'Upload and send');
  return card(null, h('form', {
    class: 'form',
    onsubmit: async (e) => {
      e.preventDefault();
      submit.disabled = true;
      try {
        const fd = new FormData();
        fd.append('chatId', chatId.value.trim());
        if (caption.value.trim()) fd.append('caption', caption.value.trim());
        if (mimeType.value.trim()) fd.append('mimeType', mimeType.value.trim());
        fd.append('file', file.files[0]);
        out.show(await api('POST', '/messages/media', { form: fd, query: { async: asyncBox.checked ? 'true' : undefined } }));
      } catch (err) { out.error(err); } finally { submit.disabled = false; }
    },
  },
  h('label', { class: 'field' }, 'Chat id', chatId),
  h('label', { class: 'field' }, 'File', file),
  h('div', { class: 'inline' }, h('label', { class: 'field' }, 'Caption', caption), h('label', { class: 'field' }, 'MIME type', mimeType)),
  h('label', { class: 'check' }, asyncBox, 'Queue and return immediately (async)'),
  h('div', { class: 'row' }, submit),
  out.box));
}

function broadcastForm() {
  if (caps && !caps['messages.text']) return capNote('messages.text');
  const recipients = h('textarea', { required: true, rows: 6, placeholder: 'One chat id per line (or comma-separated)' });
  const text = h('textarea', { required: true, rows: 4, maxlength: 10000 });
  const displayName = h('input', { maxlength: 100 });
  const chunkSize = h('input', { type: 'number', min: 1, max: 50, value: 10 });
  const chunkDelay = h('input', { type: 'number', min: 0, placeholder: 'default (30000)' });
  const idem = idemField();
  const out = h('div');
  const submit = h('button', { class: 'primary', type: 'submit' }, 'Start broadcast');
  const count = h('span', { class: 'small muted' }, '0 recipients');
  const parseRecipients = () => [...new Set(recipients.value.split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean))];
  recipients.addEventListener('input', () => { count.textContent = `${parseRecipients().length} recipients`; });
  return card(null, h('form', {
    class: 'form',
    onsubmit: async (e) => {
      e.preventDefault();
      const list = parseRecipients();
      if (!confirm(`Send this message to ${list.length} recipient(s)?`)) return;
      submit.disabled = true;
      try {
        const res = await api('POST', '/channels/broadcast', {
          headers: idem.value.trim() ? { 'Idempotency-Key': idem.value.trim() } : undefined,
          body: {
            recipients: list, text: text.value,
            ...(displayName.value.trim() ? { displayName: displayName.value.trim() } : {}),
            chunkSize: Number(chunkSize.value || 10),
            ...(chunkDelay.value ? { chunkDelayMs: Number(chunkDelay.value) } : {}),
          },
        });
        put(out, broadcastTracker(res.data.broadcastId, res.data));
      } catch (err) {
        put(out, h('div', { class: 'callout bad' }, h('p', null, errText(err))), err.details ? h('pre', null, json(err.details)) : null);
      } finally { submit.disabled = false; }
    },
  },
  h('label', { class: 'field' }, h('span', { class: 'row' }, 'Recipients', count), recipients),
  h('label', { class: 'field' }, 'Text', text),
  h('div', { class: 'inline' },
    h('label', { class: 'field' }, 'Display name', displayName),
    h('label', { class: 'field' }, 'Chunk size', chunkSize),
    h('label', { class: 'field' }, 'Delay between chunks (ms)', chunkDelay),
    h('label', { class: 'field' }, 'Idempotency key', idem)),
  h('p', { class: 'small muted' }, 'Recipients are sent in chunks, paced by the outbound throttle, and the broadcast stops early if the session drops.'),
  h('div', { class: 'row' }, submit),
  out));
}

function broadcastTracker(id, initial) {
  const bar = h('div');
  const label = h('div', { class: 'small' });
  const results = h('div');
  const box = h('div', { class: 'stack' },
    h('div', { class: 'callout info' }, h('p', null, 'Broadcast ', h('a', { href: `#/tasks/broadcast/${encodeURIComponent(id)}` }, id), ` queued: ${initial.total} recipients in ${initial.chunks} chunk(s).`)),
    h('div', { class: 'progress' }, bar), label, results);
  const stop = every(2000, async () => {
    if (!box.isConnected) return stop();
    const job = (await api('GET', `/channels/broadcast/${encodeURIComponent(id)}`)).data;
    const p = job.result ?? job.progress ?? {};
    const total = p.total ?? initial.total;
    const done = (p.sent ?? 0) + (p.failed ?? 0) + (p.aborted ?? 0) + (p.unknown ?? 0);
    bar.style.width = `${total ? Math.round((done / total) * 100) : 0}%`;
    label.textContent = `${job.state} · ${p.sent ?? 0} sent, ${p.failed ?? 0} failed, ${p.aborted ?? 0} aborted · chunk ${p.chunksDone ?? 0}/${p.chunks ?? initial.chunks}`;
    if (job.state === 'completed' || job.state === 'failed') {
      stop();
      if (job.result?.results) {
        put(results, h('div', { class: 'table-wrap' }, h('table', null,
          h('thead', null, h('tr', null, h('th', null, 'Chat'), h('th', null, 'Status'), h('th', null, 'Task'), h('th', null, 'Error'))),
          h('tbody', null, job.result.results.map((r) => h('tr', null,
            h('td', { class: 'mono' }, r.chatId), h('td', null, badge(r.status, r.status === 'sent' ? 'ok' : r.status === 'failed' ? 'bad' : 'warn')),
            h('td', { class: 'mono' }, r.jobId ? h('a', { href: `#/tasks/outbound/${encodeURIComponent(r.jobId)}` }, r.jobId) : '—'),
            h('td', null, r.error ? `${r.error.code}: ${r.error.message}` : '')))))));
      }
      if (job.error) results.append(h('div', { class: 'callout bad' }, h('p', null, `${job.error.code}: ${job.error.message}`)));
    }
  });
  return box;
}

function reactionForm() {
  if (caps && !caps['messages.reaction']) return capNote('messages.reaction');
  const chatId = h('input', { required: true });
  const messageId = h('input', { required: true });
  const emoji = h('input', { required: true, value: '👍', maxlength: 16 });
  const out = resultBox();
  return card(null, h('form', {
    class: 'form',
    onsubmit: async (e) => {
      e.preventDefault();
      try { out.show(await api('POST', '/messages/send', { body: { type: 'reaction', chatId: chatId.value.trim(), messageId: messageId.value.trim(), emoji: emoji.value } })); } catch (err) { out.error(err); }
    },
  }, h('div', { class: 'inline' }, h('label', { class: 'field' }, 'Chat id', chatId), h('label', { class: 'field' }, 'Message id', messageId), h('label', { class: 'field' }, 'Emoji', emoji)),
  h('div', { class: 'row' }, h('button', { class: 'primary', type: 'submit' }, 'React')), out.box));
}

function groupsForm() {
  if (caps && !caps['groups.create'] && !caps['groups.members']) {
    return h('div', { class: 'stack' }, capNote('groups.create'), capNote('groups.members'));
  }
  const name = h('input', { required: true, maxlength: 100 });
  const participants = h('textarea', { required: true, rows: 3, placeholder: 'User ids, one per line' });
  const out = resultBox();
  return card('Create group', h('form', {
    class: 'form',
    onsubmit: async (e) => {
      e.preventDefault();
      try {
        out.show(await api('POST', '/groups/create', { body: { name: name.value.trim(), participants: participants.value.split(/[\s,;]+/).filter(Boolean) } }));
      } catch (err) { out.error(err); }
    },
  }, h('label', { class: 'field' }, 'Name', name), h('label', { class: 'field' }, 'Participants', participants), h('div', { class: 'row' }, h('button', { class: 'primary', type: 'submit' }, 'Create')), out.box));
}

// ─── Tasks ───────────────────────────────────────────────────────────
function viewTasks(root, [queueParam, openId]) {
  const selectedQueue = QUEUES.includes(queueParam) ? queueParam : '';
  const filters = { queue: selectedQueue, states: new Set(), name: '' };
  const counts = h('div', { class: 'stats' });
  const tableBox = h('div');
  const auto = h('input', { type: 'checkbox', checked: true });
  const queueSel = h('select', null, h('option', { value: '' }, 'All queues'), QUEUES.map((q) => h('option', { value: q }, q)));
  queueSel.value = filters.queue;
  const nameInput = h('input', { placeholder: 'Job name, e.g. message.text' });
  const lookup = h('input', { placeholder: 'Find task by id (out_…, ctl_…, bc_…, dlv_…)' });
  const stateChips = h('div', { class: 'chips' }, JOB_STATES.map((s) => h('button', {
    class: 'chip', type: 'button',
    onclick: (e) => { filters.states.has(s) ? filters.states.delete(s) : filters.states.add(s); e.currentTarget.classList.toggle('on'); load(); },
  }, s)));
  queueSel.addEventListener('change', () => { filters.queue = queueSel.value; load(); });
  let nameTimer;
  nameInput.addEventListener('input', () => { clearTimeout(nameTimer); nameTimer = setTimeout(() => { filters.name = nameInput.value.trim(); load(); }, 300); });

  root.append(
    pageHead('Tasks', 'Every API action runs as a queued task: logins and reads (control), sends (outbound), broadcasts and webhook deliveries.',
      h('label', { class: 'check' }, auto, 'Auto-refresh'), h('button', { onclick: () => load() }, 'Refresh')),
    h('div', { class: 'stack' },
      card(null, counts),
      card(null, h('div', { class: 'stack' },
        h('div', { class: 'row' }, queueSel, stateChips, nameInput, h('span', { class: 'spacer' }),
          h('form', { class: 'row', onsubmit: (e) => { e.preventDefault(); if (lookup.value.trim()) openJob(lookup.value.trim()); } }, lookup, h('button', { type: 'submit' }, 'Open'))),
        tableBox)),
    ),
  );

  async function loadCounts() {
    const qs = (await api('GET', '/queues')).data;
    put(counts, qs.map((q) => h('button', {
      class: `stat${filters.queue === q.queue ? ' on' : ''}`,
      onclick: () => { filters.queue = filters.queue === q.queue ? '' : q.queue; queueSel.value = filters.queue; load(); },
    },
    h('div', { class: 'label' }, q.queue),
    h('div', { class: 'value' }, String(q.counts.waiting + q.counts.active + q.counts.delayed)),
    h('div', { class: 'small muted' }, `${q.counts.active} active · ${q.counts.failed} failed · ${q.counts.completed} done`))));
  }

  async function load() {
    try {
      await loadCounts();
      const jobs = (await api('GET', '/jobs', { query: { queue: filters.queue, state: [...filters.states].join(','), name: filters.name, limit: 100 } })).data;
      put(tableBox, jobs.length ? h('div', { class: 'table-wrap' }, h('table', null,
        h('thead', null, h('tr', null, ['Task', 'Queue', 'Name', 'State', 'Attempts', 'Created', 'Finished', 'Error'].map((t) => h('th', null, t)))),
        h('tbody', null, jobs.map((j) => h('tr', { class: 'clickable', onclick: () => openJob(j.id, j) },
          h('td', { class: 'mono' }, j.id.length > 22 ? `${j.id.slice(0, 22)}…` : j.id),
          h('td', null, j.queue),
          h('td', null, j.name),
          h('td', null, badge(j.state)),
          h('td', { class: 'num' }, String(j.attemptsMade)),
          h('td', { title: time(j.createdAt) }, rel(j.createdAt)),
          h('td', { title: time(j.finishedAt) }, j.finishedAt ? rel(j.finishedAt) : '—'),
          h('td', null, j.error ? h('span', { class: 'level-error' }, j.error.code) : '')))),
      )) : h('div', { class: 'empty' }, 'No tasks match.'));
    } catch (err) {
      put(tableBox, h('div', { class: 'callout bad' }, h('p', null, errText(err))));
    }
  }

  async function openJob(id, listed) {
    let job;
    try { job = (await api('GET', `/jobs/${encodeURIComponent(id)}`)).data; } catch (err) { toast(errText(err), 'bad'); return; }
    const data = listed?.data;
    const actions = [];
    if (job.state === 'failed') actions.push(h('button', { class: 'primary', onclick: async () => {
      try { await api('POST', `/jobs/${encodeURIComponent(id)}/retry`); toast('Task re-queued.', 'ok'); d.close(); load(); } catch (err) { toast(errText(err), 'bad'); }
    } }, 'Retry'));
    if (job.state === 'waiting' || job.state === 'delayed') actions.push(h('button', { class: 'danger', onclick: async () => {
      if (!confirm('Cancel this task? It will not run.')) return;
      try { await api('DELETE', `/jobs/${encodeURIComponent(id)}`); toast('Task cancelled.', 'ok'); d.close(); load(); } catch (err) { toast(errText(err), 'bad'); }
    } }, 'Cancel'));
    const body = [
      kv([
        ['Task', h('code', null, job.id)],
        ['Queue', job.queue],
        ['Name', job.name],
        ['State', badge(job.state)],
        ['Attempts', String(job.attemptsMade)],
        ['Created', time(job.createdAt)],
        ['Finished', time(job.finishedAt)],
      ]),
      job.queue === 'broadcast' ? broadcastTracker(job.id, { total: job.progress?.total ?? '?', chunks: job.progress?.chunks ?? '?' }) : null,
      job.error ? [h('h3', null, 'Error'), h('pre', null, json(job.error))] : null,
      job.progress ? [h('h3', null, 'Progress'), h('pre', null, json(job.progress))] : null,
      data !== undefined ? [h('h3', null, 'Payload'), h('pre', null, json(data))] : null,
      job.result !== undefined ? [h('h3', null, 'Result'), h('pre', null, json(job.result))] : null,
    ];
    const d = drawer(`Task ${job.name}`, body, actions);
  }

  every(4000, async () => { if (auto.checked || !tableBox.firstChild) await load(); });
  if (openId) openJob(openId);
}

// ─── Logs ────────────────────────────────────────────────────────────
function viewLogs(root) {
  const level = h('select', null, h('option', { value: '' }, 'All levels'), LOG_LEVELS.map((l) => h('option', { value: l }, `${l} and above`)));
  const component = h('input', { placeholder: 'Component (http, session, queue…)', list: 'log-components' });
  const components = h('datalist', { id: 'log-components' });
  const q = h('input', { type: 'search', placeholder: 'Search text' });
  const live = h('input', { type: 'checkbox', checked: true });
  const tbody = h('tbody');
  const info = h('span', { class: 'small muted' });
  const seenComponents = new Set();
  let cursor = 0;
  let rows = [];
  const MAX_ROWS = 1000;

  const reset = () => { cursor = 0; rows = []; clear(tbody); load(); };
  level.addEventListener('change', reset);
  let t;
  for (const el of [component, q]) el.addEventListener('input', () => { clearTimeout(t); t = setTimeout(reset, 350); });

  const row = (l) => {
    const tr = h('tr', { class: 'clickable' },
      h('td', { title: l.at }, clock(l.at)),
      h('td', { class: `level-${l.level}` }, l.level),
      h('td', null, l.component ?? ''),
      h('td', { class: 'msg-cell' }, l.message));
    let detail = null;
    tr.addEventListener('click', () => {
      if (detail) { detail.remove(); detail = null; tr.classList.remove('expanded'); return; }
      tr.classList.add('expanded');
      detail = h('tr', { class: 'expanded' }, h('td', { colspan: 4 }, h('pre', null, json({ at: l.at, role: l.role, pid: l.pid, ...l.meta }))));
      tr.after(detail);
    });
    return tr;
  };

  async function load() {
    const res = (await api('GET', '/logs', { query: { after: cursor || undefined, limit: 500, level: level.value, component: component.value.trim(), q: q.value.trim() } })).data;
    if (res.entries.length) {
      cursor = res.cursor;
      rows.push(...res.entries);
      for (const l of res.entries) {
        if (l.component && !seenComponents.has(l.component)) { seenComponents.add(l.component); components.append(h('option', { value: l.component })); }
      }
      const frag = document.createDocumentFragment();
      for (const l of res.entries.slice().reverse()) frag.append(row(l));
      tbody.prepend(frag);
      if (rows.length > MAX_ROWS) {
        rows = rows.slice(-MAX_ROWS);
        while (tbody.children.length > MAX_ROWS) tbody.lastChild.remove();
      }
    }
    info.textContent = `${rows.length} shown · server keeps the last ${res.bufferSize}`;
  }

  root.append(
    pageHead('Logs', 'Server log records (secrets redacted). Newest first.',
      h('label', { class: 'check' }, live, 'Live'),
      h('button', { onclick: () => {
        const blob = new Blob([JSON.stringify(rows, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = h('a', { href: url, download: `arattix-logs-${new Date().toISOString().replace(/[:.]/g, '-')}.json` });
        document.body.append(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 5000);
      } }, 'Download'),
      h('button', { class: 'danger', onclick: async () => {
        if (!confirm('Clear the server log buffer for everyone?')) return;
        await api('DELETE', '/logs'); reset();
      } }, 'Clear buffer')),
    card(null, h('div', { class: 'stack' },
      h('div', { class: 'row' }, level, component, components, q, h('span', { class: 'spacer' }), info),
      h('div', { class: 'callout small' }, h('p', null, 'Access logs are recorded at the "http" level. Set LOG_LEVEL to http on the ', h('a', { href: '#/settings' }, 'Settings'), ' page to see every API request here.')),
      h('div', { class: 'table-wrap' }, h('table', { class: 'log-table' },
        h('thead', null, h('tr', null, h('th', null, 'Time'), h('th', null, 'Level'), h('th', null, 'Component'), h('th', null, 'Message'))),
        tbody)))),
  );
  every(2000, async () => { if (live.checked || cursor === 0) await load(); });
}

// ─── Events ──────────────────────────────────────────────────────────
function viewEvents(root) {
  const selected = new Set();
  const list = h('div', { class: 'stack' });
  const live = h('input', { type: 'checkbox', checked: true });
  let cursor = 0;
  let count = 0;
  const reset = () => { cursor = 0; count = 0; clear(list); load(); };
  const chips = h('div', { class: 'chips' }, EVENT_TYPES.map((t) => h('button', {
    class: 'chip', type: 'button',
    onclick: (e) => { selected.has(t) ? selected.delete(t) : selected.add(t); e.currentTarget.classList.toggle('on'); reset(); },
  }, t)));

  async function load() {
    const res = (await api('GET', '/events', { query: { after: cursor || undefined, limit: 200, type: [...selected].join(',') } })).data;
    if (res.entries.length) {
      cursor = res.cursor;
      if (count === 0) clear(list);
      for (const e of res.entries) {
        const pre = h('pre', { class: 'hidden' }, json(e.data));
        const item = eventRow(e);
        item.append(h('div', { class: 'row' }, h('span', { class: 'small muted mono' }, e.id), h('button', { class: 'small ghost', onclick: () => pre.classList.toggle('hidden') }, 'Payload')), pre);
        list.prepend(item);
        count += 1;
      }
      while (list.children.length > 500) list.lastChild.remove();
    } else if (count === 0) {
      put(list, h('div', { class: 'empty' }, 'No events yet. Incoming messages, sends, failures and session changes show up here.'));
    }
  }

  root.append(
    pageHead('Events', 'What happened on the Arattai session. The same events are delivered to webhooks.', h('label', { class: 'check' }, live, 'Live')),
    card(null, h('div', { class: 'stack' }, chips, list)),
  );
  every(3000, async () => { if (live.checked || cursor === 0) await load(); });
}

// ─── Webhooks ────────────────────────────────────────────────────────
function viewWebhooks(root) {
  const table = h('div');
  const created = h('div');
  const url = h('input', { required: true, type: 'url', placeholder: 'https://example.com/arattix-webhook' });
  const description = h('input', { maxlength: 500 });
  const secret = h('input', { minlength: 16, maxlength: 256, placeholder: 'leave empty to generate one' });
  const evBoxes = ['*', ...EVENT_TYPES].map((t) => {
    const box = h('input', { type: 'checkbox', value: t, checked: t === '*' });
    return h('label', { class: 'check' }, box, t === '*' ? '* (all except session.qr)' : t);
  });

  async function load() {
    const subs = (await api('GET', '/webhooks')).data;
    put(table, subs.length ? h('div', { class: 'table-wrap' }, h('table', null,
      h('thead', null, h('tr', null, ['URL', 'Events', 'Status', 'Last delivery', ''].map((t) => h('th', null, t)))),
      h('tbody', null, subs.map((s) => h('tr', null,
        h('td', null, h('div', { class: 'mono' }, s.url), s.description ? h('div', { class: 'small muted' }, s.description) : null, h('div', { class: 'small muted mono' }, s.id)),
        h('td', null, h('div', { class: 'chips' }, s.events.map((e) => badge(e)))),
        h('td', null, s.active ? badge('active', 'ok') : badge('disabled', 'bad'), s.disabledReason ? h('div', { class: 'small muted' }, s.disabledReason) : null, s.consecutiveFailures ? h('div', { class: 'small level-warn' }, `${s.consecutiveFailures} failures in a row`) : null),
        h('td', null, s.lastDeliveryAt ? rel(s.lastDeliveryAt) : 'never', s.lastStatus ? h('div', { class: 'small muted' }, `HTTP ${s.lastStatus}`) : null, s.lastError ? h('div', { class: 'small level-error' }, s.lastError) : null),
        h('td', null, h('div', { class: 'row end' },
          h('button', { class: 'small', disabled: !s.active, onclick: async () => {
            try { const r = await api('POST', `/webhooks/${s.id}/test`); toast(r.data.delivered ? 'Test delivered.' : 'Test queued.', 'ok'); } catch (err) { toast(errText(err), 'bad', 7000); }
            load();
          } }, 'Send test'),
          h('button', { class: 'small danger', onclick: async () => {
            if (!confirm(`Delete the webhook to ${s.url}?`)) return;
            try { await api('DELETE', `/webhooks/${s.id}`); toast('Webhook deleted.', 'ok'); } catch (err) { toast(errText(err), 'bad'); }
            load();
          } }, 'Delete'))))))))
      : h('div', { class: 'empty' }, 'No webhooks yet.'));
  }

  const submit = h('button', { class: 'primary', type: 'submit' }, 'Add webhook');
  root.append(
    pageHead('Webhooks', 'Signed HTTP callbacks for events (HMAC-SHA256 in X-Arattix-Signature).'),
    h('div', { class: 'stack' },
      card('Subscriptions', table),
      card('Add a webhook', h('form', {
        class: 'form',
        onsubmit: async (e) => {
          e.preventDefault();
          const events = evBoxes.map((l) => l.querySelector('input')).filter((b) => b.checked).map((b) => b.value);
          submit.disabled = true;
          try {
            const res = await api('POST', '/webhooks/subscribe', { body: { url: url.value.trim(), events: events.length ? events : ['*'], ...(description.value.trim() ? { description: description.value.trim() } : {}), ...(secret.value ? { secret: secret.value } : {}) } });
            put(created, h('div', { class: 'callout ok' },
              h('p', null, 'Webhook created. Copy the signing secret now: it is not shown again.'),
              h('pre', null, res.data.secret)));
            url.value = ''; description.value = ''; secret.value = '';
            load();
          } catch (err) {
            put(created, h('div', { class: 'callout bad' }, h('p', null, errText(err))));
          } finally { submit.disabled = false; }
        },
      },
      h('label', { class: 'field' }, 'URL', url),
      h('div', { class: 'field' }, h('span', null, 'Events'), h('div', { class: 'chips' }, evBoxes)),
      h('div', { class: 'inline' }, h('label', { class: 'field' }, 'Description', description), h('label', { class: 'field' }, 'Signing secret', secret)),
      h('div', { class: 'row' }, submit),
      created)),
    ),
  );
  load().catch((err) => put(table, h('div', { class: 'callout bad' }, h('p', null, errText(err)))));
}

// ─── Settings ────────────────────────────────────────────────────────
function viewSettings(root) {
  const body = h('div', { class: 'stack' }, h('div', { class: 'empty' }, 'Loading settings…'));
  const banner = h('div');
  const saveBtn = h('button', { class: 'primary', disabled: true }, 'Save changes');
  const restartBtn = h('button', { class: 'danger' }, 'Restart server');
  const changes = new Map();

  root.append(
    pageHead('Settings', 'Effective configuration of this server. Saved values override the environment and apply on the next start; live ones apply right away.', saveBtn, restartBtn),
    banner, body,
    card('This browser', kv([
      ['API key', apiKey ? `…${apiKey.slice(-4)} (${store.remembered(KEY_STORAGE) ? 'remembered on this device' : 'this tab only'})` : '—'],
      ['Theme', h('span', null, document.documentElement.dataset.theme ?? 'system')],
    ]), h('div', { class: 'row' }, h('button', { onclick: () => signOut() }, 'Sign out of the admin UI'))),
  );

  const render = (data) => {
    changes.clear();
    saveBtn.disabled = true;
    clear(banner);
    if (data.restartRequired) {
      banner.append(h('div', { class: 'callout warn' }, h('p', null, 'Saved changes are waiting for a restart. Restart the server (or every process in a split deployment) to apply them.')));
    }
    const groups = new Map();
    for (const s of data.settings) {
      if (!groups.has(s.group)) groups.set(s.group, []);
      groups.get(s.group).push(s);
    }
    clear(body);
    // Editable groups first; environment-only ones (secrets, topology) at the end.
    const ordered = [...groups].sort(([, a], [, b]) => Number(b.some((i) => i.editable)) - Number(a.some((i) => i.editable)));
    for (const [group, items] of ordered) {
      const editable = items.some((i) => i.editable);
      body.append(card(h('div', { class: 'card-head' }, h('h2', null, group), editable ? null : h('span', { class: 'small muted' }, 'environment only')), items.map(settingRow)));
    }
  };

  const settingRow = (s) => {
    const row = h('div', { class: 'setting' });
    let control;
    const current = s.pending !== null && s.pending !== '' ? s.pending : s.value ?? '';
    if (!s.editable) {
      control = h('code', null, s.value ?? '(not set)');
    } else if (s.key === 'LOG_LEVEL') {
      control = h('select', null, LOG_LEVELS.concat('silly').map((l) => h('option', { value: l }, l)));
      control.value = current;
    } else if (/^(true|false)$/.test(String(s.value))) {
      control = h('select', null, h('option', { value: 'true' }, 'true'), h('option', { value: 'false' }, 'false'));
      control.value = String(current);
    } else {
      control = h('input', { value: current, placeholder: s.value === null ? '(not set)' : '' });
    }
    const resetBtn = s.editable && (s.source === 'override' || (s.pending !== null && s.pending !== ''))
      ? h('button', { class: 'small ghost', onclick: () => { changes.set(s.key, null); row.classList.add('dirty'); saveBtn.disabled = false; toast(`${s.key} will go back to its environment/default value when you save.`); } }, 'Reset to env/default')
      : null;
    if (s.editable) {
      const handler = () => {
        const v = control.value.trim();
        if (v === String(current)) { changes.delete(s.key); row.classList.remove('dirty'); } else { changes.set(s.key, v); row.classList.add('dirty'); }
        saveBtn.disabled = changes.size === 0;
      };
      control.addEventListener('input', handler);
      control.addEventListener('change', handler);
    }
    append(row, [
      h('div', null,
        h('div', { class: 'name' }, s.key),
        h('div', { class: 'desc' }, s.description),
        h('div', { class: 'row small' },
          badge(s.source, s.source === 'override' ? 'info' : 'neutral'),
          s.live ? badge('live', 'ok') : null,
          s.secret ? badge('secret', 'warn') : null,
          s.pending !== null ? badge(s.pending === '' ? 'reset pending restart' : `pending: ${s.pending}`, 'warn') : null)),
      h('div', { class: 'control' }, control, resetBtn),
    ]);
    return row;
  };

  const load = async () => render((await api('GET', '/settings')).data);

  saveBtn.addEventListener('click', async () => {
    saveBtn.disabled = true;
    try {
      const res = await api('PUT', '/settings', { body: { values: Object.fromEntries(changes) } });
      render(res.data);
      toast(res.data.restartRequired ? 'Saved. Restart to apply the non-live settings.' : 'Saved.', 'ok');
    } catch (err) {
      saveBtn.disabled = false;
      const issues = Array.isArray(err.details) ? err.details.map((d) => `${d.path}: ${d.message}`).join('; ') : '';
      toast(`${errText(err)}${issues ? ` (${issues})` : ''}`, 'bad', 9000);
    }
  });

  restartBtn.addEventListener('click', async () => {
    if (!confirm('Restart the server now? In-flight requests finish first. A supervisor (Docker, PM2, systemd) must start it again, or it stays down.')) return;
    try {
      await api('POST', '/system/restart');
      toast('Restarting… this page reconnects when the server is back.', 'warn', 8000);
      const back = Date.now();
      const poll = async () => {
        try {
          const r = await fetch('/health/live', { cache: 'no-store' });
          if (r.ok && Date.now() - back > 3000) { toast('Server is back.', 'ok'); load(); return; }
        } catch { /* still down */ }
        setTimeout(poll, 1500);
      };
      setTimeout(poll, 2000);
    } catch (err) { toast(errText(err), 'bad'); }
  });

  load().catch((err) => put(body, h('div', { class: 'callout bad' }, h('p', null, errText(err)))));
}

// ─── boot ────────────────────────────────────────────────────────────
applyTheme();
if (apiKey) start();
else renderLogin();
