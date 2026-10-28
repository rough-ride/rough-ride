// The tier table (spec part 12 section 47.5): every constant of the tier
// budgets, the bands and the cut. The build writes it as canonical JSON to
// dist/tiers.json, and record.json names its sha256.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { FAULT_KINDS, type FaultId } from './faults.mjs';
import { S, C } from './flowrun.mjs';
import { canonicalJson } from './output.mjs';

export type TierName = 'quick' | 'standard';

export type TierKind =
  | { rank: number; band: 1 | 2 | 3; signInFlow: boolean; appliesTo: string; fault: FaultId; sticky: boolean }
  | { rank: number; band: 1 | 2 | 3; signInFlow: boolean; appliesTo: string; timing: string }
  | { rank: number; band: 1 | 2 | 3; signInFlow: boolean; appliesTo: string; badInputs: { from: number; to: number; perField: number | null; select: boolean } }
  | { rank: number; band: 1 | 2 | 3; signInFlow: boolean; appliesTo: string; viewport: 375 };

export interface TierSpec {
  budgetMs: number;
  serialGraceMs: number;
  confirmRuns: number;
  reservedConfirmRuns: number;
  tests: number;
  planCap: number;
  newFlows: number;
  repairs: number;
  flowSaveCalls: number;
  patchLines: number;
  kinds: TierKind[];
}

const faultKinds = (bands: number[]): TierKind[] =>
  FAULT_KINDS.filter((k) => bands.includes(k.band)).map((k) => ({ rank: k.rank, band: k.band, signInFlow: k.signInFlow, appliesTo: k.appliesTo, fault: k.fault, sticky: k.sticky }));

const BAND1: TierKind[] = [
  { rank: 2, band: 1, signInFlow: false, appliesTo: 'changed-form', badInputs: { from: 1, to: 3, perField: 1, select: false } },
  { rank: 3, band: 1, signInFlow: false, appliesTo: 'post-steps', timing: 'double-submit' },
  { rank: 7, band: 1, signInFlow: false, appliesTo: 'every-flow', viewport: 375 },
];

const BAND23: TierKind[] = [
  { rank: 8, band: 2, signInFlow: false, appliesTo: 'changed-form', badInputs: { from: 4, to: 12, perField: null, select: true } },
  { rank: 11, band: 2, signInFlow: false, appliesTo: 'get-fields', timing: 'out-of-order' },
  { rank: 14, band: 2, signInFlow: false, appliesTo: 'in-app-entries', timing: 'refresh' },
  { rank: 15, band: 2, signInFlow: false, appliesTo: 'signed-in-entries', timing: 'signed-out-reload' },
  { rank: 19, band: 3, signInFlow: false, appliesTo: 'in-app-entries-from-another-path', timing: 'back' },
];

const byRank = (kinds: TierKind[]) => [...kinds].sort((a, b) => a.rank - b.rank);

export const TIER_TABLE = {
  runner: 'rough-patch',
  constants: { S, H: S + 2000, C },
  lanes: [
    { cpus: 1, lanes: 1 },
    { cpus: 2, lanes: 2 },
    { cpus: 3, lanes: 2 },
    { cpus: 4, lanes: 3 },
    { cpus: 5, lanes: 4 },
  ],
  nominal: {
    perRunMs: 400,
    fullLoadMs: 1500,
    actionStepMs: 800,
    expectMs: 100,
    surcharges: {
      stickyWriteGraceMs: 2000,
      stickyReadGraceMs: 5000,
      oneShotMs: 2000,
      hangStepMs: 14000,
      delayMs: 5000,
      doubleSubmitMs: 500,
      outOfOrderMs: 4300,
      refreshMs: 1500,
      backMs: 3000,
      signedOutReloadMs: 1500,
      openApiMs: 2000,
      reportMs: 3000,
    },
  },
  referenceLanes: 3,
  tiers: {
    quick: {
      budgetMs: 120_000, serialGraceMs: 30_000, confirmRuns: 5, reservedConfirmRuns: 3, tests: 6, planCap: 8,
      newFlows: 3, repairs: 2, flowSaveCalls: 4, patchLines: 2000,
      kinds: byRank([...faultKinds([1]), ...BAND1]),
    },
    standard: {
      budgetMs: 450_000, serialGraceMs: 30_000, confirmRuns: 8, reservedConfirmRuns: 5, tests: 24, planCap: 20,
      newFlows: 8, repairs: 6, flowSaveCalls: 4, patchLines: 6000,
      kinds: byRank([...faultKinds([1, 2, 3]), ...BAND1, ...BAND23]),
    },
  } satisfies Record<TierName, TierSpec>,
};

export function tierTableJson(): string {
  return canonicalJson(TIER_TABLE);
}

// The sha256 of dist/tiers.json as shipped, or of the compiled table when the file is absent.
export function tierTableSha256(): string {
  let text: string;
  try {
    text = readFileSync(new URL('./tiers.json', import.meta.url), 'utf8');
  } catch {
    text = tierTableJson();
  }
  return createHash('sha256').update(text).digest('hex');
}
