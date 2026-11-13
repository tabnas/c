/* Copyright (c) 2026 Richard Rodger and contributors, MIT License */

// A parse from a reader (`tn.parseReader`, admin ADR-30 and ADR-33).
//
// `make()` builds C's parser whole, as `new Tabnas().use(jsonic).use(C,
// options)` builds it, and declares `lex.window` on it, so that a reader
// is read a window at a time. C's matchers read the source only through the
// window: a scan that reaches the window's end fills it and the token is
// cut again (src/matchers.ts). These tests hold it to that: `make()`
// declares the window and parses as that composition does; every row of
// the shared fixtures, under its `opts`, parses the same from a reader, in
// pieces of 1, 3 and 64 bytes, under windows of a few UTF-16 units and the
// engine's own, as from its text; so do tokens of every kind longer than
// the window, and a directive the window begins just before; and every
// Csmith program does, in pieces of 4 KiB, under the engine's window and
// one of 64 units, in time linear in its length.

import { test, describe } from 'node:test'
import assert from 'node:assert'
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { inspect } from 'node:util'

import { Tabnas } from '@tabnas/parser'
import { jsonic } from '@tabnas/jsonic'
import { findSpecDir, loadSpec } from '@tabnas/support'

import { C, make } from '../dist/c.js'
import { makeCMeta } from '../dist/symbols.js'
import { CORPUS_DIR, STDINT_TYPEDEFS } from './csmith-common.js'

// The shared fixtures (test/spec above ts/), not ts/test/spec.
const SPEC = findSpecDir(join(__dirname, '..', '..'))

type Reader = { read(buf: Uint8Array): number }
type Sizes = { margin: number; block: number; chunk: number }
type Seen = { value?: unknown; error?: string }

// A reader that hands its bytes over at most `size` at a time.
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

// What a parse shows: its value, or its error's code, position, row,
// column and token text. An error's excerpt is left out: a parse from a
// reader shows a long line only as far back as the window reaches
// (tabnas/parser DIVERGENCE.md), the one difference allowed.
function seen(parse: () => unknown): Seen {
  try {
    return { value: parse() }
  } catch (e: any) {
    if (null == e || 'function' !== typeof e.toJSON) {
      return { error: 'throw ' + (e && e.name) + ' ' + (e && e.message) }
    }
    const d = e.toJSON()
    return {
      error:
        d.code + ' at ' + d.pos + ' ' + d.row + ':' + d.col + ' ' +
        JSON.stringify(d.token.src),
    }
  }
}

const show = (o: Seen): string =>
  undefined !== o.error ? 'error ' + o.error : 'value ' + inspect(o.value, { depth: 4 })

function same(a: Seen, b: Seen): boolean {
  if (a.error !== b.error) return false
  try {
    assert.deepStrictEqual(a.value, b.value)
    return true
  } catch (e) {
    return false
  }
}

// The pieces a reader hands its bytes over in, and the windows (margin and
// block) it is read under besides the engine's own: a few units, so that
// every scan of a matcher meets the window's edge.
const PIECES = [1, 3, 64]
const WINDOWS = [[1, 1], [3, 2], [64, 64]]

// `text` parsed by `tn` whole, and from a reader in each of `sizes` pieces,
// under the engine's window and each of `windows`: how many reader parses
// were compared. A difference is pushed onto `failures`.
function sameFromReader(
  tn: Tabnas,
  at: string,
  text: string,
  failures: string[],
  meta: () => any = () => undefined,
  sizes: number[] = PIECES,
  windows: number[][] = WINDOWS,
): number {
  const anyTn = tn as any
  const whole = seen(() => tn.parse(text, meta()))
  const bytes = Buffer.from(text, 'utf8')
  let compared = 0
  for (const size of sizes) {
    const reads: [string, () => unknown][] = [
      ['', () => anyTn.parseReader(pieces(bytes, size), meta())],
    ]
    for (const [margin, block] of windows) {
      const window: Sizes = { margin, block, chunk: size }
      reads.push([
        ', margin ' + margin + ', block ' + block,
        () => anyTn.parseReaderWithSizes(pieces(bytes, size), window, meta()),
      ])
    }
    for (const [how, parse] of reads) {
      const read = seen(parse)
      compared++
      if (!same(read, whole)) {
        failures.push(
          at + ': ' + JSON.stringify(text.slice(0, 80)) + ' from a reader in pieces of ' +
          size + how + '\n  whole:  ' + show(whole) + '\n  reader: ' + show(read),
        )
      }
    }
  }
  return compared
}

type Row = { at: string; input: string; plugin: any; start?: string }

// Every row of the shared fixtures: where it is, its input, the plugin's
// options and the start rule it names.
function fixtureRows(): Row[] {
  const rows: Row[] = []
  for (const file of readdirSync(SPEC).filter((f) => f.endsWith('.tsv')).sort()) {
    for (const row of loadSpec(join(SPEC, file)).rows) {
      const raw = row.named('opts')
      const opts = '' === raw.trim() ? {} : JSON.parse(raw)
      rows.push({
        at: file + ':' + row.line,
        input: row.unescNamed('input'),
        plugin: opts.plugin ?? {},
        start: opts.start,
      })
    }
  }
  return rows
}

// A parser per option set, built once: building one costs more than a
// fixture's parse, and a parser is reused across parses.
function cached(build: (plugin: any, start?: string) => Tabnas) {
  const built = new Map<string, Tabnas>()
  return (plugin: any, start?: string): Tabnas => {
    const key = JSON.stringify([plugin, start])
    let tn = built.get(key)
    if (undefined === tn) {
      tn = build(plugin, start)
      if (start) tn.options({ rule: { start } })
      built.set(key, tn)
    }
    return tn
  }
}
const madeFor = cached((plugin) => make(plugin))
const composedFor = cached((plugin) => new Tabnas().use(jsonic).use(C, plugin))

describe('window', () => {
  test('make-declares-the-window', () => {
    const tn = make() as any
    assert.equal(tn.internal().config.lex.window, true)
    // The plugin alone declares nothing: a host may install it beneath
    // matchers of its own.
    const composed = new Tabnas().use(jsonic).use(C, {}) as any
    assert.ok(!composed.internal().config.lex.window)
  })

  test('make-parses-as-the-composition-does', () => {
    let compared = 0
    const failures: string[] = []
    for (const { at, input, plugin, start } of fixtureRows()) {
      const made = seen(() => madeFor(plugin, start).parse(input))
      const composed = seen(() => composedFor(plugin, start).parse(input))
      compared++
      if (!same(made, composed)) {
        failures.push(at + '\n  make:     ' + show(made) + '\n  composed: ' + show(composed))
      }
    }
    assert.ok(200 < compared, '' + compared)
    assert.deepEqual(failures, [])
  })

  test('every-row-parses-the-same-from-a-reader', () => {
    const rows = fixtureRows()
    let compared = 0
    const failures: string[] = []
    rows.forEach(({ at, input, plugin, start }, index) => {
      compared += sameFromReader(madeFor(plugin, start), at, input, failures)
      if (0 === (index + 1) % 50 || index + 1 === rows.length) {
        console.log('window fixtures: ' + (index + 1) + ' of ' + rows.length + ' rows (' +
          Math.floor(((index + 1) * 100) / rows.length) + '%), ' + compared + ' reader parses')
      }
    })
    assert.deepEqual(failures, [])
    assert.ok(200 < rows.length, '' + rows.length)
    assert.equal(compared, PIECES.length * (1 + WINDOWS.length) * rows.length)
  })

  test('tokens-longer-than-the-window-parse-the-same-from-a-reader', () => {
    // Each kind of token a matcher scans, long enough to straddle every
    // window here, and the directives a window may begin just before.
    const long = 'x'.repeat(300)
    const digits = '1'.repeat(300)
    const docs: [string, any][] = [
      ['int ' + long + ' = 1;', {}],
      ['int x = ' + digits + ';', {}],
      ['double d = ' + digits + '.' + digits + 'e+' + digits + ';', {}],
      ['int x = 0x' + 'f'.repeat(300) + 'ull;', {}],
      ['char *s = "' + long + '\\n' + long + '";', {}],
      ['char *s = u8"' + long + '";', {}],
      ["int c = L'" + 'a'.repeat(5) + "';", {}],
      ['/* ' + long + ' */ int x;', {}],
      ['// ' + long + '\nint x;', {}],
      ['int x; ' + ' '.repeat(300) + '\n' + '\t'.repeat(300) + ' int y;', {}],
      ['#include <' + long + '.h>\nint x;', {}],
      ['#define A ' + long + '\nint x = A;', {}],
      ['int x;\n' + ' '.repeat(300) + '#define B 2\nint y = B;', {}],
      ['#define A 1\r#define B 2\rint x = A + B;', {}],
      ['#define A 1\r\n#define B 2\r\nint x = A + B;', {}],
      ['#if 1\rint x;\r#endif\r', {}],
      ['int x; #define C 3\n', {}],
      ['int x = 1; \\\n#define D 4\nint y = D;', {}],
      ['%:define E 5\nint x = E;', {}],
      ['int a = b <<= c >>= d;', {}],
      ['void f(int, ...);', {}],
      ['char *s = R"delim(' + long + ')delim";', { extended: true }],
      ['char *s = "' + long, {}],
      ['/* ' + long, {}],
    ]
    let compared = 0
    const failures: string[] = []
    docs.forEach(([text, plugin], i) => {
      compared += sameFromReader(madeFor(plugin), 'token #' + i, text, failures)
    })
    assert.deepEqual(failures, [])
    assert.equal(compared, PIECES.length * (1 + WINDOWS.length) * docs.length)
  })

  test('every-csmith-program-parses-the-same-from-a-reader', () => {
    // As the Csmith suite reads a program: extended, with csmith.h's
    // stdint names declared as typedef names.
    if (!existsSync(CORPUS_DIR)) return
    const files = readdirSync(CORPUS_DIR).filter((n) => /^seed-\d+\.c$/.test(n)).sort()
    assert.ok(100 <= files.length, '' + files.length)
    const tn = make({ extended: true })
    const meta = () => {
      const cmeta = makeCMeta()
      for (const n of STDINT_TYPEDEFS) cmeta.symbols.bindTypedef(n)
      return { cmeta }
    }
    let compared = 0
    const failures: string[] = []
    files.forEach((name, index) => {
      const text = readFileSync(join(CORPUS_DIR, name), 'utf8')
      compared += sameFromReader(tn, name, text, failures, meta, [4096], [[64, 64]])
      console.log('window csmith: ' + (index + 1) + ' of ' + files.length + ' programs (' +
        Math.floor(((index + 1) * 100) / files.length) + '%)')
    })
    assert.deepEqual(failures, [])
    assert.equal(compared, 2 * files.length)
  })

  test('a-long-document-parses-in-time-linear-in-its-length', () => {
    // Ten times the declarations take about ten times the time, from a
    // reader as from the text: well under the square of it.
    const doc = (n: number) => {
      const out: string[] = []
      for (let i = 0; i < n; i++) out.push('/* c ' + i + ' */\nint x' + i + ' = ' + i + ';\n')
      return out.join('')
    }
    const tn = make() as any
    const time = (text: string) => {
      const bytes = Buffer.from(text, 'utf8')
      const t0 = process.hrtime.bigint()
      tn.parseReader(pieces(bytes, 4096))
      return Number(process.hrtime.bigint() - t0) / 1e6
    }
    time(doc(200))
    const small = Math.min(time(doc(1000)), time(doc(1000)))
    const large = Math.min(time(doc(10000)), time(doc(10000)))
    console.log('window time: 1000 declarations ' + small.toFixed(0) + ' ms, 10000 ' +
      large.toFixed(0) + ' ms (' + (large / small).toFixed(1) + ' times)')
    assert.ok(large < 25 * small, small + ' ms, then ' + large + ' ms')
  })
})
