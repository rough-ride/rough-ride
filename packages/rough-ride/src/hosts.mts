// The Target's host rules (spec part 2 sections 10.1, 10.2 and 10.4,
// resolution 4), built once from the applied `allow` values of config.yaml:
//   ownHost: loopback, allow.remoteTarget or an allow.remoteWrites host, the
//     Target's own origins (fault attack points, settling, cookies);
//   forwardable: loopback or allow.remoteTarget, the only hosts the runner
//     itself contacts (body-fault forwarding, OpenAPI fetches);
//   writeAllowed: what the localhost guard lets a browser write to.

export interface HostPolicy {
  // The applied values as config.yaml spells them, for the report and summary.json.
  readonly remoteTarget: string | null;
  readonly remoteWrites: string[];
  ownHost(url: string): boolean;
  forwardable(url: string): boolean;
  writeAllowed(url: string): boolean;
}

// One spelling for comparing hosts: URL.hostname brackets an IPv6 address and
// lower-cases names, while config.yaml may write either form (10.1, 10.4).
export function normalHost(host: string): string {
  return host.replace(/^\[|\]$/g, '').toLowerCase();
}

// 127.0.0.0/8 only as an IPv4 address: URL.hostname writes one as four numbers.
export function isLoopbackHostname(hostname: string): boolean {
  const h = normalHost(hostname);
  return h === 'localhost' || h.endsWith('.localhost') || h === '::1' || /^127(\.\d{1,3}){3}$/.test(h);
}

function hostOf(url: string): string | null {
  try {
    return normalHost(new URL(url).hostname);
  } catch {
    return null;
  }
}

export function hostPolicy(allow: { remoteTarget?: string | null; remoteWrites?: string[] } | undefined): HostPolicy {
  const remoteTarget = allow?.remoteTarget ?? null;
  const remoteWrites = allow?.remoteWrites ?? [];
  const target = remoteTarget ? normalHost(remoteTarget) : null;
  const writes = remoteWrites.map(normalHost);
  return {
    remoteTarget,
    remoteWrites,
    ownHost: (url) => {
      const host = hostOf(url);
      return host !== null && (isLoopbackHostname(host) || host === target || writes.includes(host));
    },
    forwardable: (url) => {
      const host = hostOf(url);
      return host !== null && (isLoopbackHostname(host) || host === target);
    },
    // A URL with no host can't reach one, so the guard lets it continue.
    writeAllowed: (url) => {
      const host = hostOf(url);
      return host === null || isLoopbackHostname(host) || host === target || writes.includes(host);
    },
  };
}

// No allow values: only loopback hosts are the Target's.
export const LOOPBACK_ONLY: HostPolicy = hostPolicy(undefined);
