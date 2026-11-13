/* Copyright (c) 2026 Richard Rodger and contributors, MIT License */

// Every repetition is a replace loop (admin's and parser's "Repetition is
// replacement, never a push chain"): over 10,000 items of each, the
// deepest rule the parse reaches is as deep as over one item.

import { test, describe } from 'node:test'
import assert from 'node:assert'

import { Tabnas } from '@tabnas/parser'
import { jsonic } from '@tabnas/jsonic'
import { C } from '../dist/c.js'

const MANY = 10000

function maxDepth(src: string, extended: boolean): number {
  const j = new Tabnas().use(jsonic).use(C, { extended })
  let max = 0
  j.sub({
    rule: (rule: any) => {
      if (rule.d > max) max = rule.d
    },
  })
  j.parse(src)
  return max
}

// Each case: a document of `n` items.
const CASES: Array<[string, (n: number) => string, boolean?]> = [
  ['external declarations', (n) => 'int a;\n'.repeat(n)],
  ['block items', (n) => 'void f(void) {' + ' x;'.repeat(n) + ' }'],
  ['init declarators', (n) => 'int a' + ', a'.repeat(n - 1) + ';'],
  ['specifiers', (n) => 'const '.repeat(n) + 'int x;'],
  ['a binary chain', (n) => 'int x = a' + ' + a'.repeat(n) + ';'],
  ['a comma expression', (n) => 'void f(void) { a' + ', a'.repeat(n) + '; }'],
  ['arguments', (n) => 'int x = f(a' + ', a'.repeat(n - 1) + ');'],
  ['a postfix chain', (n) => 'int x = a' + '[0]'.repeat(n) + ';'],
  ['member accesses', (n) => 'int x = a' + '.b'.repeat(n) + ';'],
  ['adjacent strings', (n) => 'char *s = ' + '"a" '.repeat(n) + ';'],
  ['brace-list items', (n) => 'int x[] = { 1' + ', 1'.repeat(n - 1) + ' };'],
  ['struct members', (n) => 'struct S {' + ' int a;'.repeat(n) + ' };'],
  ['enumerators', (n) => 'enum E { A' + ', A'.repeat(n - 1) + ' };'],
  ['parameters', (n) => 'void f(int' + ', int'.repeat(n - 1) + ');'],
  ['an unknown declaration\'s tokens', (n) => 'foo' + ' a'.repeat(n) + ';'],
  ['a macro body', (n) => '#define X' + ' a'.repeat(n) + '\n', true],
  ['a conditional branch\'s declarations', (n) => '#if A\n' + 'int a;\n'.repeat(n) + '#endif\n'],
  ['a conditional group\'s branches', (n) => '#if A\n' + '#elif B\n'.repeat(n) + '#endif\n'],
  ['conditional groups', (n) => '#if A\n#endif\n'.repeat(n)],
  ['asm operands', (n) => 'void f(void) { asm("" : "r" (a)' + ', "r" (a)'.repeat(n - 1) + '); }', true],
  ['an asm operand\'s flat tokens', (n) => 'void f(void) { asm("" : "r" (a)' + ' b'.repeat(n) + '); }', true],
]

describe('repetition', () => {
  for (const [name, make, ext] of CASES) {
    test(`${name}: ${MANY} items reach the depth of one`, () => {
      const one = maxDepth(make(1), ext === true)
      const many = maxDepth(make(MANY), ext === true)
      assert.strictEqual(many, one, `${name}: depth ${many} over ${MANY} items, ${one} over one`)
    })
  }
})
