#!/usr/bin/env node
// The entry file must parse and run on any Node so an old one gets a clear stop:
// ES2017 syntax only, no static imports, and the crash handlers are installed
// before main.mjs loads, so a crash exits 70 and never 1.

var MIN_NODE = [22, 22, 0];
var json = process.argv.slice(2).indexOf('--json') !== -1;

function canonical(value: unknown): string {
  function sortKeys(v: unknown): unknown {
    if (Array.isArray(v)) return v.map(sortKeys);
    if (v !== null && typeof v === 'object') {
      var out: { [k: string]: unknown } = {};
      Object.keys(v).sort().forEach(function (k) {
        out[k] = sortKeys((v as { [k: string]: unknown })[k]);
      });
      return out;
    }
    return v;
  }
  return JSON.stringify(sortKeys(value), null, 2).replace(/[\u007f-￿]/g, function (c) {
    return '\\u' + ('0000' + c.charCodeAt(0).toString(16)).slice(-4);
  }) + '\n';
}

function nodeTooOld(version: string): boolean {
  var parts = version.split('.').map(Number);
  for (var i = 0; i < 3; i++) {
    var have = parts[i] || 0;
    var need = MIN_NODE[i] || 0;
    if (have !== need) return have < need;
  }
  return false;
}

function crash(error: unknown): void {
  try {
    var text = error instanceof Error && error.stack ? error.stack : String(error);
    process.stderr.write('rough-ride: internal error\n' + text.replace(/[^\x09\x0a\x20-\x7e]/g, '?') + '\n');
    if (json) {
      process.stdout.write(canonical({ status: 'internal-error', exitCode: 70, stop: null }));
    }
  } catch (ignored) {
    // A throwing handler would make Node exit 7.
  }
  process.exit(70);
}

process.on('uncaughtException', crash);
process.on('unhandledRejection', crash);

if (nodeTooOld(process.versions.node)) {
  var message = 'rough-ride needs Node.js 22.22.0 or later; this is Node ' + process.versions.node +
    ' at ' + process.execPath + '. A per-project version manager (Volta, asdf, mise, fnm, nvm) may have' +
    " picked it from this project's settings. Install Node 22.22 or later for this project and run again.";
  if (json) {
    process.stdout.write(canonical({
      status: 'stopped',
      exitCode: 69,
      stop: { kind: 'environment', code: 'node-too-old', lines: [message] },
    }));
    process.stderr.write(message + '\n');
  } else {
    process.stdout.write(message + '\n');
  }
  process.exitCode = 69;
} else {
  import('./main.mjs').then(function (m) {
    return m.main(process.argv.slice(2));
  });
}
