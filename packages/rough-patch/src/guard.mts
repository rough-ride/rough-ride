// The localhost guard (spec part 2 section 10): the runner's own CDP
// connection to the browser, never a Playwright route. Browser writes to a
// host that is neither loopback, nor the applied allow.remoteTarget host, nor
// in the applied allow.remoteWrites are failed with BlockedByClient; every
// other request continues, so CORS preflights stay real.

import { isLoopbackHostname } from './flowrun.mjs';

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const RESOURCE_TYPES = ['Document', 'XHR', 'Fetch', 'Ping', 'EventSource', 'Other'];

export interface GuardPolicy {
  remoteTarget: string | null;
  remoteWrites: string[];
}

export interface AbortedWrite {
  host: string;
  method: string;
  path: string;
  count: number;
  // The CDP browser contexts the write came from, to tie it to a flow run.
  contexts: Set<string>;
}

export function writeAllowed(url: string, policy: GuardPolicy): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.replace(/^\[|\]$/g, '');
  } catch {
    return true;
  }
  return isLoopbackHostname(host) || host === policy.remoteTarget || policy.remoteWrites.includes(host);
}

interface Message {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  sessionId?: string;
  result?: unknown;
  error?: { message: string };
}

export class LocalhostGuard {
  readonly policy: GuardPolicy;
  readonly aborted = new Map<string, AbortedWrite>();
  // Write requests that continued, counted per host.
  readonly perHost = new Map<string, number>();
  private readonly ws: WebSocket;
  private nextId = 0;
  private readonly pending = new Map<number, (m: Message) => void>();
  private readonly contextOf = new Map<string, string>();

  private constructor(ws: WebSocket, policy: GuardPolicy) {
    this.ws = ws;
    this.policy = policy;
    ws.addEventListener('message', (event) => this.onMessage(JSON.parse(String(event.data)) as Message));
  }

  // Connects to the browser's debugging endpoint and attaches to every target
  // before it runs, popups, cross-origin iframes and workers included.
  static async connect(debugPort: number, policy: GuardPolicy): Promise<LocalhostGuard> {
    const version = (await (await fetch(`http://127.0.0.1:${debugPort}/json/version`)).json()) as { webSocketDebuggerUrl: string };
    const ws = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve(), { once: true });
      ws.addEventListener('error', () => reject(new Error('guard connection failed')), { once: true });
    });
    const guard = new LocalhostGuard(ws, policy);
    await guard.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
    return guard;
  }

  private send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<Message> {
    const id = ++this.nextId;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      try {
        this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      } catch {
        this.pending.delete(id);
        resolve({ id, error: { message: 'closed' } });
      }
    });
  }

  private async attach(params: Record<string, unknown>): Promise<void> {
    const sessionId = params.sessionId as string;
    const info = params.targetInfo as { type: string; browserContextId?: string };
    if (info.browserContextId) this.contextOf.set(sessionId, info.browserContextId);
    if (['page', 'iframe', 'worker', 'shared_worker', 'service_worker'].includes(info.type)) {
      await this.send(
        'Fetch.enable',
        { patterns: RESOURCE_TYPES.map((resourceType) => ({ urlPattern: '*', resourceType, requestStage: 'Request' })) },
        sessionId,
      );
    }
    if (info.type === 'page' || info.type === 'iframe') {
      await this.send('Network.enable', {}, sessionId);
      await this.send('Network.setCacheDisabled', { cacheDisabled: true }, sessionId);
    }
    await this.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, sessionId);
    await this.send('Runtime.runIfWaitingForDebugger', {}, sessionId);
  }

  private onMessage(message: Message): void {
    if (message.id !== undefined) {
      this.pending.get(message.id)?.(message);
      this.pending.delete(message.id);
      return;
    }
    if (message.method === 'Target.attachedToTarget') {
      void this.attach(message.params!).catch(() => {});
      return;
    }
    if (message.method === 'Fetch.requestPaused') {
      const params = message.params as { requestId: string; request: { method: string; url: string } };
      const sessionId = message.sessionId;
      const { method, url } = params.request;
      if (WRITE_METHODS.has(method) && !writeAllowed(url, this.policy)) {
        this.record(method, url, sessionId);
        void this.send('Fetch.failRequest', { requestId: params.requestId, errorReason: 'BlockedByClient' }, sessionId);
        return;
      }
      if (WRITE_METHODS.has(method)) {
        try {
          const host = new URL(url).hostname;
          this.perHost.set(host, (this.perHost.get(host) ?? 0) + 1);
        } catch {
          // Not a URL with a host.
        }
      }
      void this.send('Fetch.continueRequest', { requestId: params.requestId }, sessionId);
    }
  }

  private record(method: string, url: string, sessionId: string | undefined): void {
    const u = new URL(url);
    const key = `${method} ${u.hostname} ${u.pathname}`;
    const entry = this.aborted.get(key) ?? { host: u.hostname, method, path: u.pathname, count: 0, contexts: new Set<string>() };
    entry.count++;
    const context = sessionId ? this.contextOf.get(sessionId) : undefined;
    if (context) entry.contexts.add(context);
    this.aborted.set(key, entry);
  }

  // Writes aborted in one browser context (one flow run).
  abortedIn(browserContextId: string): AbortedWrite[] {
    return [...this.aborted.values()].filter((w) => w.contexts.has(browserContextId));
  }

  // The `aborted-writes` note, or null when nothing was aborted.
  note(): { id: string; text: string } | null {
    const writes = [...this.aborted.values()];
    if (writes.length === 0) return null;
    const total = writes.reduce((n, w) => n + w.count, 0);
    const hosts = [...new Set(writes.map((w) => w.host))].sort().join(', ');
    return {
      id: 'aborted-writes',
      text: `Aborted ${total} browser ${total === 1 ? 'write' : 'writes'} to ${hosts}: not allowed by allow.remoteWrites in config.yaml.`,
    };
  }

  // The run record's `writes {perHost {}, aborted[{host, method, path, count}]}`.
  writesRecord(): { perHost: Record<string, number>; aborted: { host: string; method: string; path: string; count: number }[] } {
    return {
      perHost: Object.fromEntries([...this.perHost.entries()].sort()),
      aborted: [...this.aborted.values()]
        .map(({ host, method, path, count }) => ({ host, method, path, count }))
        .sort((a, b) => `${a.host} ${a.path}`.localeCompare(`${b.host} ${b.path}`)),
    };
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      // Already closed with the browser.
    }
  }
}

// Header line 3's suffix, listing only the applied allow values.
export function allowedSuffix(policy: GuardPolicy): string {
  const parts: string[] = [];
  if (policy.remoteTarget) parts.push(`remote target ${policy.remoteTarget}`);
  if (policy.remoteWrites.length > 0) parts.push(`remote writes ${policy.remoteWrites.join(', ')}`);
  return parts.length === 0 ? '' : ` | allowed by config.yaml: ${parts.join(', ')}`;
}

// What a baseline run broken by an abort adds to its error.
export function abortedHint(writes: AbortedWrite[]): string {
  const hosts = [...new Set(writes.map((w) => w.host))].sort();
  return `rough-patch aborted browser writes to ${hosts.join(', ')}; to allow them, add ${hosts.length === 1 ? 'it' : 'them'} to allow.remoteWrites in .rough-patch/config.yaml`;
}
