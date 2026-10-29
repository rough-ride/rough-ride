# Benchmark

The planted-bug benchmark for rough-ride (spec part 7). It sits outside `packages/rough-ride/` and is never published to npm.

## Commands

```sh
npm run bench -- materialize <app> <feature> [<bug>] [--work-dir <dir>] [--no-install]
npm run bench -- materialize-base <app> [--work-dir <dir>] [--no-install]
npm run bench -- lint [<app> ...]
```

`materialize` turns committed patches into a fresh repository: base as one "Initial commit" on `main`, the feature (and the bug, for a buggy variant) as uncommitted changes, and the feature's `request.md` as an untracked `.rough-ride/specs/request.txt`. `lint` runs the portability rules and the hint lint.

## Port registry

Web is `37NN` and API is `87NN`, where NN is the app number. These stay clear of 3000, 3731, 5173, 8000, 8080 and 8731.

| NN | App | Web | API |
|---|---|---|---|
| 00 | fixture (the bench script's own tests; never scored) | 3700 | 8700 |
| 01 | garden-log (dev split, Nuxt 4 + FastAPI; the three-OS CI app) | 3701 | 8701 |
| 02 | dev-split Next.js | 3702 | 8702 |
| 03 | dev-split Vite + React + Express | 3703 | 8703 |
| 04 to 19 | test-split apps, assigned when admitted | 37NN | 87NN |
