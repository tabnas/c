/* Copyright (c) 2026 Richard Rodger and contributors, MIT License */

// csmith corpus regression test. For every seed-NNN.c file in
// test/csmith-corpus/, parse and assert that the resulting CST
// (rendered via fixtureJson) matches the gzipped JSON fixture in
// test/csmith-fixtures/.
//
// Tests do NOT require the csmith binary — both the corpus and the
// golden fixtures are committed. To regenerate after a deliberate
// parser change:
//
//   npx tsc --build src test
//   node dist-test/csmith-gen.js fixtures
//
// To rebuild the corpus from scratch (only when csmith is installed):
//
//   node dist-test/csmith-gen.js all

import { test, describe } from 'node:test'
import assert from 'node:assert'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'

import {
  CORPUS_DIR, FIXTURES_DIR, parseCsmithSource,
} from './csmith-common.js'
import { fixtureJson } from './csmith-fixture.js'

function corpusFiles(): string[] {
  if (!existsSync(CORPUS_DIR)) return []
  return readdirSync(CORPUS_DIR)
    .filter((n) => /^seed-\d+\.c$/.test(n))
    .sort()
}

// Normalise line endings to LF. .gitattributes pins the corpus to LF,
// but if a Windows checkout slipped past (e.g. autocrlf=true on a
// pre-existing clone), force LF here so token spans match the
// fixtures generated on Linux.
function normaliseEol(s: string): string {
  return s.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
}

describe('csmith corpus', () => {
  const files = corpusFiles()
  if (files.length === 0) {
    test('no corpus present (skipped)', () => {
      // Run `node dist-test/csmith-gen.js all` (with csmith installed)
      // to populate the corpus.
    })
    return
  }

  for (const f of files) {
    const seed = f.replace(/^seed-(\d+)\.c$/, '$1')
    test(`seed ${seed}`, () => {
      const src = normaliseEol(readFileSync(join(CORPUS_DIR, f), 'utf8'))
      const cst = parseCsmithSource(src)
      assert.ok(cst, 'parse must produce a CST')
      assert.equal(cst.kind, 'translation_unit')
      assert.ok(cst.children.length > 0, 'translation_unit must have children')
      const unknowns = cst.children.filter((c: any) => c.declKind === 'unknown')
      assert.equal(unknowns.length, 0,
        `expected zero unknown declarations, got ${unknowns.length}`)

      const fp = join(FIXTURES_DIR, f.replace(/\.c$/, '.json.gz'))
      if (!existsSync(fp)) return
      const expected = gunzipSync(readFileSync(fp)).toString('utf8')
      const actual = fixtureJson(cst)
      assert.equal(actual, expected,
        `fixture mismatch for seed ${seed}; rerun ` +
        `\`node dist-test/csmith-gen.js fixtures\` after a deliberate ` +
        `parser change.`)
    })
  }
})
