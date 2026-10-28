// Steps 1, 2, 3 and 5 of checking a committed YAML file under .rough-patch/
// (spec part 2 sections 7.5 and 7.6). Step 4, the schema range, follows them.

import { isMap, isScalar, LineCounter, parseAllDocuments, Scalar, type Document } from 'yaml';
import { FORMATS, SCHEMA_VERSION, type FormatKind, type Formats } from './formats.mjs';
import { escapeName } from './output.mjs';
import { validate, type JsonSchema, type SchemaError } from './schema.mjs';

export interface CommittedFile {
  // `.rough-patch/config.yaml`, as printed.
  shown: string;
  // null when the file is empty or holds only comments.
  value: Record<string, unknown> | null;
  // The `schema` scalar's source text, and its line.
  schema: { text: string; line: number } | null;
  // Failures of steps 1 to 3, and of step 5, as printed lines.
  problems: string[];
  step5: string[];
}

const KIND_WORDS: Record<FormatKind, string> = {
  config: 'config',
  flow: 'flow',
  tests: 'regression test',
  accepted: 'accepted.yaml',
  plan: 'plan',
};

function dotted(path: (string | number)[]): string {
  return path.map((part, i) => (typeof part === 'number' ? `[${part}]` : i === 0 ? part : `.${part}`)).join('');
}

export function parseCommitted(
  text: string,
  shown: string,
  kind: FormatKind,
  schema: JsonSchema,
  formats: Formats = FORMATS,
): CommittedFile {
  const file: CommittedFile = { shown, value: null, schema: null, problems: [], step5: [] };
  const lines = new LineCounter();
  const lineAt = (offset: number) => lines.linePos(offset).line;
  const docs = parseAllDocuments(text, { lineCounter: lines, prettyErrors: false });
  if (!Array.isArray(docs)) {
    // The yaml package returns an empty stream object for an empty source.
    return file;
  }
  const doc = docs[0];
  if (doc === undefined) return file;

  // Step 1: YAML 1.2, no duplicate key, one document.
  const version = doc.directives?.yaml;
  if (version?.explicit && version.version !== '1.2') {
    file.problems.push(`${shown} line 1: %YAML ${version.version} directive; rough-patch reads YAML 1.2 only.`);
    return file;
  }
  for (const error of doc.errors) {
    const line = lineAt(error.pos[0]);
    if (error.code === 'DUPLICATE_KEY') {
      const key = /^\s*(["']?)([^:"'\n]+)\1\s*:/.exec(text.slice(error.pos[0]))?.[2]?.trim() ?? 'a key';
      file.problems.push(`${shown} line ${line}: ${escapeName(key)} appears twice in the same mapping.`);
    } else {
      const reason = error.message.split('\n')[0]!.replace(/ at line \d+, column \d+:?$/, '');
      file.problems.push(`${shown} line ${line}: not valid YAML (${escapeName(reason, 120)}).`);
    }
  }
  if (docs.length > 1) {
    const second = docs[1]!.range[0];
    file.problems.push(`${shown} line ${lineAt(second)}: a second YAML document; rough-patch reads one document per file.`);
  }
  if (file.problems.length > 0) return file;
  if (doc.contents === null) return file;

  // Step 2: the top level is a mapping.
  if (!isMap(doc.contents)) {
    file.problems.push(`${shown}: the top level must be a mapping (key: value lines).`);
    return file;
  }

  // Step 3: schema is present and well formed, judged on its source text.
  const { current } = formats[kind];
  const pair = doc.contents.items.find((item) => isScalar(item.key) && item.key.value === 'schema');
  if (pair === undefined) {
    file.problems.push(
      `${shown} has no schema line. Add "schema: ${current}" as its first line: the ${KIND_WORDS[kind]} format rough-patch ${current} reads.`,
    );
    return file;
  }
  const node = pair.value;
  let source = '';
  let line = isScalar(pair.key) && pair.key.range ? lineAt(pair.key.range[0]) : 1;
  if (isScalar(node) && node.range) {
    line = lineAt(node.range[0]);
    source = node.type === Scalar.PLAIN ? text.slice(node.range[0], node.range[1]).trim() : String(node.value);
  }
  if (!SCHEMA_VERSION.test(source)) {
    file.problems.push(
      `${shown} line ${line}: schema must be a rough-patch version with three parts, such as ${current} (found ${escapeName(source || 'nothing')}).`,
    );
    return file;
  }
  file.schema = { text: source, line };

  // Step 5: unknown fields and wrong types against the current format.
  const value = { ...(doc.toJS() as Record<string, unknown>), schema: source };
  file.value = value;
  for (const error of validate(schema, value)) {
    if (error.kind === 'missing' && error.path.join('.') === 'schema') continue;
    file.step5.push(describeError(shown, doc, lineAt, error));
  }
  return file;
}

function describeError(shown: string, doc: Document, lineAt: (offset: number) => number, error: SchemaError): string {
  const where = dotted(error.path);
  const line = lineOf(doc, lineAt, error);
  const prefix = line === null ? shown : `${shown} line ${line}`;
  switch (error.kind) {
    case 'unknown-field':
      return `${prefix}: ${escapeName(where, 80)} is not a field rough-patch reads here.`;
    case 'missing':
      return `${prefix}: ${escapeName(where, 80)} is missing.`;
    default:
      return `${prefix}: ${escapeName(where, 80)} must be ${error.expected}.`;
  }
}

function lineOf(doc: Document, lineAt: (offset: number) => number, error: SchemaError): number | null {
  const parentPath = error.path.slice(0, -1);
  const last = error.path.at(-1);
  const parent = parentPath.length === 0 ? doc.contents : doc.getIn(parentPath, true);
  if (isMap(parent)) {
    const pair = parent.items.find((item) => isScalar(item.key) && item.key.value === last);
    const key = pair?.key;
    if (isScalar(key) && key.range) return lineAt(key.range[0]);
    if (parent.range) return lineAt(parent.range[0]);
  }
  const node = doc.getIn(error.path, true) as { range?: [number, number, number] } | undefined;
  return node?.range ? lineAt(node.range[0]) : null;
}
