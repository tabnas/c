/* Copyright (c) 2025 Richard Rodger and other contributors, MIT License */

// Cross-runtime conformance, driven by the shared `test/spec/*.tsv` fixtures
// at the repo root (see ../../test/AGENTS.md).
//
// The fixture loader, the escape codec, the `ERROR:<code>` contract and the
// row loop all come from @tabnas/support, whose Go half `go/parity_test.go`
// uses to run the SAME files — so the two implementations cannot drift
// without one of them going red, and neither can the two loaders.
//
// What is left here is only what is specific to c: how to build the parser
// for a row's options.

import { join } from 'node:path'

import { Tabnas } from '@tabnas/parser'
import { jsonic } from '@tabnas/jsonic'
import { findSpecDir, makeRunner } from '@tabnas/support'

import { C } from '../dist/c.js'

makeRunner({
  parse: (input, row) => {
    // The opts column is {plugin?, start?}: `plugin` is the C plugin's own
    // options (extension constructs are opt-in), `start` overrides the
    // engine's start rule so an expression can be parsed directly.
    const raw = row.named('opts')
    const opts = '' === raw.trim() ? {} : JSON.parse(raw)

    const tn = new Tabnas().use(jsonic).use(C, opts.plugin ?? {})
    if (opts.start) tn.options({ rule: { start: opts.start } })

    return tn.parse(input)
  },
})
  // `findSpecDir` walks up looking for a `test/spec`, and it must start
  // ABOVE `ts/`: this repo also has a TypeScript-only fixture directory at
  // `ts/test/spec` (path-dispatch, run from c.test.ts), which a search
  // started at `dist-test/` would find first and run instead of the
  // cross-runtime fixtures. `dir` then auto-discovers every fixture in the
  // directory, so adding a .tsv runs it in both runtimes without touching
  // either runner.
  .dir(findSpecDir(join(__dirname, '..', '..')))
