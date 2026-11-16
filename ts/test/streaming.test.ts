/* Copyright (c) 2026 Richard Rodger and contributors, MIT License */

// The parser a host streams a C document through, `makeStreaming()`,
// against the parser for a tree, `make()`. Its rules decide as `make()`'s,
// by the same actions, but its translation unit, conditional groups and
// branches keep nothing that has closed, and its items loop lets go of the
// rules it replaces. So its rule passes, which C's transducer part
// (alchemy/transduce.alc) reads, must be `make()`'s: over every row of the
// shared fixtures and every Csmith program, from the text and from a
// reader, every pass alike (its rule, state, depth, instance, alternate,
// counters and tokens, and whether it carries the rule's node as a value),
// every token the lexer gives alike, and every parse ending alike, an error
// at the same code, place and token. go/streaming_test.go and
// rs/tests/streaming_test.rs hold the Go and Rust ports to the same.

import { test, describe } from 'node:test'
import assert from 'node:assert'
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

import { findSpecDir, loadSpec } from '@tabnas/support'

import { make, makeStreaming } from '../dist/c.js'
import { CORPUS_DIR, STDINT_TYPEDEFS } from './csmith-common.js'

const SPEC = findSpecDir(join(__dirname, '..', '..'))

// A Csmith program as dmog reads it: plain C, after a header that declares
// csmith.h's stdint names as typedef names.
const HEADER = STDINT_TYPEDEFS.map((n) => 'typedef int ' + n + ';\n').join('')

type Reader = { read(buf: Uint8Array): number }

function pieces(bytes: Uint8Array, size: number): Reader {
  let at = 0
  return {
    read(buf: Uint8Array): number {
      const n = Math.min(size, buf.length, bytes.length - at)
      buf.set(bytes.subarray(at, at + n))
      at += n
      return n
    },
  }
}

// What a parse shows: a line for each pass and each token the lexer
// gives, in order, and how the parse ended. `keep` keeps the lines; a
// parse that only counts them folds them into a hash.
type Seen = { count: number; hash: number; lines?: string[] }

// FNV-1a, over each line and the newline after it.
const FNV_BASIS = 0x811c9dc5

function logger(tn: any): (text: string, reader: boolean, keep: boolean) => Seen {
  let seen: Seen = { count: 0, hash: FNV_BASIS }
  const add = (line: string) => {
    seen.count++
    if (seen.lines) seen.lines.push(line)
    let h = seen.hash
    for (let i = 0; i < line.length; i++) {
      h = Math.imul(h ^ line.charCodeAt(i), 0x01000193)
    }
    seen.hash = Math.imul(h ^ 10, 0x01000193) >>> 0
  }
  tn.sub({
    lex: (tkn: any) => {
      if (!tkn || !tkn.isToken) return
      add('lex ' + tkn.name + ' ' + JSON.stringify(tkn.src) + ' ' + tkn.sI)
    },
    ruleDone: (rule: any, _ctx: any, done: any) => {
      const open = 'o' === done.state
      const tokens = (open ? rule.o.slice(0, rule.oN) : rule.c.slice(0, rule.cN))
        .map((t: any) => t.name + ' ' + JSON.stringify(t.src) + ' ' + t.sI)
      const alt = null == done.alt ? '-'
        : [done.alt.p, done.alt.r, done.alt.b, (done.alt.g ?? []).join(',')].join('/')
      // Whether the pass carries the rule's node as a value, as transduce's
      // parser-event source asks it: a close pass does, where the node is
      // defined and not a container.
      const node = rule.node
      const scalar = !open && undefined !== node && (null === node || 'object' !== typeof node)
      add([rule.name, done.state, rule.d, rule.i, alt, true === done.forced, true === done.probe,
        JSON.stringify(rule.n), scalar, tokens.join(', ')].join(' | '))
    },
  })
  return (text, reader, keep) => {
    seen = { count: 0, hash: FNV_BASIS, lines: keep ? [] : undefined }
    try {
      if (reader) tn.parseReader(pieces(Buffer.from(text, 'utf8'), 4096))
      else tn.parse(text)
      add('ok')
    } catch (e: any) {
      if (null == e || 'function' !== typeof e.toJSON) throw e
      const { code, pos, row, col, token } = e.toJSON()
      add('err ' + JSON.stringify({ code, pos, row, col, token: token?.src }))
    }
    return seen
  }
}

// A logger for each parser and option set, built once.
function loggers(build: (plugin: any) => any) {
  const built = new Map<string, ReturnType<typeof logger>>()
  return (plugin: any) => {
    const key = JSON.stringify(plugin)
    let log = built.get(key)
    if (undefined === log) {
      log = logger(build(plugin))
      built.set(key, log)
    }
    return log
  }
}
const tree = loggers((plugin) => make(plugin))
const stream = loggers((plugin) => makeStreaming(plugin))

// The first difference between make()'s parse of text and the streaming
// parser's, or nothing: the two are compared by their count and hash, and
// parsed again, keeping their lines, only where those differ.
function difference(at: string, text: string, plugin: any, reader: boolean): string | undefined {
  const want = tree(plugin)(text, reader, false)
  const got = stream(plugin)(text, reader, false)
  if (want.count === got.count && want.hash === got.hash) return undefined
  const a = tree(plugin)(text, reader, true).lines as string[]
  const b = stream(plugin)(text, reader, true).lines as string[]
  let i = 0
  while (i < a.length && a[i] === b[i]) i++
  return at + (reader ? ', from a reader' : '') + ': line ' + i + ' of ' + a.length +
    '\n  make():          ' + a[i] + '\n  makeStreaming(): ' + b[i]
}

// Every row of the shared fixtures that reads a translation unit: its
// place, its input and the plugin's options. A row that names another
// start rule reads an expression or a declaration on its own, which the
// streaming parser is not for.
function fixtureRows(): { at: string; input: string; plugin: any }[] {
  const rows: { at: string; input: string; plugin: any }[] = []
  for (const file of readdirSync(SPEC).filter((f) => f.endsWith('.tsv')).sort()) {
    for (const row of loadSpec(join(SPEC, file)).rows) {
      const raw = row.named('opts')
      const opts = '' === raw.trim() ? {} : JSON.parse(raw)
      if (opts.start) continue
      rows.push({ at: file + ':' + row.line, input: row.unescNamed('input'), plugin: opts.plugin ?? {} })
    }
  }
  return rows
}

describe('streaming', () => {
  test('makeStreaming-builds-no-tree', () => {
    const text = 'typedef int T;\n#ifdef X\nT a;\n#else\nint b;\n#endif\nint f(void) { return 0; }\n'
    const value = makeStreaming().parse(text)
    assert.equal(value.kind, 'translation_unit')
    assert.deepEqual(value.children, [])
    const whole = (make() as any).parse(text)
    assert.equal(whole.children.length, 3)
    assert.equal((makeStreaming() as any).internal().config.lex.window, true)
  })

  test('its-passes-are-make()s-over-every-fixture', () => {
    const failures: string[] = []
    let compared = 0
    for (const { at, input, plugin } of fixtureRows()) {
      for (const reader of [false, true]) {
        const d = difference(at, input, plugin, reader)
        if (d) failures.push(d)
        compared++
      }
    }
    assert.ok(400 < compared, '' + compared)
    assert.deepEqual(failures, [])
  })

  test('its-passes-are-make()s-over-every-csmith-program', () => {
    if (!existsSync(CORPUS_DIR)) return
    const files = readdirSync(CORPUS_DIR).filter((n) => /^seed-\d+\.c$/.test(n)).sort()
    assert.ok(100 <= files.length, '' + files.length)
    const failures: string[] = []
    let started = Date.now()
    files.forEach((name, index) => {
      const text = HEADER + readFileSync(join(CORPUS_DIR, name), 'utf8')
      for (const reader of [false, true]) {
        const d = difference(name, text, {}, reader)
        if (d) failures.push(d)
      }
      if (index + 1 === files.length || 20000 < Date.now() - started) {
        started = Date.now()
        console.log('streaming csmith: ' + (index + 1) + ' of ' + files.length + ' programs (' +
          Math.floor(((index + 1) * 100) / files.length) + '%)')
      }
    })
    assert.deepEqual(failures, [])
  })
})
