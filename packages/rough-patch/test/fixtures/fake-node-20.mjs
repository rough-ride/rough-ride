// Preload: pretend to be Node 20 and log every module the runner resolves.
import { registerHooks } from 'node:module';

Object.defineProperty(process.versions, 'node', { value: '20.18.1' });
registerHooks({
  resolve(specifier, context, next) {
    process.stderr.write(`resolved ${specifier}\n`);
    return next(specifier, context);
  },
});
