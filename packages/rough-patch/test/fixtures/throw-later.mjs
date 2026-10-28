// Preload: throw outside any promise once cli.mjs has installed its handlers.
setTimeout(() => {
  throw new Error('thrown in a timer');
}, 0);
