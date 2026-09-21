#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
node --input-type=module <<'JS'
import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
const suite = fs.mkdtempSync(path.join(process.cwd(), '.package-linux-test-'))
let failures = 0
function check(name, callback) {
  try { callback(); console.log(`PASS: ${name}`) }
  catch (error) { failures++; console.error(`FAIL: ${name}: ${error.message}`) }
}
function write(file, source, mode = 0o755) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, source, { mode })
}
const names = ['nekowite_1.0.0_x64', 'opencode', 'nekowite_1.0.0_amd64.deb', 'nekowite-1.0.0-1.x86_64.rpm', 'nekowite_1.0.0_amd64.AppImage']
try {
  for (const scenario of ['missing', 'stale', 'portable-missing', 'verify-failure', 'publish-failure', 'success']) {
    const root = path.join(suite, scenario)
    const mock = path.join(root, 'mock')
    write(path.join(root, 'scripts/package-linux.sh'), fs.readFileSync('scripts/package-linux.sh'))
    write(path.join(root, 'apps/desktop/src-tauri/tauri.conf.json'), '{"version":"1.0.0"}')
    write(path.join(root, 'apps/desktop/src-tauri/THIRD-PARTY-NOTICES.txt'), 'END OF THIRD-PARTY NOTICES\n')
    write(path.join(root, 'apps/desktop/src-tauri/binaries/opencode-x86_64-unknown-linux-gnu'), 'engine')
    for (const name of names) write(path.join(root, 'release', name), 'old-' + name)
    write(path.join(root, 'release/keep.deb'), 'unrelated')
    if (scenario !== 'missing') write(path.join(root, 'apps/desktop/src-tauri/target/release/bundle/rpm', names[3]), 'stale-rpm')
    write(path.join(mock, 'rpm'), '#!/bin/bash\nexit 0\n')
    write(path.join(mock, 'mv'), `#!${process.execPath}
const cp=require('node:child_process');
if(process.env.SCENARIO==='publish-failure' && process.argv[2].includes('/.candidate.') && process.argv[3]===process.env.FIXTURE+'/release/${names[3]}')process.exit(1);
process.exit(cp.spawnSync('/usr/bin/mv',process.argv.slice(2),{stdio:'inherit'}).status);
`)
    write(path.join(root, 'shell-env'), 'readlink() { return 1; }\n')
    write(path.join(mock, 'curl'), `#!${process.execPath}\nconst fs=require('node:fs'); const p=process.argv[process.argv.indexOf('-o')+1]; if(!p.startsWith(process.env.FIXTURE+'/'))process.exit(88); fs.mkdirSync(require('node:path').dirname(p),{recursive:true}); fs.writeFileSync(p,'runtime');`)
    write(path.join(mock, 'mktemp'), '#!/bin/bash\nif [ -z "${TMPDIR:-}" ]; then export TMPDIR="$FIXTURE/tmp"; mkdir -p "$TMPDIR"; echo outside-default >> "$FIXTURE/unsafe"; fi\nexec /usr/bin/mktemp "$@"\n')
    write(path.join(root, 'scripts/verify-opencode-linux.sh'), '#!/bin/bash\n[ "${1:-}" != --bundle ] || [ "$SCENARIO" != verify-failure ]\n')
    const extractor = `#!${process.execPath}
const fs=require('node:fs'),path=require('node:path');
const dest=process.argv.includes('-x')?process.argv.at(-1):process.cwd();
for(const rel of ['usr/share/doc/nekowite/copyright','usr/share/licenses/nekowite/THIRD-PARTY-NOTICES.txt']){fs.mkdirSync(path.dirname(path.join(dest,rel)),{recursive:true});fs.writeFileSync(path.join(dest,rel),'END OF THIRD-PARTY NOTICES\\n');}
`
    write(path.join(mock, 'dpkg-deb'), extractor)
    write(path.join(mock, 'cpio'), extractor)
    write(path.join(mock, 'rpm2cpio'), '#!/bin/bash\nexit 0\n')
    write(path.join(mock, 'npx'), `#!${process.execPath}
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
if(!process.argv.includes('tauri'))process.exit(0);
fs.writeFileSync('build-env.json',JSON.stringify({env:process.env,rpm:cp.spawnSync('rpm',['--version'],{encoding:'utf8'}).stdout}));
const base='apps/desktop/src-tauri/target/release';
function put(rel,text){fs.mkdirSync(path.dirname(base+'/'+rel),{recursive:true});fs.writeFileSync(base+'/'+rel,text,{mode:0o755});}
if(process.env.SCENARIO!=='portable-missing')put('nekowite','new-portable');put('opencode','engine');
put('bundle/deb/${names[2]}','new-deb');
if(!['missing','stale'].includes(process.env.SCENARIO))put('bundle/rpm/${names[3]}','new-rpm');
put('bundle/appimage/${names[4]}',${JSON.stringify(extractor)});
`)
    const result = spawnSync('bash', ['scripts/package-linux.sh'], { cwd: root, encoding: 'utf8', timeout: 15000,
      env: { ...process.env, PATH: `${mock}:${process.env.PATH}`, BASH_ENV: path.join(root, 'shell-env'), FIXTURE: root, SCENARIO: scenario } })
    check(`${scenario}: status`, () => assert.equal(result.status, scenario === 'success' ? 0 : 1, result.stdout + result.stderr))
    check(`${scenario}: unrelated release survives`, () => assert.equal(fs.readFileSync(path.join(root, 'release/keep.deb'), 'utf8'), 'unrelated'))
    if (scenario !== 'success') {
      for (const name of names) check(`${scenario}: preserves ${name}`, () => assert.equal(fs.readFileSync(path.join(root, 'release', name), 'utf8'), 'old-' + name))
    } else {
      check('success: publishes fresh portable', () => assert.equal(fs.readFileSync(path.join(root, 'release', names[0]), 'utf8'), 'new-portable'))
      const env = JSON.parse(fs.readFileSync(path.join(root, 'build-env.json'), 'utf8'))
      for (const key of ['TMPDIR', 'XDG_CACHE_HOME', 'npm_config_cache']) check(`success: local ${key}`, () => assert.ok(env.env[key]?.startsWith(root + '/')))
      check('success: real rpm selected', () => assert.match(env.rpm, /^RPM version /))
      check('success: original HOME preserved', () => assert.equal(env.env.HOME, process.env.HOME))
      check('success: prior release backed up', () => assert.ok(fs.readdirSync(path.join(root, 'release/superseded')).some(dir => fs.existsSync(path.join(root, 'release/superseded', dir, names[0])))))
    }
  }
} finally { fs.rmSync(suite, { recursive: true, force: true }) }
process.exitCode = failures ? 1 : 0
JS
