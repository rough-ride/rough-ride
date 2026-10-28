// The path rules the runner and the edit hook share (spec part 2 sections 6.10
// and 6.11). Hand-written, not tsc output: Node 18 syntax and APIs only, no
// dependencies, because the hook runs on whatever Node Claude Code finds.

import fs from 'node:fs';
import path from 'node:path';

const FOLDER = '.rough-patch';
const MAX_HOPS = 40;
// The characters git's core.protectHFS ignores.
const IGNORABLE = /[‌-‏‪-‮⁪-⁯﻿]/g;
const SHORT_NAME = /^rough-~\d+$/;

let realpath = fs.realpathSync.native;

function realpathOf(p) {
  try {
    return realpath(p);
  } catch (error) {
    if (error && error.code === 'EISDIR' && realpath !== fs.realpathSync) {
      realpath = fs.realpathSync;
      return realpath(p);
    }
    throw error;
  }
}

// Folds one path segment the same way on every OS; a segment names the folder
// when this returns '.rough-patch'.
export function fold(segment) {
  let s = segment.normalize('NFC').replace(IGNORABLE, '');
  if (!/^[A-Za-z]:$/.test(s)) {
    const colon = s.indexOf(':');
    if (colon !== -1) s = s.slice(0, colon);
  }
  s = s.replace(/[. ]+$/, '');
  return s.replace(/[A-Z]/g, (c) => c.toLowerCase());
}

export function isFolderName(segment) {
  return fold(segment) === FOLDER;
}

function cleanString(p) {
  let s = p;
  if (s.startsWith('\\\\?\\UNC\\')) s = '\\\\' + s.slice(8);
  else if (s.startsWith('\\\\?\\')) s = s.slice(4);
  s = s.replace(/\\/g, '/');
  s = s.replace(/^([a-z]):/, (m, d) => d.toUpperCase() + ':');
  s = s.normalize('NFC');
  if (s.length > 1 && s.endsWith('/') && !/^[A-Z]:\/$/.test(s) && !/^\/\/[^/]+\/[^/]+\/$/.test(s)) {
    s = s.slice(0, -1);
  }
  return s;
}

// The canonical spelling of a path: resolved, the deepest existing part run
// through realpath (stored case, links, junctions, subst drives, 8.3 names,
// macOS /tmp), the missing tail kept as written, then cleaned. Never lower-cased.
export function canon(p, platform = process.platform) {
  const mod = platform === 'win32' ? path.win32 : path.posix;
  let head = mod.resolve(p);
  const tail = [];
  for (;;) {
    try {
      head = realpathOf(head);
      break;
    } catch (error) {
      const code = error && error.code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
      const parent = mod.dirname(head);
      if (parent === head) break;
      tail.unshift(mod.basename(head));
      head = parent;
    }
  }
  return cleanString(tail.length ? mod.join(head, ...tail) : head);
}

// Two existing paths are the same when their canonical strings match or their
// (dev, ino) match, which covers macOS's /System/Volumes/Data spelling.
export function samePath(a, b) {
  if (canon(a) === canon(b)) return true;
  try {
    const sa = fs.statSync(a, { bigint: true });
    const sb = fs.statSync(b, { bigint: true });
    return sa.dev === sb.dev && sa.ino === sb.ino;
  } catch (error) {
    return false;
  }
}

function stripWindowsPrefix(p) {
  if (p.startsWith('\\\\?\\UNC\\')) return '\\\\' + p.slice(8);
  if (p.startsWith('\\\\?\\') || p.startsWith('\\\\.\\')) return p.slice(4);
  return p;
}

function splitSegments(p) {
  return p.split(/[\\/]+/).filter((s) => s !== '');
}

// Walks `absolute` from its root: '.' is skipped, '..' goes up from the part
// already resolved, an existing segment is replaced by realpath of it, a
// dangling symlink is followed with readlink, and from the first missing
// segment the rest is appended as written.
function physical(absolute) {
  const root = path.parse(absolute).root;
  const segments = splitSegments(absolute.slice(root.length));
  let current = root;
  let hops = 0;
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    if (segment === '.') continue;
    if (segment === '..') {
      current = path.dirname(current);
      continue;
    }
    let candidate = path.join(current, segment);
    let stat;
    try {
      stat = fs.lstatSync(candidate);
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') {
        return [current, ...segments.slice(i)].join(path.sep);
      }
      throw error;
    }
    if (stat.isSymbolicLink()) {
      try {
        current = realpathOf(candidate);
        continue;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      // Dangling: follow the chain by hand until it ends at a missing path.
      for (;;) {
        if (++hops > MAX_HOPS) {
          const error = new Error('too many symbolic links');
          error.code = 'ELOOP';
          throw error;
        }
        const target = path.resolve(path.dirname(candidate), fs.readlinkSync(candidate));
        let next;
        try {
          next = fs.lstatSync(target);
        } catch (error) {
          if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
          return [physical(target), ...segments.slice(i + 1)].join(path.sep);
        }
        if (!next.isSymbolicLink()) {
          current = realpathOf(target);
          break;
        }
        candidate = target;
      }
      continue;
    }
    current = realpathOf(candidate);
  }
  return current;
}

function matchesIn(segments, shortNames) {
  for (let i = 0; i < segments.length; i++) {
    const folded = fold(segments[i]);
    if (folded === FOLDER || (shortNames && SHORT_NAME.test(folded))) {
      return segments.slice(i + 1).map(fold);
    }
  }
  return null;
}

// The edit hook's verdict for one path: blocked when any folder on it, as
// written or as the OS would resolve it, folds to '.rough-patch'. `rest` holds
// the folded segments after the first match, from a physical form when one
// matched. Any error other than a missing path denies.
export function checkPath(input, cwd) {
  if (typeof input !== 'string' || input === '') return { blocked: true, rest: [], error: 'no path' };
  const given = stripWindowsPrefix(input);
  const lexical = path.resolve(cwd, given);
  const absolute = path.isAbsolute(given) ? given : cwd + path.sep + given;
  let physicalForm;
  let physicalLexical;
  const before = realpath;
  try {
    physicalForm = physical(absolute);
    physicalLexical = physical(lexical);
  } catch (error) {
    return { blocked: true, rest: [], error: (error && error.code) || 'error' };
  }
  const shortNames = realpath !== before || realpath === fs.realpathSync;
  const fromPhysical = matchesIn(splitSegments(physicalForm), shortNames) ||
    matchesIn(splitSegments(physicalLexical), shortNames);
  if (fromPhysical) return { blocked: true, rest: fromPhysical };
  const fromWritten = matchesIn(splitSegments(given), false) || matchesIn(splitSegments(lexical), false);
  if (fromWritten) return { blocked: true, rest: fromWritten };
  return { blocked: false, rest: [] };
}
