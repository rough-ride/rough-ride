// Preload: make main.mjs's first use of process.cwd() throw, so its promise rejects.
process.cwd = () => {
  throw new Error('cwd unavailable');
};
