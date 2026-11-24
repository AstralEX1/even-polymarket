// Packs app/dist into sideline-odds.ehpk. On a phone, localhost is the phone itself, so a packed app reaches this
// server through an https tunnel: PUBLIC_URL becomes the only origin in the network whitelist.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const manifest = JSON.parse(readFileSync('app/app.json', 'utf8'))
const publicUrl = process.env.PUBLIC_URL
if (publicUrl) {
  const url = new URL(publicUrl)
  if (url.protocol !== 'https:') throw new Error('PUBLIC_URL must be https: every request carries the token')
  manifest.permissions.find((p: { name: string }) => p.name === 'network').whitelist = [url.origin]
} else {
  console.warn('PUBLIC_URL is not set: this package can only call http://localhost:8788, which works in the simulator, not on a phone.')
}
const file = join(mkdtempSync(join(tmpdir(), 'sideline-odds-')), 'app.json')
writeFileSync(file, JSON.stringify(manifest, null, 2))
// The CLI stamps min_app_version from the SDK's floor; without --sdk-ver it reads npm's latest SDK, which may be newer than the one bundled.
const sdkVersion = JSON.parse(readFileSync('node_modules/@evenrealities/even_hub_sdk/package.json', 'utf8')).version
execFileSync('evenhub', ['pack', file, 'app/dist', '-o', 'sideline-odds.ehpk', '--sdk-ver', sdkVersion], { stdio: 'inherit' })
