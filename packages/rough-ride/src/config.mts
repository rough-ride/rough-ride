// .rough-ride/config.yaml (spec part 2 section 7). Only people write it; the
// runner reads it and never changes a byte.

import { parseCommitted, type CommittedFile } from './committed.mjs';
import { stopWith } from './exit.mjs';
import { readFolderFile, type FolderState } from './folder.mjs';
import { loadSchema } from './schema.mjs';

export interface Config {
  schema: string;
  target?: {
    url?: string;
    start?: string | string[];
    startTimeout?: number;
    ready?: string;
  };
  reset?: string;
  browser?: 'chrome' | 'msedge' | 'chromium';
  exclude?: string[];
  allow?: {
    remoteTarget?: string;
    remoteWrites?: string[];
  };
}

export const CONFIG_SHOWN = '.rough-ride/config.yaml';

// Parses and checks the working copy. Null when there is no file, or it is
// empty or holds only comments. Until reviewed versions exist (ticket 30), the
// working copy is the effective config.
export function checkConfig(folder: FolderState): CommittedFile | null {
  const text = readFolderFile(folder, 'config.yaml');
  if (text === null) return null;
  return parseCommitted(text, CONFIG_SHOWN, 'config', loadSchema('config.schema.json'));
}

// Any failure in steps 1 to 3 or 5 stops the invocation with exit 78.
export function loadConfig(folder: FolderState): Config | null {
  const file = checkConfig(folder);
  if (file === null) return null;
  const lines = [...file.problems, ...file.step5];
  if (lines.length > 0) stopWith('files-invalid', ...lines);
  return file.value as Config | null;
}
