// Per file kind, `current` is the last release that changed the format and
// `floor` the last that broke it (spec part 2 section 7.5).

export type FormatKind = 'config' | 'flow' | 'tests' | 'accepted' | 'plan';

export const FORMATS: Formats = {
  config: { current: '0.1.0', floor: '0.1.0' },
  flow: { current: '0.1.0', floor: '0.1.0' },
  tests: { current: '0.1.0', floor: '0.1.0' },
  accepted: { current: '0.1.0', floor: '0.1.0' },
  plan: { current: '0.1.0', floor: '0.1.0' },
};

export const SCHEMA_VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;

export type Formats = Record<FormatKind, { current: string; floor: string }>;

// Part by part as numbers, so 0.10.0 is above 0.9.0.
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

export interface FormatReport {
  current: string;
  floor: string;
  lowest: string | null;
  highest: string | null;
}

export type FormatsReport = Record<FormatKind, FormatReport>;

// The run record's formats: the runner's constants, and the lowest and highest
// schema among the files of each kind this invocation read or wrote.
export function formatsReport(seen: Partial<Record<FormatKind, string[]>> = {}, formats: Formats = FORMATS): FormatsReport {
  const report = {} as FormatsReport;
  for (const kind of Object.keys(formats) as FormatKind[]) {
    const versions = [...(seen[kind] ?? [])].sort(compareVersions);
    report[kind] = {
      ...formats[kind],
      lowest: versions[0] ?? null,
      highest: versions.at(-1) ?? null,
    };
  }
  return report;
}

export function schemaUrl(kind: FormatKind, formats: Formats = FORMATS): string {
  const file = { config: 'config', flow: 'flow', tests: 'test', accepted: 'accepted', plan: 'plan' }[kind];
  return `https://raw.githubusercontent.com/rough-patch/rough-patch/v${formats[kind].current}/packages/rough-patch/src/schemas/${file}.schema.json`;
}

// The first two lines of every config template and whole config file the
// runner prints.
export function configHeader(formats: Formats = FORMATS): string {
  return `# yaml-language-server: $schema=${schemaUrl('config', formats)}\nschema: ${formats.config.current}\n`;
}
