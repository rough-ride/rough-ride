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

export function isLoopbackHostname(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return h === 'localhost' || h.endsWith('.localhost') || h === '::1' || /^127\./.test(h);
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

export function hostPolicy(allow: { remoteTarget?: string | null; remoteWrites?: string[] } | undefined): HostPolicy {
  const remoteTarget = allow?.remoteTarget ?? null;
  const remoteWrites = allow?.remoteWrites ?? [];
  const allowed = [remoteTarget, ...remoteWrites].filter((h): h is string => !!h);
  return {
    remoteTarget,
    remoteWrites,
    ownHost: (url) => {
      const host = hostOf(url);
      return host !== null && (isLoopbackHostname(host) || allowed.includes(host));
    },
    forwardable: (url) => {
      const host = hostOf(url);
      return host !== null && (isLoopbackHostname(host) || host === remoteTarget);
    },
    // A URL with no host can't reach one, so the guard lets it continue.
    writeAllowed: (url) => {
      const host = hostOf(url)?.replace(/^\[|\]$/g, '');
      return host === undefined || isLoopbackHostname(host) || host === remoteTarget || remoteWrites.includes(host);
    },
  };
}

// No allow values: only loopback hosts are the Target's.
export const LOOPBACK_ONLY: HostPolicy = hostPolicy(undefined);
