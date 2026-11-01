// Starts the API and the Nuxt dev server together. BUGS picks the planted bugs:
// "all" (default), "none", or a comma list such as "double-submit,cleared-form".
import { spawn } from 'node:child_process'

const env = { ...process.env, NUXT_PUBLIC_BUGS: process.env.BUGS ?? 'all', NUXT_TELEMETRY_DISABLED: '1' }
const children = ['dev:api', 'dev:web'].map((script) =>
  spawn('npm', ['run', script], { stdio: 'inherit', env }),
)

function stop() {
  for (const child of children) child.kill('SIGTERM')
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
for (const child of children) {
  child.on('exit', (code) => {
    stop()
    process.exitCode = code ?? 0
  })
}
