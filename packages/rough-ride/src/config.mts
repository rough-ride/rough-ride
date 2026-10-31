// .rough-ride/config.yaml (spec part 2 section 7). Only people write it; the
// runner reads it and never changes a byte. files.mts checks the working copy
// with every other committed file, and protected.mts picks the effective config
// from it and its reviewed versions (26.7).

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
