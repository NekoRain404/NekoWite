#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
node --input-type=module <<'JS'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'

const root = fs.mkdtempSync(path.join(process.cwd(), '.boot-probe-test-'))
const mockBin = path.join(root, 'mock-bin')
const originalHome = process.env.HOME
let failures = 0
const children = []
function executable(file, source) {
  fs.writeFileSync(file, source, { mode: 0o755 })
}
function check(name, assertion) {
  try { assertion(); console.log(`PASS: ${name}`) }
  catch (error) { failures++; console.error(`FAIL: ${name}: ${error.message}`) }
}
function alive(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
    return stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3) !== 'Z'
  } catch { return false }
}
try {
  for (const dir of ['scripts', 'release', 'apps/desktop/src-tauri', 'mock-bin']) {
    fs.mkdirSync(path.join(root, dir), { recursive: true })
  }
  fs.copyFileSync('scripts/boot-probe.sh', path.join(root, 'scripts/boot-probe.sh'))
  fs.writeFileSync(path.join(root, 'apps/desktop/src-tauri/tauri.conf.json'), '{"version":"9.8.7"}')
  executable(path.join(mockBin, 'xvfb-run'), '#!/bin/bash\nshift 3\nexec "$@"\n')
  executable(path.join(mockBin, 'dbus-run-session'), '#!/bin/bash\n[ "$1" != -- ] || shift\nexec "$@"\n')
  executable(path.join(mockBin, 'pkill'), '#!/bin/bash\nprintf called > "$PKILL_RECORD"\n')
  const app = `#!${process.execPath}
const fs = require('node:fs');
const { spawn } = require('node:child_process');
fs.writeFileSync(process.env.RECORD, JSON.stringify({ env: process.env, executable: process.argv[1] }));
const child = spawn('/bin/sleep', ['60'], { stdio: 'ignore' });
fs.writeFileSync(process.env.CHILD_RECORD, String(child.pid));
if (process.env.MODE === 'crash') process.exit(7);
if (process.env.MODE === 'early') process.exit(0);
setInterval(() => {}, 1000);
`
  for (const name of ['nekowite_1.0.0_x64', 'nekowite_9.8.7_x64', 'custom-app']) {
    executable(path.join(root, 'release', name), app)
  }
  executable(path.join(root, 'release/opencode'), '#!/bin/bash\nexit 0\n')
  const sentinel = spawn('/bin/sleep', ['60'], { stdio: 'ignore' })
  children.push(sentinel.pid)
  for (const mode of ['crash', 'early', 'survive']) {
    const record = path.join(root, `${mode}.json`)
    const childRecord = path.join(root, `${mode}.pid`)
    const pkillRecord = path.join(root, `${mode}.pkill`)
    const result = spawnSync('bash', ['scripts/boot-probe.sh'], {
      cwd: root, encoding: 'utf8', timeout: 5000,
      env: { ...process.env, PATH: `${mockBin}:${process.env.PATH}`, MODE: mode,
        BUDGET: '0.5', RECORD: record, CHILD_RECORD: childRecord,
        PKILL_RECORD: pkillRecord, LOG: path.join(root, `${mode}.log`),
        ...(mode === 'survive' ? { BIN: path.join(root, 'release/custom-app') } : {}) },
    })
    check(`${mode}: meaningful exit status`, () => {
      assert.equal(result.error, undefined)
      assert.equal(result.status, mode === 'survive' ? 0 : 1, result.stdout + result.stderr)
    })
    check(`${mode}: no global process-name cleanup`, () => assert.equal(fs.existsSync(pkillRecord), false))
    const observed = JSON.parse(fs.readFileSync(record, 'utf8'))
    check(`${mode}: HOME preserved`, () => assert.equal(observed.env.HOME, originalHome))
    for (const key of ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'XDG_RUNTIME_DIR', 'TMPDIR']) {
      check(`${mode}: isolated ${key}`, () => {
        assert.ok(observed.env[key]?.startsWith(root + '/'), `${key}=${observed.env[key]}`)
      })
    }
    check(`${mode}: configured binary used`, () => assert.equal(path.basename(observed.executable),
      mode === 'survive' ? 'custom-app' : 'nekowite_9.8.7_x64'))
    check(`${mode}: private runtime directory`, () => assert.equal(
      fs.statSync(observed.env.XDG_RUNTIME_DIR).mode & 0o777, 0o700))
    check(`${mode}: bounded runtime path overhead`, () => assert.ok(
      path.relative(root, observed.env.XDG_RUNTIME_DIR).length <= 20,
      'deep scratch paths exceed Linux Unix socket limits in ordinary checkouts'))
    const pid = Number(fs.readFileSync(childRecord, 'utf8'))
    children.push(pid)
    check(`${mode}: own descendant cleaned up`, () => assert.equal(alive(pid), false))
    check(`${mode}: unrelated process survives`, () => assert.equal(alive(sentinel.pid), true))
  }
  const cancelRecord = path.join(root, 'cancel.pid')
  const cancelled = spawn('bash', ['scripts/boot-probe.sh'], {
    cwd: root, stdio: 'ignore', env: { ...process.env,
      PATH: `${mockBin}:${process.env.PATH}`, BUDGET: '10', MODE: 'survive',
      RECORD: path.join(root, 'cancel.json'), CHILD_RECORD: cancelRecord,
    },
  })
  children.push(cancelled.pid)
  const ended = new Promise(resolve => cancelled.on('exit', resolve))
  for (let tries = 0; tries < 200 && !fs.existsSync(cancelRecord); tries++) {
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.ok(fs.existsSync(cancelRecord), 'cancellation fixture started')
  const cancelChild = Number(fs.readFileSync(cancelRecord, 'utf8'))
  children.push(cancelChild)
  cancelled.kill('SIGTERM')
  const cancelCode = await ended
  check('cancellation: explicit signal status', () => assert.equal(cancelCode, 143))
  check('cancellation: own descendant cleaned up', () => assert.equal(alive(cancelChild), false))
  check('cancellation: unrelated process survives', () => assert.equal(alive(sentinel.pid), true))
} finally {
  for (const pid of children) { try { process.kill(pid, 'SIGKILL') } catch {} }
  fs.rmSync(root, { recursive: true, force: true })
}
process.exitCode = failures ? 1 : 0
JS
