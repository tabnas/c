/* Copyright (c) 2026 Richard Rodger and contributors, MIT License */

// The part's copy of C's operator table holds to the reader's.
//
// C's transducer part (alchemy/transduce.alc) places each operator of an
// expression itself, over expr's passes, by a copy of C's operator table
// in alchemy text: the maintainer ruled so on 2026-11-13. The copy is a
// second statement of C's precedence, so this test holds it to the table
// the reader gives expr, C_OP_TABLE, entry for entry, and a drift between
// the two fails here. Each entry of the copy is [name kind src left right]:
// the kind (infix, prefix, suffix, ternary, paren, cast), the operator's
// token (an opener for a paren or a cast, the first token of a ternary),
// and its binding powers, -1 where the table gives none.

import * as assert from 'node:assert/strict'
import { test } from 'node:test'

import { translate } from '../dist/c.js'
import { C_OP_TABLE } from '../dist/expr-grammar.js'

function entry(op: any): string {
  const kind = ['cast', 'paren', 'ternary', 'infix', 'prefix', 'suffix']
    .find((k) => true === op[k]) ?? '?'
  const src = 'cast' === kind || 'paren' === kind ? op.osrc
    : 'ternary' === kind ? op.src[0] : op.src
  return `${kind} ${src} ${op.left ?? -1} ${op.right ?? -1}`
}

function partTable(source: string): Map<string, string> {
  const begin = source.indexOf('; BEGIN C_OP_TABLE')
  const end = source.indexOf('; END C_OP_TABLE')
  assert.ok(0 <= begin && begin < end, 'the part has a C_OP_TABLE block')
  const out = new Map<string, string>()
  for (const line of source.slice(begin, end).split('\n')) {
    const m = line.match(/^\s*\["([^"]*)" "([^"]*)" "([^"]*)" (-?\d+) (-?\d+)\]\s*$/)
    if (m) out.set(m[1], `${m[2]} ${m[3]} ${Number(m[4])} ${Number(m[5])}`)
  }
  assert.ok(0 < out.size, 'the C_OP_TABLE block holds entries')
  return out
}

test("the part's operator table is the reader's", () => {
  const source = translate()?.transduce?.source
  assert.ok(source, 'c carries a transducer')
  const got = partTable(source)
  const want = new Map(Object.entries(C_OP_TABLE).map(([name, op]) => [name, entry(op)]))
  assert.deepEqual(
    [...got].sort(([a], [b]) => a < b ? -1 : 1),
    [...want].sort(([a], [b]) => a < b ? -1 : 1),
  )
})
