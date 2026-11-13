/* Copyright (c) 2026 Richard Rodger and other contributors, MIT License */
'use strict'

import * as assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import * as path from 'node:path'
import { test } from 'node:test'

import { translate } from '../dist/c.js'

const root = path.resolve(__dirname, '..', '..')

// The parts a host sees are the package's own copies, written by
// `npm run embed`; they must be the repository's files.
test('translation parts expose the manifest, source and explicit entry', () => {
  const parts = translate()
  assert.ok(parts)
  assert.equal(parts.manifest, readFileSync(path.join(root, 'tabnas.plugin.json'), 'utf8'))
  assert.equal(parts.lift, undefined)
  assert.equal(parts.render?.entry, 'c-render')
  assert.equal(parts.render?.source, readFileSync(path.join(root, 'alchemy', 'render.alc'), 'utf8'))
})

// The transducer part the manifest names is the one the package carries,
// and c streams through it, so the manifest no longer says it is read whole.
test('translation parts carry the transducer the manifest names', () => {
  const parts = translate()
  assert.ok(parts)
  const spec = JSON.parse(readFileSync(path.join(root, 'tabnas.plugin.json'), 'utf8')).translate
  assert.equal(spec.transduce, 'alchemy/transduce.alc')
  assert.equal(spec.whole, undefined)
  assert.equal(parts.transduce?.entry, 'c-transduce')
  assert.equal(parts.transduce?.source, readFileSync(path.join(root, spec.transduce), 'utf8'))
})

// A host links the transducer beside the render and other formats' parts
// in one namespace, so its entry is `c-transduce` and every other
// definition is named `c-tr-`, a name the render does not use.
test('the transducer is a library named apart from the render', () => {
  const names = (source: string) => source.split('\n')
    .filter((line) => line.startsWith('def '))
    .map((line) => line.slice(4).split(/\s/)[0])
  const part = names(translate()?.transduce?.source ?? '')
  const render = new Set(names(translate()?.render?.source ?? ''))
  assert.ok(part.includes('c-transduce'), part.join(' '))
  for (const name of part) {
    assert.ok('c-transduce' === name || name.startsWith('c-tr-'), `${name} is not named c-tr-`)
    assert.ok(!render.has(name), `${name} is defined by the render too`)
  }
})

// An embed takes a plain tree into a format's own schema. c's render
// writes the syntax tree the reader builds and nothing else, so its
// manifest names no embed and the package carries none; a manifest that
// named one would be held to its file here, as the render is above.
test('translation parts carry the embed the manifest names, and none where it names none', () => {
  const parts = translate()
  assert.ok(parts)
  const spec = JSON.parse(readFileSync(path.join(root, 'tabnas.plugin.json'), 'utf8')).translate
  if (null == spec.embed) {
    assert.equal(parts.embed, undefined)
  } else {
    assert.equal(parts.embed?.entry, 'c-embed')
    assert.equal(parts.embed?.source, readFileSync(path.join(root, spec.embed), 'utf8'))
  }
})

// The tree is the reader's own shape, so the manifest names it.
test('the manifest names the c schema and an object root', () => {
  const parts = translate()
  assert.ok(parts)
  const manifest = JSON.parse(parts.manifest)
  assert.equal(manifest.languageId, 'c')
  const spec = manifest.translate
  assert.equal(spec.reads, 'tree')
  assert.equal(spec.writes, 'tree')
  assert.equal(spec.root, 'object')
  assert.equal(spec.schema, 'c')
  assert.equal(spec.render, 'alchemy/render.alc')
  assert.ok(Array.isArray(spec.loss) && 0 < spec.loss.length)
  for (const line of spec.loss) {
    assert.match(line, /^[A-Z].*\.$/s, `${JSON.stringify(line)} is not a sentence`)
  }
})

// A host links the render with its own program and other formats' parts,
// so every definition is named for c, the entry point is `c-render`, and
// the file defines no `export` of its own.
test('the render is a library named for c', () => {
  const source = translate()?.render?.source ?? ''
  const names = source
    .split('\n')
    .filter((line) => line.startsWith('def '))
    .map((line) => line.slice(4).split(/\s/)[0])
  assert.ok(names.includes('c-render'), names.join(' '))
  for (const name of names) {
    assert.ok(name.startsWith('c-'), `${name} is not named for c`)
  }
})
