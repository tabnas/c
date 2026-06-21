/* Copyright (c) 2026 Richard Rodger and contributors, MIT License */

// Build the csmith test corpus and (re)generate fixtures.
//
//   node dist-test/csmith-gen.js corpus      — generate corpus only
//   node dist-test/csmith-gen.js fixtures    — regenerate JSON fixtures
//   node dist-test/csmith-gen.js all         — both
//
// Default seed range: 1..100. Override via env: CSMITH_FROM, CSMITH_TO.
//
// IMPORTANT: this module performs its work only when invoked directly
// (require.main === module). Importing it as a library has no
// side effects, so test/csmith.test.ts can pull in helpers without
// requiring the `csmith` binary to be present.

import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { gzipSync } from 'node:zlib'

import {
  CORPUS_DIR, FIXTURES_DIR, corpusPath, fixturePath, seedName,
  parseCsmithSource,
} from './csmith-common.js'
import { fixtureJson } from './csmith-fixture.js'

function genCorpus(from: number, to: number): void {
  mkdirSync(CORPUS_DIR, { recursive: true })
  for (let s = from; s <= to; s++) {
    const out = corpusPath(s)
    if (existsSync(out)) continue
    process.stdout.write(`csmith --seed ${s} -> ${out}\n`)
    execSync(`csmith --seed ${s} > "${out}" 2>/dev/null`)
  }
}

function genFixtures(from: number, to: number): void {
  mkdirSync(FIXTURES_DIR, { recursive: true })
  for (let s = from; s <= to; s++) {
    if (!existsSync(corpusPath(s))) {
      console.error(`seed ${s}: corpus missing (run \`csmith-gen corpus\` first)`)
      continue
    }
    const src = readFileSync(corpusPath(s), 'utf8')
    let cst: any
    try {
      cst = parseCsmithSource(src)
    } catch (e: any) {
      console.error(`seed ${s}: parse threw: ${e.message}`)
      continue
    }
    const json = fixtureJson(cst)
    const gz = gzipSync(Buffer.from(json), { level: 9 })
    writeFileSync(fixturePath(s), gz)
    process.stdout.write(`fixture ${seedName(s)}.json.gz (${(gz.length / 1024).toFixed(0)} KB)\n`)
  }
}

function main(): void {
  const from = +(process.env.CSMITH_FROM || 1)
  const to = +(process.env.CSMITH_TO || 100)
  const cmd = process.argv[2] || 'all'
  if (cmd === 'corpus' || cmd === 'all') genCorpus(from, to)
  if (cmd === 'fixtures' || cmd === 'all') genFixtures(from, to)
}

// Run only when this file is the script entry point. When the test
// runner imports a sibling module that transitively imports this one,
// require.main !== module and main() is skipped.
if (require.main === module) {
  main()
}
