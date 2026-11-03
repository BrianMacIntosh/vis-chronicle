// Runs vis-chronicle against a test spec.
// Usage: npm test -- [name] [extra fetch.js flags]
// Reads test/<name>.json (default 'presidents') and writes to test/out/.

const { spawnSync } = require('child_process')
const path = require('path')

const args = process.argv.slice(2)
const name = args[0] && !args[0].startsWith('-') ? args.shift() : 'presidents'

// Paths are relative to the repo root; caches go to <repo>/intermediate
const result = spawnSync(process.execPath, [
	'src/fetch.js',
	`test/${name}.json`,
	`test/out/${name}.json`,
	'-v',
	'--out-metadata', `test/out/${name}-metadata.json`,
	...args,
], { stdio: 'inherit', cwd: path.join(__dirname, '..') })

process.exit(result.status ?? 1)
