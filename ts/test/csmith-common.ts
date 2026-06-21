/* Copyright (c) 2026 Richard Rodger and contributors, MIT License */

// Shared helpers for the csmith corpus tests and the csmith-gen CLI.
//
// Importing this file has zero side effects (no mkdirSync, no
// process.argv reads, no calls to the csmith binary), so the test
// runner can pull in STDINT_TYPEDEFS and parseCsmithSource without
// dragging in the corpus generator.

import { join } from 'node:path'

import { Tabnas } from '@tabnas/parser'
import { jsonic } from '@tabnas/jsonic'
import { C } from '../dist/c.js'
import { makeCMeta } from '../dist/symbols.js'

// Names provided by csmith.h. The parser doesn't expand `#include`,
// so we pre-register these as typedef-names before each parse.
// Without it, e.g. `static int32_t g_2 = 6L;` would parse `int32_t`
// as the declared name.
export const STDINT_TYPEDEFS = [
  'int8_t', 'int16_t', 'int32_t', 'int64_t',
  'uint8_t', 'uint16_t', 'uint32_t', 'uint64_t',
  'size_t', 'ssize_t', 'ptrdiff_t', 'intptr_t', 'uintptr_t',
  'wchar_t', 'wint_t', 'time_t', 'clock_t', 'off_t',
  'FILE', 'va_list',
] as const

export const CORPUS_DIR = join(process.cwd(), 'test', 'csmith-corpus')
export const FIXTURES_DIR = join(process.cwd(), 'test', 'csmith-fixtures')

export function seedName(seed: number): string {
  return `seed-${String(seed).padStart(3, '0')}`
}

export function corpusPath(seed: number): string {
  return join(CORPUS_DIR, seedName(seed) + '.c')
}

export function fixturePath(seed: number): string {
  return join(FIXTURES_DIR, seedName(seed) + '.json.gz')
}

// Parse a csmith-shaped source with stdint typedef-names pre-registered.
// csmith generates GCC-flavoured C with #include / __attribute__ etc.,
// so the parser is constructed with `extended: true`.
export function parseCsmithSource(src: string): any {
  const j = new Tabnas().use(jsonic).use(C, { extended: true })
  const cmeta = makeCMeta()
  for (const n of STDINT_TYPEDEFS) cmeta.symbols.bindTypedef(n)
  return j.parse(src, { cmeta })
}
