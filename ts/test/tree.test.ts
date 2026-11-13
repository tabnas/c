/* Copyright (c) 2026 Richard Rodger and contributors, MIT License */

// What every tree holds to (docs/rules.md, "The tree"): `children` holds
// each subtree once, no node holds itself, a node's members are scalars
// (the named members that repeat a child are the API's, `member`), every
// node has a span, and every comment the source holds is in the tree but
// one after the last token. Run over every input of the shared fixtures
// and the Csmith corpus.

import { test, describe } from 'node:test'
import assert from 'node:assert'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { Tabnas } from '@tabnas/parser'
import { jsonic } from '@tabnas/jsonic'
import { C } from '../dist/c.js'
import { CORPUS_DIR, parseCsmithSource } from './csmith-common.js'

const SPEC_DIR = join(process.cwd(), '..', 'test', 'spec')
const TRIVIA = new Set([
  'TRIVIA_LINE_COMMENT', 'TRIVIA_BLOCK_COMMENT', 'TRIVIA_LINE_CONT',
])

function unescape(s: string): string {
  return s.replace(/\\(.)/g, (m, c) =>
    (({ n: '\n', r: '\r', t: '\t', '\\': '\\' }) as any)[c] ?? m)
}

// The problems a tree has, at most a few.
function problems(tree: any): string[] {
  const out: string[] = []
  const seen = new Set<any>()
  const stack: any[] = [[tree, '']]
  while (stack.length && out.length < 5) {
    const [n, at] = stack.pop()
    if (!n || 'object' !== typeof n) continue
    if (seen.has(n)) { out.push(`${at}: a subtree held twice`); continue }
    seen.add(n)
    if ('token' === n.kind) continue
    if (!n.span || 'number' !== typeof n.span.start) out.push(`${at}: no span`)
    for (const [k, v] of Object.entries(n)) {
      if ('children' === k || 'span' === k || 'trivia' === k) continue
      if (v && 'object' === typeof v && !Array.isArray(v)) {
        out.push(`${at}/${n.kind}.${k}: a member holds an object`)
      }
      if (Array.isArray(v) && v.some((x) => x && 'object' === typeof x)) {
        out.push(`${at}/${n.kind}.${k}: a member holds objects`)
      }
    }
    const kids = n.children || []
    for (let i = kids.length - 1; i >= 0; i--) {
      stack.push([kids[i], `${at}/${n.kind}[${i}]`])
    }
  }
  return out
}

// The comments the lexer reads that the tree does not hold, those after
// the last token left out.
function lostComments(src: string, extended: boolean, parse: (j: any) => any): number {
  let lexed = 0, run = 0, tail = 0
  const j = new Tabnas().use(jsonic).use(C, { extended })
  j.sub({
    lex: (t: any) => {
      if (!t) return
      if (TRIVIA.has(t.name)) { lexed++; run++; return }
      if ('#SP' === t.name || '#LN' === t.name || '#CM' === t.name) return
      if ('#ZZ' === t.name) { tail = run; return }
      run = 0
    },
  })
  const tree = parse(j)
  let kept = 0
  const stack = [tree]
  while (stack.length) {
    const n = stack.pop()
    if (!n || 'object' !== typeof n) continue
    if ('token' === n.kind) { if (TRIVIA.has(n.tname)) kept++; continue }
    for (const c of n.children || []) stack.push(c)
  }
  void src
  return lexed - tail - kept
}

describe('tree', () => {
  test('the fixtures\' trees', () => {
    let rows = 0
    for (const f of readdirSync(SPEC_DIR).filter((x) => x.endsWith('.tsv')).sort()) {
      const lines = readFileSync(join(SPEC_DIR, f), 'utf8').split('\n')
      const head = lines[0].split('\t')
      lines.forEach((line, li) => {
        if (0 === li || !line.trim() || (line.startsWith('#') && !line.includes('\t'))) return
        const cols = line.split('\t')
        if (cols[head.indexOf('expected')].startsWith('ERROR')) return
        const raw = (cols[head.indexOf('opts')] || '').trim()
        const opts = raw ? JSON.parse(raw) : {}
        const src = unescape(cols[0])
        const extended = !!(opts.plugin && opts.plugin.extended)
        const parse = (j: any) => {
          if (opts.start) j.options({ rule: { start: opts.start } })
          return j.parse(src)
        }
        const tree = parse(new Tabnas().use(jsonic).use(C, opts.plugin ?? {}))
        assert.deepStrictEqual(problems(tree), [], `${f}:${li + 1}`)
        assert.strictEqual(lostComments(src, extended, parse), 0, `${f}:${li + 1}: comments lost`)
        rows++
      })
    }
    assert.ok(rows > 100, `${rows} rows`)
  })

  test('the Csmith corpus\' trees', () => {
    const files = readdirSync(CORPUS_DIR).filter((n) => /^seed-\d+\.c$/.test(n)).sort()
    for (const f of files) {
      const src = readFileSync(join(CORPUS_DIR, f), 'utf8').replace(/\r\n?/g, '\n')
      assert.deepStrictEqual(problems(parseCsmithSource(src)), [], f)
    }
  })
})
