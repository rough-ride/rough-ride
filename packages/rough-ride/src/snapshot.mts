// `snapshot --run <id>` (spec part 11 sections 44.1 and 43.5): up to 5 step
// documents, each run in a fresh context, ending in an ASCII-escaped
// accessibility snapshot under adversary/snapshots/<k>.json. No reset.

import { randomBytes } from 'node:crypto';
import path from 'node:path';
import type { Page } from 'playwright-core';
import { asciiJson } from './adversary.mjs';
import { chooseBrowser, installedOnThisMachine, launchBrowser, type BrowserName, type Launched } from './browser.mjs';
import { checkCommittedFiles, wroteFile } from './files.mjs';
import { ensureFolder, type FolderState } from './folder.mjs';
import { runFlow, type Flow, type Step } from './flowrun.mjs';
import { splitDocuments, staticRefusal, MAX_INPUT } from './flowsave.mjs';
import { LocalhostGuard, type GuardPolicy } from './guard.mjs';
import { takeFlowLock } from './lock.mjs';
import { Manifest } from './manifest.mjs';
import { formatDuration, type Note } from './output.mjs';
import { compareProtected, summaryLines as protectedSummary } from './protected.mjs';
import { runnerBlock, type RunnerInfo } from './runner.mjs';
import { bashBlocksStart, bashDeadline, callCount, checkRun, recordCall, tierCommand } from './runcheck.mjs';
import { redactSecrets } from './secrets.mjs';
import { checkEnv, checkSignInEnv, envReader, signIn } from './session.mjs';
import type { Section } from './summary.mjs';
import { findTarget } from './target.mjs';
import { readyWaitFor } from './tier.mjs';
import { writeAtomic } from './write.mjs';

const MAX_DOCS = 5;
const MAX_NODES = 2000;
const MAX_BYTES = 128 * 1024;
const MAX_STRING = 500;

// 43.5: strings cut at 500 characters, at most 2,000 nodes (depth-first), the
// run's ${unique} token as the literal, env values redacted on write.
export function trimTree(tree: unknown, unique: string): { tree: unknown; nodes: number } {
  let nodes = 0;
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') {
      const s = unique ? v.split(unique).join('${unique}') : v;
      return s.length > MAX_STRING ? `${s.slice(0, MAX_STRING)}...(+${s.length - MAX_STRING} chars)` : s;
    }
    if (Array.isArray(v)) {
      const out: unknown[] = [];
      for (const x of v) {
        if (nodes >= MAX_NODES) break;
        if (x && typeof x === 'object') nodes++;
        out.push(walk(x));
      }
      return out;
    }
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  nodes = 1;
  return { tree: walk(tree), nodes };
}

export function snapshotText(pagePath: string, title: string, tree: unknown, unique: string): { text: string; nodes: number } {
  let { tree: t, nodes } = trimTree(tree, unique);
  let text = asciiJson(redactSecrets(JSON.stringify({ path: pagePath, title: trimTree(title, unique).tree, tree: t })));
  // Over 128 KB: halve the node budget until it fits.
  let budget = nodes;
  while (Buffer.byteLength(text) > MAX_BYTES && budget > 1) {
    budget = Math.floor(budget / 2);
    const cut = (v: unknown, left: { n: number }): unknown => {
      if (Array.isArray(v)) return v.filter((x) => !(x && typeof x === 'object') || left.n-- > 0).map((x) => cut(x, left));
      if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, cut(x, left)]));
      return v;
    };
    t = cut(trimTree(tree, unique).tree, { n: budget });
    nodes = budget;
    text = asciiJson(redactSecrets(JSON.stringify({ path: pagePath, title, tree: t })));
  }
  return { text: text + '\n', nodes };
}

export interface SnapshotContext {
  root: string;
  folder: FolderState;
  info: RunnerInfo;
  runId: string;
  stdin: string;
  browserFlag: BrowserName | null;
  argv: string[];
  env: NodeJS.ProcessEnv;
  notes: Note[];
  elapsed: () => number;
  launch?: (name: BrowserName) => Promise<Launched>;
}

export async function runSnapshot(ctx: SnapshotContext): Promise<{ lines: string[]; document: Record<string, unknown>; status: 'passed' | 'incomplete'; exitCode: 0 | 2 }> {
  const { root, info } = ctx;
  const folder = ensureFolder(ctx.folder);
  const manifest = new Manifest(root);
  const plan = checkRun(folder, ctx.runId, info, manifest);
  let protLines: string[] = [];
  const finish = (body: string[], exitCode: 0 | 2) => {
    const header = ['rough-ride snapshot', formatDuration(ctx.elapsed()), `run ${ctx.runId}`].join(' | ');
    const sections: Section[] = [{ id: 'header', lines: [header] }, { id: 'protected', lines: protLines }, { id: 'flows', lines: body }, { id: 'runner', lines: runnerBlock(info) }].filter((x) => x.lines.length > 0) as Section[];
    return { lines: sections.flatMap((x) => x.lines), document: { sections }, status: exitCode === 0 ? 'passed' as const : 'incomplete' as const, exitCode };
  };
  if (callCount(folder, ctx.runId, 'snapshot') >= 3) return finish([`Not run: snapshot (run ${ctx.runId} already made 3 snapshot calls)`], 2);
  const files = checkCommittedFiles(folder, { info, subcommand: 'snapshot', argv: ctx.argv, env: ctx.env });
  ctx.notes.push(...files.notes);
  const prot = compareProtected({ root, folderDir: folder.dir, files, env: ctx.env, pluginData: !!info.pluginData, manifest });
  protLines = protectedSummary(prot);
  ctx.notes.push(...prot.notes);

  if (Buffer.byteLength(ctx.stdin) > MAX_INPUT) return finish(['Not run: snapshot (input over 24 KB)'], 2);
  const texts = splitDocuments(ctx.stdin);
  if (texts.length === 0 || texts.length > MAX_DOCS) return finish([`Not run: snapshot (1 to ${MAX_DOCS} step documents; got ${texts.length})`], 2);
  const docs = texts.map((text, i) => {
    const s = staticRefusal('snapshot', text);
    return { k: i + 1, value: s.value, refused: s.refused?.replace(/^Not saved: snapshot/, `Not run: snapshot ${i + 1}`) ?? null };
  });

  const out: string[] = docs.filter((d) => d.refused).map((d) => d.refused!);
  const runnable = docs.filter((d) => !d.refused);
  const read = envReader(folder, ctx.env);
  const flowOf = (d: (typeof runnable)[number]): Flow => ({ name: `snapshot-${d.k}`, signedIn: d.value!.signedIn as boolean, steps: d.value!.steps as Step[] });
  for (const d of runnable) checkEnv(flowOf(d), read, folder, ctx.env);
  // A signed-in document runs the sign-in flow, so its variables are checked before anything starts (51.8).
  if (runnable.some((d) => d.value!.signedIn)) checkSignInEnv(prot.flows.map((e) => e.flow), folder, ctx.env);
  if (runnable.length > 0) {
    const config = prot.config;
    const target = await findTarget({ root, config, configSchema: files.config?.schema?.text ?? null, start: false, pluginData: info.pluginData?.path ?? null, againCommand: tierCommand(info, plan.tier), notes: ctx.notes });
    wroteFile(files, info, root, target.nuxtRoot?.rel ?? null, ctx.argv);
    const lock = takeFlowLock(root, ctx.notes);
    const policy: GuardPolicy = { remoteTarget: config?.allow?.remoteTarget ?? null, remoteWrites: config?.allow?.remoteWrites ?? [] };
    const allowed = [policy.remoteTarget, ...policy.remoteWrites].filter((h): h is string => !!h);
    const choice = chooseBrowser(ctx.browserFlag, config?.browser ?? null, installedOnThisMachine(ctx.env));
    const launched = ctx.launch ? await ctx.launch(choice.name) : await launchBrowser(choice, ctx.notes);
    const guard = launched.debugPort ? await LocalhostGuard.connect(launched.debugPort, policy) : undefined;
    const processStart = Date.now() - ctx.elapsed();
    const bashStop = bashDeadline(!!info.pluginData, processStart);
    try {
      const ready = readyWaitFor(target, config);
      const exclude = config?.exclude ?? [];
      const flows = prot.flows.map((e) => e.flow);
      // The sign-in flow once per call, only when a document is signed in; no reset (44.1).
      const session = runnable.some((d) => d.value!.signedIn) ? await signIn({ browser: launched.browser, baseURL: target.url, flows, read, folder, ready, exclude, deadline: bashStop }) : null;
      for (const d of runnable) {
        const flow = flowOf(d);
        if (bashBlocksStart(!!info.pluginData, processStart, Date.now())) {
          out.push(`Not run: snapshot ${d.k} (stopped by the Bash time limit)`);
          continue;
        }
        if (flow.signedIn && !session?.passed) {
          out.push(`Not run: snapshot ${d.k} (${session ? 'sign-in failed' : 'no sign-in flow'})`);
          continue;
        }
        const unique = randomBytes(6).toString('base64url').toLowerCase().replace(/[^a-z0-9]/g, '0').slice(0, 8);
        const file = path.join(folder.dir, 'runs', ctx.runId, 'adversary', 'snapshots', `${d.k}.json`);
        let nodes = 0;
        const take = async (page: Page) => {
          const tree = await page.ariaSnapshotJSON({ mode: 'default', timeout: 10_000 });
          const snap = snapshotText(new URL(page.url()).pathname, await page.title().catch(() => ''), tree, unique);
          nodes = snap.nodes;
          writeAtomic(folder, ['runs', ctx.runId, 'adversary', 'snapshots', `${d.k}.json`], snap.text);
        };
        const result = await runFlow({
          browser: launched.browser, baseURL: target.url, flow, env: read, ready, exclude, allowedHosts: allowed, guard, unique,
          storageState: flow.signedIn ? session?.storageState ?? undefined : undefined,
          untrusted: true,
          deadline: bashStop,
          onFailure: async (page) => take(page),
          onFinish: take,
        } as Parameters<typeof runFlow>[0]);
        out.push(`Snapshot ${d.k}: ${file.split(path.sep).join('/')} (${nodes} nodes)`);
        if (result.failure) {
          const msg = result.failure.message.startsWith(`${result.failure.label}: `) ? result.failure.message.slice(result.failure.label.length + 2) : result.failure.message;
          out.push(`  step ${result.failure.step} failed: ${asciiJson(JSON.stringify(msg.split('\n')[0]!.slice(0, 300)))}`);
        }
      }
    } finally {
      guard?.close();
      await launched.browser.close().catch(() => {});
      lock.release();
    }
  }
  recordCall(folder, ctx.runId, 'snapshot', ctx.elapsed());
  return finish(out, 0);
}
