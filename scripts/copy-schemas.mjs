// Part of npm run build: copies the JSON Schema files and the resilience
// contract's editions file next to the compiled runner, and writes the tier
// table as dist/tiers.json (spec sections 40.7 and 47.5).
import { cpSync, writeFileSync } from 'node:fs';

cpSync(
  new URL('../packages/rough-patch/src/schemas/', import.meta.url),
  new URL('../packages/rough-patch/dist/schemas/', import.meta.url),
  { recursive: true },
);
cpSync(
  new URL('../packages/rough-patch/src/contract-editions.json', import.meta.url),
  new URL('../packages/rough-patch/dist/contract-editions.json', import.meta.url),
);

const { tierTableJson } = await import('../packages/rough-patch/dist/tiers.mjs');
writeFileSync(new URL('../packages/rough-patch/dist/tiers.json', import.meta.url), tierTableJson());
