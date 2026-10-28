// SIGINT exits 130 and SIGTERM 143 after the handler has written what
// completed; a second signal exits at once.

export type InterruptSignal = 'SIGINT' | 'SIGTERM';

// A terminal Ctrl-C reaches the whole process group and npm forwards it as
// well, so the same signal again within 1 s is the same one (51.13).
const SAME_SIGNAL_MS = 1000;

export function onInterrupt(handler: (signal: InterruptSignal) => void | Promise<void>): void {
  let first: { signal: InterruptSignal; at: number } | null = null;
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      const code = signal === 'SIGINT' ? 130 : 143;
      if (first) {
        if (first.signal === signal && Date.now() - first.at < SAME_SIGNAL_MS) return;
        process.exit(code);
      }
      first = { signal, at: Date.now() };
      // The handler starts at once, in this listener, before any other code runs.
      void new Promise<void>((resolve) => resolve(handler(signal))).finally(() => process.exit(code));
    });
  }
}
