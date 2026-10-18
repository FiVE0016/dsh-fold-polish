import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
const root = fileURLToPath(new URL('../', import.meta.url))
const run = (args) => {
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    stdio: 'inherit',
  })
  if (result.status !== 0) process.exit(result.status || 1)
}
run(['scripts/build.mjs', '--check'])
run([
  '--test',
  'test/fold.test.mjs',
  'test/runtime.test.mjs',
  'test/entry.test.mjs',
  'test/turn-timer.test.mjs',
  'test/turn-timer-wiring.test.mjs',
  'test/rightbar.test.mjs',
  'test/delete-host.test.mjs',
  'test/delete-host-runtime.test.mjs',
  'test/delete-panel.test.mjs',
])
if (!process.argv.includes('--fast')) run(['test/rewrite-browser.mjs'])
