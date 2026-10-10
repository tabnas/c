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
