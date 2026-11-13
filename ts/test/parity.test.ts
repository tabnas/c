/* Copyright (c) 2025 Richard Rodger and other contributors, MIT License */

// Cross-runtime conformance, driven by the shared `test/spec/*.tsv` fixtures
// at the repo root (see ../../test/AGENTS.md).
//
// The fixture loader, the escape codec, the `ERROR:<code>` contract and the
// row loop all come from @tabnas/support, whose Go half `go/parity_test.go`
// and Rust half `rs/tests/parity_test.rs` use to run the SAME files — so
// the three implementations cannot drift without one of them going red,
// and neither can the loaders.
//
// What is left here is only what is specific to c: how to build the parser
// for a row's options.

import { join } from 'node:path'

import { Tabnas } from '@tabnas/parser'
import { jsonic } from '@tabnas/jsonic'
import { findSpecDir, makeRunner } from '@tabnas/support'

import { C, member } from '../dist/c.js'

// A row whose opts name a `member` reads it back through the API: the
// `nth` node of kind `find` (depth first, the root's children before
// their children), its member `member`, each node it gives projected to
// its kind, its span's start and its tokens' text, so a row stays short
// and still names the one node it means.
function findNth(root: any, kind: string, nth: number): any {
  let seen = 0
  const stack = [root]
  while (stack.length) {
    const n = stack.shift()
    if (!n || 'object' !== typeof n || 'token' === n.kind) continue
    if (n.kind === kind && seen++ === nth) return n
    if (Array.isArray(n.children)) stack.unshift(...n.children)
  }
  return undefined
}

function memberText(n: any): string {
  const out: string[] = []
  const walk = (x: any) => {
    if (!x || 'object' !== typeof x) return
    if ('token' === x.kind) {
      if (!String(x.tname).startsWith('TRIVIA')) out.push(x.src)
      return
    }
    for (const c of x.children || []) walk(c)
  }
  walk(n)
  return out.join(' ')
}

function project(m: any): any {
  if (undefined === m) return null
  if (Array.isArray(m)) return m.map(project)
  return { kind: m.kind, start: m.span.start, text: memberText(m) }
}

makeRunner({
  parse: (input, row) => {
    // The opts column is {plugin?, start?, find?, nth?, member?}: `plugin`
    // is the C plugin's own options (extension constructs are opt-in),
    // `start` overrides the engine's start rule so an expression can be
    // parsed directly, and `member` reads a node's member back (above).
    const raw = row.named('opts')
    const opts = '' === raw.trim() ? {} : JSON.parse(raw)

    const tn = new Tabnas().use(jsonic).use(C, opts.plugin ?? {})
    if (opts.start) tn.options({ rule: { start: opts.start } })

    const tree = tn.parse(input)
    if (opts.member) {
      const node = findNth(tree, opts.find, opts.nth ?? 0)
      if (!node) throw new Error(`members: no ${opts.find} #${opts.nth ?? 0}`)
      return project(member(node, opts.member))
    }
    return tree
  },
})
  // `findSpecDir` walks up looking for a `test/spec`, and it must start
  // ABOVE `ts/`: this repo also has a TypeScript-only fixture directory at
  // `ts/test/spec` (path-dispatch, run from c.test.ts), which a search
  // started at `dist-test/` would find first and run instead of the
  // cross-runtime fixtures. `dir` then auto-discovers every fixture in the
  // directory, so adding a .tsv runs it in every runtime without touching
  // any runner.
  .dir(findSpecDir(join(__dirname, '..', '..')))
