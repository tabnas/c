/* Copyright (c) 2026 Richard Rodger and contributors, MIT License */

import { test, describe } from 'node:test'
import assert from 'node:assert'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { Tabnas } from '@tabnas/parser'
import { jsonic } from '@tabnas/jsonic'
import { C } from '../dist/c.js'

// Most tests in this file exercise extension constructs (preprocessor,
// GCC __attribute__, MSVC __declspec, inline asm, etc.), so the shared
// instance enables them via { extended: true }. New plain-C-only tests
// should construct a separate instance with the default (no opt-in).
const j = new Tabnas().use(jsonic).use(C, { extended: true })

// Walk a CST node depth-first and yield its token-refs in source order.
function walkTokens(node: any): any[] {
  const out: any[] = []
  const visit = (n: any) => {
    if (!n) return
    if (n.kind === 'token') { out.push(n); return }
    if (Array.isArray(n.children)) {
      for (const c of n.children) visit(c)
    }
  }
  visit(node)
  return out
}

function findTokenBySrc(node: any, src: string): any {
  return walkTokens(node).find((t) => t.src === src)
}

function tokenSrcs(node: any): string[] {
  return walkTokens(node).map((t) => t.src)
}

function tokenNames(node: any): string[] {
  return walkTokens(node).map((t) => t.tname)
}

// Find the first descendant of `node` whose .kind matches.
function findKind(node: any, kind: string): any {
  if (!node) return null
  if (node.kind === kind) return node
  if (Array.isArray(node.children)) {
    for (const c of node.children) {
      const hit = findKind(c, kind)
      if (hit) return hit
    }
  }
  return null
}

describe('phase A: @jsonic/expr standalone', () => {
  // These tests confirm that @jsonic/expr's val rule + the evaluate
  // callback in src/expr-grammar.ts produce the expected CST shapes
  // when val is reached directly (start = 'val'). Phase B will wire
  // val into the main grammar at expression contexts; until then, we
  // only exercise it via this fresh-instance probe.

  function exprParser(): any {
    const e = new Tabnas().use(jsonic).use(C)
    e.options({ rule: { start: 'val' } })
    return e
  }

  test('atom: literal_expression for an integer', () => {
    const out = exprParser().parse('42')
    assert.equal(out.kind, 'literal_expression')
    assert.equal(out.literalKind, 'LIT_INT')
    assert.equal(out.value, '42')
  })

  test('atom: identifier_expression for a plain ID', () => {
    const out = exprParser().parse('foo')
    assert.equal(out.kind, 'identifier_expression')
    assert.equal(out.name, 'foo')
  })

  test('binary precedence: 1 + 2 * 3 binds * tighter', () => {
    const out = exprParser().parse('1 + 2 * 3')
    assert.equal(out.kind, 'binary_expression')
    assert.equal(out.op, '+')
    assert.equal(out.left.kind, 'literal_expression')
    assert.equal(out.left.value, '1')
    assert.equal(out.right.kind, 'binary_expression')
    assert.equal(out.right.op, '*')
  })

  test('left-assoc: a - b - c parses as ((a-b)-c)', () => {
    const out = exprParser().parse('a - b - c')
    assert.equal(out.kind, 'binary_expression')
    assert.equal(out.op, '-')
    assert.equal(out.left.kind, 'binary_expression')
    assert.equal(out.left.op, '-')
    assert.equal(out.right.kind, 'identifier_expression')
    assert.equal(out.right.name, 'c')
  })
})

describe('c parser smoke', () => {

  test('lex: tokenises a simple typedef declaration', () => {
    const src = 'typedef int T;'
    const out = j.parse(src)
    assert.ok(out, 'parse should produce a translation unit')
    assert.equal(out.kind, 'translation_unit')
  })

  test('lex: tokenises arithmetic and identifiers', () => {
    const src = 'int x = 42;'
    const out = j.parse(src)
    assert.equal(out.kind, 'translation_unit')
  })

  test('typedef registration: T becomes a typedef-name', () => {
    const src = 'typedef int T;\nT x;\n'
    const out = j.parse(src)
    assert.equal(out.kind, 'translation_unit')
    assert.ok(out.children.length >= 2, 'expected two external declarations')
    const tTok = findTokenBySrc(out.children[1], 'T')
    assert.ok(tTok, 'expected a token with src "T"')
    assert.equal(tTok.tname, 'TYPEDEF_NAME')
    const xTok = findTokenBySrc(out.children[1], 'x')
    assert.equal(xTok.tname, 'ID')
  })

  test('keyword vs identifier boundary: int_value is one ID, not int + _value', () => {
    const src = 'int int_value;'
    const out = j.parse(src)
    const decl = out.children[0]
    assert.deepEqual(tokenSrcs(decl), ['int', 'int_value', ';'])
    const realToks = walkTokens(decl).filter((t) => !t.tname.startsWith('TRIVIA_'))
    assert.equal(realToks[0].tname, 'KW_INT')
    assert.equal(realToks[1].tname, 'ID')
  })

  test('lex preserves block and line comments as trivia tokens', () => {
    const src = '/* hi */ int x; // trail\n'
    const out = j.parse(src)
    assert.equal(out.kind, 'translation_unit')
    const blockTokenAnywhere = out.children
      .flatMap((d: any) => walkTokens(d))
      .find((c: any) => c.tname === 'TRIVIA_BLOCK_COMMENT')
    assert.ok(blockTokenAnywhere, 'block comment must survive in the AST')
  })

  test('punctuator dispatch: 3-char and 2-char operators', () => {
    const src = 'a >>= 1;'
    const out = j.parse(src)
    // `a >>= 1;` parses as an expression statement at the top level — but
    // our top-level chomp treats it as a declaration shape. Either way,
    // the four tokens are preserved.
    const names = tokenNames(out.children[0]).filter((n) => !n.startsWith('TRIVIA_'))
    assert.deepEqual(names, ['ID', 'PUNC_RSHIFT_ASSIGN', 'LIT_INT', 'PUNC_SEMI'])
  })

  test('typedef multi-name: typedef int A, B, C;', () => {
    const src = 'typedef int A, B, C; A x; B y; C z;'
    const out = j.parse(src)
    const decls = out.children
    assert.ok(decls.length >= 4)
    assert.equal(findTokenBySrc(decls[1], 'A')?.tname, 'TYPEDEF_NAME')
    assert.equal(findTokenBySrc(decls[2], 'B')?.tname, 'TYPEDEF_NAME')
    assert.equal(findTokenBySrc(decls[3], 'C')?.tname, 'TYPEDEF_NAME')
  })

  test('typedef with pointers: typedef int *PI;', () => {
    const src = 'typedef int *PI; PI p;'
    const out = j.parse(src)
    assert.equal(findTokenBySrc(out.children[1], 'PI')?.tname, 'TYPEDEF_NAME')
  })

  test('typedef array: typedef int Arr[10];', () => {
    const src = 'typedef int Arr[10]; Arr a;'
    const out = j.parse(src)
    assert.equal(findTokenBySrc(out.children[1], 'Arr')?.tname, 'TYPEDEF_NAME')
  })

  test('typedef function pointer: typedef int (*Fn)(int);', () => {
    const src = 'typedef int (*Fn)(int); Fn f;'
    const out = j.parse(src)
    assert.equal(findTokenBySrc(out.children[1], 'Fn')?.tname, 'TYPEDEF_NAME')
  })

  test('phase P: variable function pointer: int (*fp)(int);', () => {
    const src = 'int (*fp)(int);'
    const out = j.parse(src)
    assert.equal(out.children.length, 1)
    const decl = out.children[0]
    assert.equal(decl.declKind, 'declaration')
    // declarator > direct_declarator > [LPAREN, declarator(inner *fp), RPAREN, function_postfix]
    const idl = decl.children.find((c: any) => c.kind === 'init_declarator_list')
    assert.ok(idl)
    const id = idl.children[0]
    assert.equal(id.kind, 'init_declarator')
    const outerDecl = id.children[0]
    assert.equal(outerDecl.kind, 'declarator')
    const outerDD = outerDecl.children[0]
    assert.equal(outerDD.kind, 'direct_declarator')
    const dnames = outerDD.children.map((c: any) =>
      c.kind === 'token' ? c.tname : c.kind)
    assert.deepEqual(dnames, ['PUNC_LPAREN', 'declarator', 'PUNC_RPAREN', 'function_postfix'])
    assert.equal(outerDD.declaredName, 'fp')
  })

  test('phase P: function pointer with multiple params', () => {
    const src = 'int (*fp)(int a, char b);'
    const out = j.parse(src)
    assert.equal(out.children.length, 1)
    assert.equal(out.children[0].declKind, 'declaration')
  })

  test('phase P: function pointer with multiple stars', () => {
    const src = 'int (**fp)(int);'
    const out = j.parse(src)
    assert.equal(out.children.length, 1)
    assert.equal(out.children[0].declKind, 'declaration')
  })

  test('phase P: function pointer with pointer params', () => {
    const src = 'int (*fp)(char *s);'
    const out = j.parse(src)
    assert.equal(out.children.length, 1)
    assert.equal(out.children[0].declKind, 'declaration')
    // Verify the param has a pointer node
    const fnp = (function find(n: any): any {
      if (!n) return null
      if (n.kind === 'function_postfix') return n
      for (const c of n.children || []) { const r = find(c); if (r) return r }
      return null
    })(out.children[0])
    assert.ok(fnp)
    const ptl = fnp.children.find((c: any) => c.kind === 'parameter_type_list')
    const pd = ptl.children.find((c: any) => c.kind === 'parameter_declaration')
    const decl = pd.children.find((c: any) => c.kind === 'declarator')
    assert.ok(decl, 'param has declarator')
    const ptr = decl.children.find((c: any) => c.kind === 'pointer')
    assert.ok(ptr, 'param declarator has pointer')
  })

  test('phase P: function pointer with abstract pointer param', () => {
    const src = 'int (*fp)(int *);'
    const out = j.parse(src)
    assert.equal(out.children.length, 1)
    assert.equal(out.children[0].declKind, 'declaration')
  })

  test('typedef of struct tag: typedef struct S T;', () => {
    const src = 'typedef struct S T; T t;'
    const out = j.parse(src)
    assert.equal(findTokenBySrc(out.children[1], 'T')?.tname, 'TYPEDEF_NAME')
  })

  test('typedef of struct with body: typedef struct { int x; } S;', () => {
    const src = 'typedef struct { int x; } S; S s;'
    const out = j.parse(src)
    const sTok = walkTokens(out.children[1])
      .find((t: any) => t.src === 'S' && t.tname === 'TYPEDEF_NAME')
    assert.ok(sTok, 'S should be registered as a typedef-name')
  })

  test('mixed typedef declarators: typedef int *p, q[3];', () => {
    const src = 'typedef int *p, q[3]; p x; q y;'
    const out = j.parse(src)
    assert.equal(findTokenBySrc(out.children[1], 'p')?.tname, 'TYPEDEF_NAME')
    assert.equal(findTokenBySrc(out.children[2], 'q')?.tname, 'TYPEDEF_NAME')
  })

  test('function definition followed by another decl', () => {
    const src = 'int main(void) { return 0; } int x;'
    const out = j.parse(src)
    assert.equal(out.children.length, 2)
    const firstSrcs = tokenSrcs(out.children[0])
    assert.ok(firstSrcs.includes('return'))
    assert.ok(firstSrcs.includes('}'))
    assert.deepEqual(tokenSrcs(out.children[1]), ['int', 'x', ';'])
  })

  test('compound literal initializer with braces does not prematurely terminate', () => {
    const src = 'struct S x = { .a = 1, .b = 2 };'
    const out = j.parse(src)
    assert.equal(out.children.length, 1)
    const realToks = walkTokens(out.children[0])
      .filter((t) => !t.tname.startsWith('TRIVIA_'))
    assert.equal(realToks[realToks.length - 1].src, ';')
  })

  test('trivia: leading comments attach to next token', () => {
    const src = '/* h */ int /* t */ x; // tail\nint y;'
    const out = j.parse(src)
    const allNames = out.children.flatMap((d: any) => tokenNames(d))
    assert.ok(allNames.includes('TRIVIA_BLOCK_COMMENT'))
    assert.ok(allNames.includes('TRIVIA_LINE_COMMENT'))
    const idxBC = allNames.indexOf('TRIVIA_BLOCK_COMMENT')
    const idxKWI = allNames.indexOf('KW_INT')
    assert.ok(idxBC < idxKWI, 'block comment must precede int keyword')
  })

  test('trivia: line continuation is preserved as a token-ref', () => {
    const src = 'int \\\nx;'
    const out = j.parse(src)
    const tnames = tokenNames(out.children[0])
    assert.ok(tnames.includes('TRIVIA_LINE_CONT'))
    const real = tnames.filter((n) => !n.startsWith('TRIVIA_'))
    assert.deepEqual(real, ['KW_INT', 'ID', 'PUNC_SEMI'])
  })

  test('whitespace is not emitted as a token', () => {
    const src = 'int   x   ;'
    const out = j.parse(src)
    const tnames = tokenNames(out.children[0])
      .filter((n) => !n.startsWith('TRIVIA_'))
    assert.deepEqual(tnames, ['KW_INT', 'ID', 'PUNC_SEMI'])
  })

  // ---- Structural CST shape (slice 4) ----------------------------------

  test('structure: simple declaration produces declaration_specifiers + init_declarator_list + ;', () => {
    const src = 'int x = 1;'
    const out = j.parse(src)
    const ext = out.children[0]
    assert.equal(ext.declKind, 'declaration')
    const specs = findKind(ext, 'declaration_specifiers')
    assert.ok(specs)
    assert.deepEqual(tokenSrcs(specs), ['int'])
    const idl = findKind(ext, 'init_declarator_list')
    assert.ok(idl)
    const id = findKind(idl, 'init_declarator')
    assert.ok(id)
    assert.equal(id.declaredName, 'x')
    const init = findKind(id, 'initializer')
    assert.ok(init)
    assert.deepEqual(tokenSrcs(init), ['1'])
  })

  test('structure: multiple declarators in one declaration', () => {
    const src = 'int a, b = 2, c;'
    const out = j.parse(src)
    const idl = findKind(out.children[0], 'init_declarator_list')
    const ids = (idl?.children || []).filter((c: any) => c.kind === 'init_declarator')
    assert.equal(ids.length, 3)
    assert.deepEqual(ids.map((d: any) => d.declaredName), ['a', 'b', 'c'])
  })

  test('structure: pointer/array/function declarators', () => {
    const src = 'int *p; int a[10]; int f(int x);'
    const out = j.parse(src)
    const decls = out.children
    // pointer
    const declP = decls[0]
    assert.ok(findKind(declP, 'pointer'))
    assert.equal(findKind(declP, 'init_declarator').declaredName, 'p')
    // array
    const declA = decls[1]
    assert.ok(findKind(declA, 'array_postfix'))
    assert.equal(findKind(declA, 'init_declarator').declaredName, 'a')
    // function declaration
    const declF = decls[2]
    assert.ok(findKind(declF, 'function_postfix'))
    assert.equal(findKind(declF, 'init_declarator').declaredName, 'f')
  })

  test('structure: function definition has compound_statement', () => {
    const src = 'int main(void) { return 0; }'
    const out = j.parse(src)
    const ext = out.children[0]
    assert.equal(ext.declKind, 'function_definition')
    assert.ok(findKind(ext, 'declaration_specifiers'))
    assert.ok(findKind(ext, 'declarator'))
    assert.ok(findKind(ext, 'compound_statement'))
  })

  test('structure: struct definition with body', () => {
    const src = 'struct S { int x; int y; };'
    const out = j.parse(src)
    const ss = findKind(out.children[0], 'struct_specifier')
    assert.ok(ss)
    assert.equal(ss.tagName, 'S')
    assert.ok(findKind(ss, 'member_decl_list'))
  })

  test('structure: enum with C23 fixed underlying type', () => {
    const src = 'enum E : int { A, B, C };'
    const out = j.parse(src)
    const en = findKind(out.children[0], 'enum_specifier')
    assert.ok(en)
    assert.equal(en.tagName, 'E')
    assert.ok(findKind(en, 'enumerator_list'))
  })

  test('structure: __attribute__ on a declaration', () => {
    const src = '__attribute__((noreturn)) void die(void);'
    const out = j.parse(src)
    const ext = out.children[0]
    assert.equal(ext.declKind, 'declaration')
    assert.ok(findKind(ext, 'attribute_spec'))
  })

  // ---- Structural members (slice 5) ------------------------------------

  test('structure: struct members parsed as struct_declaration nodes', () => {
    const src = 'struct S { int x; char *p; double d; };'
    const out = j.parse(src)
    const ml = findKind(out.children[0], 'member_decl_list')
    assert.ok(ml)
    const members = ml.children.filter((c: any) => c.kind === 'struct_declaration')
    assert.equal(members.length, 3)
    // Each member has a specifier_qualifier_list and a struct_declarator_list.
    for (const m of members) {
      assert.ok(findKind(m, 'specifier_qualifier_list'))
      assert.ok(findKind(m, 'struct_declarator_list'))
    }
    // Names of declared fields:
    const fieldNames = members.map((m: any) =>
      findKind(m, 'struct_declarator')?.declaredName)
    assert.deepEqual(fieldNames, ['x', 'p', 'd'])
  })

  test('structure: bitfield members are recognised', () => {
    const src = 'struct B { unsigned int flag : 1; int : 7; int n; };'
    const out = j.parse(src)
    const ml = findKind(out.children[0], 'member_decl_list')
    const sds = ml.children.filter((c: any) => c.kind === 'struct_declaration')
    assert.equal(sds.length, 3)
    // Member 0: declarator + bitfield_width
    const m0 = sds[0]
    assert.ok(findKind(m0, 'bitfield_width'))
    assert.equal(findKind(m0, 'struct_declarator')?.declaredName, 'flag')
    // Member 1: anonymous bitfield, no declared name.
    const m1 = sds[1]
    assert.ok(findKind(m1, 'bitfield_width'))
    assert.equal(findKind(m1, 'struct_declarator')?.declaredName, undefined)
  })

  test('structure: enum members parsed as enumerator nodes', () => {
    const src = 'enum E { A, B = 2, C, };'
    const out = j.parse(src)
    const el = findKind(out.children[0], 'enumerator_list')
    assert.ok(el)
    const enums = el.children.filter((c: any) => c.kind === 'enumerator')
    assert.equal(enums.length, 3)
    assert.deepEqual(enums.map((e: any) => e.declaredName), ['A', 'B', 'C'])
    // B has an initializer.
    assert.ok(findKind(enums[1], 'initializer'))
  })

  // ---- Statements (slice 6) -------------------------------------------

  test('statements: function body decomposes into block items', () => {
    const src = 'int f(void) { int x = 1; x = x + 1; return x; }'
    const out = j.parse(src)
    const cs = findKind(out.children[0], 'compound_statement')
    assert.ok(cs)
    const items = cs.children.filter(
      (c: any) => c.kind === 'declaration' || c.kind === 'expression_statement' ||
                  c.kind === 'jump_statement',
    )
    assert.equal(items.length, 3)
    assert.equal(items[0].kind, 'declaration')
    assert.equal(items[1].kind, 'expression_statement')
    assert.equal(items[2].kind, 'jump_statement')
    assert.equal(items[2].jumpKind, 'return')
  })

  test('statements: if/else, while, for', () => {
    const src = `
      int f(int n) {
        if (n > 0) return 1; else return 0;
        while (n--) ;
        for (int i = 0; i < 10; i++) n += i;
      }
    `
    const out = j.parse(src)
    const cs = findKind(out.children[0], 'compound_statement')
    assert.ok(findKind(cs, 'if_statement'))
    assert.ok(findKind(cs, 'while_statement'))
    assert.ok(findKind(cs, 'for_statement'))
    assert.ok(findKind(cs, 'for_controls'))
  })

  test('statements: switch with case and default labels', () => {
    const src = `
      int f(int x) {
        switch (x) {
          case 1: return 1;
          case 2: return 2;
          default: return 0;
        }
      }
    `
    const out = j.parse(src)
    const sw = findKind(out.children[0], 'switch_statement')
    assert.ok(sw)
    // Inside the switch body's compound_statement we expect three labeled
    // statements with appropriate labelKind tags.
    const labels: any[] = []
    const visit = (n: any) => {
      if (!n) return
      if (n.kind === 'labeled_statement') labels.push(n)
      if (Array.isArray(n.children)) for (const c of n.children) visit(c)
    }
    visit(sw)
    assert.equal(labels.length, 3)
    assert.deepEqual(labels.map((l: any) => l.labelKind), ['case', 'case', 'default'])
  })

  test('statements: goto + label', () => {
    const src = 'void f(void) { goto out; out: return; }'
    const out = j.parse(src)
    const cs = findKind(out.children[0], 'compound_statement')
    const jmp = findKind(cs, 'jump_statement')
    assert.equal(jmp.jumpKind, 'goto')
    const lbl = findKind(cs, 'labeled_statement')
    assert.equal(lbl.labelKind, 'label')
    assert.equal(lbl.labelName, 'out')
  })

  test('statements: do/while', () => {
    const src = 'void f(void) { do { } while (0); }'
    const out = j.parse(src)
    assert.ok(findKind(out.children[0], 'do_statement'))
  })

  // ---- Preprocessor directives (slice 7) ------------------------------

  test('preprocessor: #include with angled header name', () => {
    const src = '#include <stdio.h>\nint x;'
    const out = j.parse(src)
    assert.equal(out.children.length, 2)
    const inc = findKind(out.children[0], 'include_directive')
    assert.ok(inc)
    assert.equal(inc.headerKind, 'angled')
    assert.equal(inc.headerName, '<stdio.h>')
    // Following declaration is unaffected.
    assert.equal(out.children[1].declKind, 'declaration')
  })

  test('preprocessor: #include with quoted header name', () => {
    const src = '#include "local.h"'
    const out = j.parse(src)
    const inc = findKind(out.children[0], 'include_directive')
    assert.equal(inc.headerKind, 'quoted')
    assert.equal(inc.headerName, '"local.h"')
  })

  test('preprocessor: #define object-like', () => {
    const src = '#define MAX 100\nint x = 1;'
    const out = j.parse(src)
    const def = findKind(out.children[0], 'define_directive')
    assert.equal(def.macroName, 'MAX')
    assert.equal(def.macroKind, 'object-like')
    assert.ok(findKind(def, 'macro_body'))
    assert.equal(out.children[1].declKind, 'declaration')
  })

  test('preprocessor: #define function-like with params and variadic', () => {
    const src = '#define LOG(fmt, ...) printf(fmt, __VA_ARGS__)\n'
    const out = j.parse(src)
    const def = findKind(out.children[0], 'define_directive')
    assert.equal(def.macroName, 'LOG')
    assert.equal(def.macroKind, 'function-like')
    assert.deepEqual(def.macroParams, ['fmt'])
    assert.equal(def.macroVariadic, true)
  })

  test('preprocessor: #if … #endif fold into a conditional_group', () => {
    const src = '#if FOO\nint x;\n#endif\n'
    const out = j.parse(src)
    assert.equal(out.children.length, 1)
    const grp = out.children[0]
    assert.equal(grp.kind, 'conditional_group')
    assert.equal(grp.branches.length, 1)
    const b = grp.branches[0]
    assert.equal(b.branchKind, 'if')
    // The branch's body view contains exactly the body declaration.
    assert.equal(b.body.length, 1)
    assert.equal(b.body[0].kind, 'external_declaration')
    assert.ok(grp.endif)
  })

  test('preprocessor: #pragma / #error', () => {
    const src = '#pragma once\n#error "boom"\n'
    const out = j.parse(src)
    assert.ok(findKind(out.children[0], 'pragma_directive'))
    assert.ok(findKind(out.children[1], 'error_directive'))
  })

  test('preprocessor: #undef', () => {
    const src = '#define X 1\n#undef X\n'
    const out = j.parse(src)
    assert.equal(findKind(out.children[0], 'define_directive').macroName, 'X')
    assert.equal(findKind(out.children[1], 'undef_directive').macroName, 'X')
  })

  // ---- Parameter lists (slice 8) --------------------------------------

  test('parameters: void prototype', () => {
    const src = 'int main(void);'
    const out = j.parse(src)
    const fp = findKind(out.children[0], 'function_postfix')
    assert.ok(fp)
    const ptl = findKind(fp, 'parameter_type_list')
    assert.ok(ptl)
    const params = ptl.children.filter((c: any) => c.kind === 'parameter_declaration')
    assert.equal(params.length, 1)
  })

  test('parameters: ANSI prototype with named parameters', () => {
    const src = 'int add(int a, int b);'
    const out = j.parse(src)
    const ptl = findKind(out.children[0], 'parameter_type_list')
    const params = ptl.children.filter((c: any) => c.kind === 'parameter_declaration')
    assert.equal(params.length, 2)
    assert.deepEqual(params.map((p: any) => p.declaredName), ['a', 'b'])
  })

  test('parameters: variadic ellipsis', () => {
    const src = 'int printf(const char *fmt, ...);'
    const out = j.parse(src)
    const ptl = findKind(out.children[0], 'parameter_type_list')
    assert.equal(ptl.variadic, true)
    assert.ok(findKind(ptl, 'parameter_variadic'))
  })

  test('parameters: abstract declarators (after typedef registration)', () => {
    // Pre-register size_t so the parser sees `size_t` as a TYPEDEF_NAME
    // and treats it as a parameter type, not a parameter name.
    const src = `
      typedef unsigned long size_t;
      int qsort(void *, size_t, size_t, int (*)(const void *, const void *));
    `
    const out = j.parse(src)
    const decl = out.children.find((c: any) => findKind(c, 'function_postfix'))
    assert.ok(decl, 'expected the qsort declaration')
    const ptl = findKind(decl, 'parameter_type_list')
    // Note: `int (*)(const void *, const void *)` is the *outer*
    // parameter — its inner function_postfix has its own ptl, so we
    // count by direct children only.
    const params = ptl.children.filter((c: any) => c.kind === 'parameter_declaration')
    assert.equal(params.length, 4)
    // None of the four outer parameters should carry a declaredName.
    for (const p of params) {
      assert.equal(p.declaredName, undefined,
        'abstract parameter must not carry a declaredName')
    }
  })

  test('parameters: identifier_list shape detected for K&R prototypes', () => {
    // K&R declaration without body: `int f(a, b);` is a (very old)
    // prototype without specifiers; the parser models it with an
    // identifier_list inside the function_postfix.
    const src = 'int f(a, b);'
    const out = j.parse(src)
    const fp = findKind(out.children[0], 'function_postfix')
    assert.ok(fp)
    assert.ok(findKind(fp, 'identifier_list'))
  })

  // ---- Macro-name tagging (slice 9) -----------------------------------

  test('macro tagging: identifier in #define body becomes MACRO_NAME later', () => {
    const src = '#define MAX 100\nint x = MAX;'
    const out = j.parse(src)
    // The second declaration's `MAX` token must lex as MACRO_NAME.
    const decl = out.children[1]
    const maxTok = findTokenBySrc(decl, 'MAX')
    assert.equal(maxTok?.tname, 'MACRO_NAME')
    // And `x` is still ID.
    assert.equal(findTokenBySrc(decl, 'x')?.tname, 'ID')
  })

  test('macro tagging: function-like macro reference in expression', () => {
    const src = '#define INC(x) ((x)+1)\nint y = INC(5);'
    const out = j.parse(src)
    const decl = out.children[1]
    const incTok = findTokenBySrc(decl, 'INC')
    assert.equal(incTok?.tname, 'MACRO_NAME')
  })

  test('macro tagging: undef removes the macro name', () => {
    const src = '#define X 1\nint a = X;\n#undef X\nint b = X;'
    const out = j.parse(src)
    // Before undef, X is MACRO_NAME.
    assert.equal(findTokenBySrc(out.children[1], 'X')?.tname, 'MACRO_NAME')
    // After undef, X is back to plain ID.
    assert.equal(findTokenBySrc(out.children[3], 'X')?.tname, 'ID')
  })

  // ---- Call-expression structuring (slice 10) -------------------------

  test('calls: simple function call wraps as call_expression', () => {
    const src = 'void g(void) { f(1, 2); }'
    const out = j.parse(src)
    const expr = findKind(out.children[0], 'expression_statement')
    const call = findKind(expr, 'call_expression')
    assert.ok(call)
    assert.equal(call.callee, 'f')
    assert.equal(call.isMacro, false)
    assert.ok(findKind(call, 'argument_list'))
  })

  test('calls: macro invocation tagged isMacro', () => {
    const src = '#define INC(x) ((x)+1)\nvoid g(void) { int y = INC(5); }'
    const out = j.parse(src)
    // The macro invocation lives inside an init_declarator's initializer.
    const init = findKind(out.children[1], 'initializer')
    const call = findKind(init, 'call_expression')
    assert.ok(call)
    assert.equal(call.callee, 'INC')
    assert.equal(call.isMacro, true)
  })

  test('calls: nested function call recursively structured', () => {
    const src = 'void g(void) { return f(g(1), h(2)); }'
    const out = j.parse(src)
    const ret = findKind(out.children[0], 'jump_statement')
    const outerCall = findKind(ret, 'call_expression')
    assert.equal(outerCall.callee, 'f')
    // Two nested call_expressions inside outerCall.
    const inner: any[] = []
    const visit = (n: any) => {
      if (!n) return
      if (n.kind === 'call_expression' && n !== outerCall) inner.push(n)
      if (Array.isArray(n.children)) for (const c of n.children) visit(c)
    }
    visit(outerCall)
    assert.deepEqual(inner.map((c) => c.callee).sort(), ['g', 'h'])
  })

  // ---- Conditional groups (slice 11) ----------------------------------

  test('conditional_group: if/elif/else/endif with three branches', () => {
    const src = `
      #if FOO
      int a;
      #elif BAR
      int b;
      #else
      int c;
      #endif
    `
    const out = j.parse(src)
    assert.equal(out.children.length, 1)
    const grp = out.children[0]
    assert.equal(grp.kind, 'conditional_group')
    assert.deepEqual(
      grp.branches.map((b: any) => b.branchKind),
      ['if', 'elif', 'else'],
    )
    // Each branch's body has exactly one external declaration.
    assert.deepEqual(
      grp.branches.map((b: any) => b.body.length),
      [1, 1, 1],
    )
  })

  test('conditional_group: nested #if inside a branch', () => {
    const src = `
      #ifdef OUTER
      int a;
      #ifdef INNER
      int b;
      #endif
      int c;
      #endif
    `
    const out = j.parse(src)
    const outer = out.children[0]
    assert.equal(outer.kind, 'conditional_group')
    const inner = outer.branches[0].body.find(
      (c: any) => c.kind === 'conditional_group',
    )
    assert.ok(inner, 'expected nested conditional_group')
    assert.deepEqual(
      inner.branches.map((b: any) => b.branchKind),
      ['ifdef'],
    )
  })

  test('conditional_group: best-effort leaves stray #endif flat', () => {
    const src = `
      int x;
      #endif
      int y;
    `
    const out = j.parse(src)
    // No matching #if, so the #endif stays as its own external_declaration.
    const kinds = out.children.map((c: any) => {
      const dir = c.children?.find((x: any) => x.kind === 'conditional_directive')
      return dir ? `dir:${dir.directive}` : c.declKind
    })
    assert.deepEqual(kinds, ['declaration', 'dir:endif', 'declaration'])
  })

  // ---- Expression precedence (slice 12) -------------------------------

  test('expr: precedence 1 + 2 * 3 binds * tighter', () => {
    const src = 'void g(void) { int r = 1 + 2 * 3; }'
    const out = j.parse(src)
    const init = findKind(out.children[0], 'initializer')
    const top = init.children.find((c: any) => c.kind === 'binary_expression')
    assert.equal(top.op, '+')
    // The right-hand side of + should be `2 * 3`, also a binary_expression.
    assert.equal(top.right.kind, 'binary_expression')
    assert.equal(top.right.op, '*')
  })

  test('expr: assignment is right-associative', () => {
    const src = 'void g(void) { a = b = c; }'
    const out = j.parse(src)
    const stmt = findKind(out.children[0], 'expression_statement')
    const ax = stmt.children.find((c: any) => c.kind === 'assignment_expression')
    assert.equal(ax.op, '=')
    // RHS is itself an assignment_expression (right-assoc).
    assert.equal(ax.right.kind, 'assignment_expression')
    assert.equal(ax.right.op, '=')
  })

  test('expr: ternary expression structured as conditional_expression', () => {
    const src = 'void g(int x) { int y = x > 0 ? 1 : -1; }'
    const out = j.parse(src)
    const init = findKind(out.children[0], 'initializer')
    const cond = init.children.find((c: any) => c.kind === 'conditional_expression')
    assert.ok(cond)
    assert.equal(cond.cond.kind, 'binary_expression')
    assert.equal(cond.cond.op, '>')
  })

  test('expr: postfix subscript and member access', () => {
    const src = 'void g(void) { x = a[i].field->next; }'
    const out = j.parse(src)
    const stmt = findKind(out.children[0], 'expression_statement')
    const asn = stmt.children.find((c: any) => c.kind === 'assignment_expression')
    // RHS is a member_expression (->) whose object is another
    // member_expression (.) whose object is a subscript_expression.
    const rhs = asn.right
    assert.equal(rhs.kind, 'member_expression')
    assert.equal(rhs.op, '->')
    assert.equal(rhs.memberName, 'next')
    assert.equal(rhs.object.kind, 'member_expression')
    assert.equal(rhs.object.op, '.')
    assert.equal(rhs.object.memberName, 'field')
    assert.equal(rhs.object.object.kind, 'subscript_expression')
  })

  test('expr: prefix unary -x and !y and *p', () => {
    const src = 'void g(void) { int a = -x; int b = !y; int c = *p; }'
    const out = j.parse(src)
    const cs = findKind(out.children[0], 'compound_statement')
    const decls = cs.children.filter((c: any) => c.kind === 'declaration')
    const ops = decls.map((d: any) =>
      findKind(d, 'unary_expression')?.op,
    )
    assert.deepEqual(ops, ['-', '!', '*'])
  })

  test('expr: cast expression detected when paren head is a typedef-name', () => {
    const src = 'typedef int T; void g(void) { int x = (T) y; }'
    const out = j.parse(src)
    // Find the inner function's declaration, then the cast inside its
    // initializer.
    const fn = out.children.find((c: any) => c.declKind === 'function_definition')
    const cast = findKind(fn, 'cast_expression')
    assert.ok(cast, 'expected a cast_expression')
    assert.ok(cast.typeName)
    assert.equal(cast.operand.kind, 'identifier_expression')
    assert.equal(cast.operand.name, 'y')
  })

  test('expr: sizeof on an expression', () => {
    const src = 'void g(void) { int n = sizeof x; }'
    const out = j.parse(src)
    const u = findKind(out.children[0], 'unary_expression')
    assert.equal(u.op, 'sizeof')
    assert.equal(u.operand.kind, 'identifier_expression')
  })

  test('expr: sizeof on a type-name', () => {
    const src = 'void g(void) { int n = sizeof(int); }'
    const out = j.parse(src)
    const u = findKind(out.children[0], 'unary_expression')
    assert.equal(u.op, 'sizeof')
    // operand is a type_name node.
    assert.equal(u.operand.kind, 'type_name')
  })

  test('expr: adjacent string literals concatenate into one literal_expression', () => {
    const src = 'void g(void) { const char *s = "foo" "bar"; }'
    const out = j.parse(src)
    const lit = findKind(out.children[0], 'literal_expression')
    assert.equal(lit.literalKind, 'LIT_STRING')
    const stringTokens = lit.children.filter(
      (c: any) => c.kind === 'token' && c.tname === 'LIT_STRING',
    )
    assert.equal(stringTokens.length, 2)
  })

  // ---- End-to-end smoke (slice 13) ------------------------------------

  test('e2e: a small header file shape parses cleanly', () => {
    const src = `
      /* Tiny types module — shape similar to a real stdint.h. */
      #ifndef TINY_STDINT_H
      #define TINY_STDINT_H 1

      #include <stddef.h>

      typedef signed char        int8_t;
      typedef unsigned char      uint8_t;
      typedef signed short       int16_t;
      typedef unsigned short     uint16_t;
      typedef signed int         int32_t;
      typedef unsigned int       uint32_t;
      typedef signed long long   int64_t;
      typedef unsigned long long uint64_t;

      #define INT8_MIN  (-127 - 1)
      #define INT8_MAX  (127)
      #define UINT8_MAX (255U)

      typedef struct vec {
        int32_t  x;
        int32_t  y;
        int32_t  z;
      } vec_t;

      vec_t vec_add(vec_t a, vec_t b);
      int   vec_dot(const vec_t *a, const vec_t *b);

      enum status : int {
        STATUS_OK    = 0,
        STATUS_ERROR = 1,
      };

      #endif /* TINY_STDINT_H */
    `
    const out = j.parse(src)
    assert.equal(out.kind, 'translation_unit')

    // Outermost child: the conditional_group (one big #ifndef … #endif).
    assert.equal(out.children.length, 1)
    const grp = out.children[0]
    assert.equal(grp.kind, 'conditional_group')
    assert.equal(grp.branches.length, 1)
    assert.equal(grp.branches[0].branchKind, 'ifndef')

    const body = grp.branches[0].body
    // Inside the branch we expect: define, include, 8 typedefs, 3
    // defines, struct typedef, two function prototypes, enum.
    const decls = body.filter((c: any) => c.kind === 'external_declaration')
    assert.ok(decls.length >= 14, `got ${decls.length} body declarations`)

    // Every typedef name should be registered.
    for (const name of [
      'int8_t', 'uint8_t', 'int16_t', 'uint16_t',
      'int32_t', 'uint32_t', 'int64_t', 'uint64_t', 'vec_t',
    ]) {
      // Use it in a fresh declaration source and ensure it lexes as
      // TYPEDEF_NAME — round-trip through the same parser instance.
      const t = findKindAndPick(grp, 'init_declarator', (n: any) => n.declaredName === name)
      assert.ok(t, `expected typedef declarator for ${name}`)
    }

    // Macros INT8_MIN / INT8_MAX / UINT8_MAX should be in the macro
    // table — find their define_directive nodes.
    const defNames = new Set<string>()
    const visit = (n: any) => {
      if (!n) return
      if (n.kind === 'define_directive') defNames.add(n.macroName)
      if (Array.isArray(n.children)) for (const c of n.children) visit(c)
    }
    visit(grp)
    assert.ok(defNames.has('TINY_STDINT_H'))
    assert.ok(defNames.has('INT8_MIN'))
    assert.ok(defNames.has('INT8_MAX'))
    assert.ok(defNames.has('UINT8_MAX'))

    // The struct vec definition should have three int32_t members.
    const structSpec = findKind(grp, 'struct_specifier')
    assert.equal(structSpec.tagName, 'vec')
    const members = findKind(structSpec, 'member_decl_list')
      .children.filter((c: any) => c.kind === 'struct_declaration')
    assert.equal(members.length, 3)

    // The enum has fixed underlying type `int` and three enumerators.
    const en = findKind(grp, 'enum_specifier')
    assert.equal(en.tagName, 'status')
    const enums = findKind(en, 'enumerator_list')
      .children.filter((c: any) => c.kind === 'enumerator')
    assert.equal(enums.length, 2) // STATUS_OK and STATUS_ERROR; the
                                  // trailing comma after the last
                                  // enumerator does not create a third.
  })

  // ---- Designated initializers + _Static_assert (slice 14) -----------

  test('init: designated initializer with .field designators', () => {
    const src = 'struct S s = { .x = 1, .y = 2, .z = 3 };'
    const out = j.parse(src)
    const il = findKind(out.children[0], 'initializer_list')
    assert.ok(il)
    const items = il.children.filter((c: any) => c.kind === 'initializer_item')
    assert.equal(items.length, 3)
    for (let i = 0; i < items.length; i++) {
      const desig = findKind(items[i], 'designation')
      assert.ok(desig, `expected designation in item ${i}`)
      const md = findKind(desig, 'member_designator')
      assert.equal(md.memberName, ['x', 'y', 'z'][i])
    }
  })

  test('init: designated initializer with [index] designators', () => {
    const src = 'int a[5] = { [0] = 10, [4] = 50 };'
    const out = j.parse(src)
    const il = findKind(out.children[0], 'initializer_list')
    const items = il.children.filter((c: any) => c.kind === 'initializer_item')
    assert.equal(items.length, 2)
    for (const it of items) {
      const desig = findKind(it, 'designation')
      assert.ok(findKind(desig, 'index_designator'))
    }
  })

  test('init: nested initializer_list inside an initializer_item', () => {
    const src = 'int m[2][2] = { { 1, 2 }, { 3, 4 } };'
    const out = j.parse(src)
    const il = findKind(out.children[0], 'initializer_list')
    const items = il.children.filter((c: any) => c.kind === 'initializer_item')
    assert.equal(items.length, 2)
    // Each item's value is an initializer that contains a sub-list.
    for (const it of items) {
      assert.ok(findKind(it.value, 'initializer_list'))
    }
  })

  test('static_assert: condition + message split into fields', () => {
    const src = 'static_assert(sizeof(int) == 4, "expected 32-bit int");'
    const out = j.parse(src)
    const sa = findKind(out.children[0], 'static_assert_declaration')
    assert.ok(sa.condition)
    assert.equal(sa.condition.kind, 'binary_expression')
    assert.equal(sa.condition.op, '==')
    assert.ok(sa.message)
    assert.equal(sa.message.kind, 'literal_expression')
    assert.equal(sa.message.literalKind, 'LIT_STRING')
  })

  test('static_assert: condition only (no message)', () => {
    const src = '_Static_assert(1 + 1 == 2);'
    const out = j.parse(src)
    const sa = findKind(out.children[0], 'static_assert_declaration')
    assert.ok(sa.condition)
    assert.equal(sa.message, undefined)
  })

  test('phase O: top-level static_assert with comma in cond expression', () => {
    // The comma-op suppression should bound the cond and msg vals
    // so a sub-expression's `,` inside e.g. a function call still
    // works. `f(a, b)` inside a cond is a function call where the
    // inner `,` is owned by paren-preval, not comma-op.
    const src = 'static_assert(sizeof(int[2]) == 8, "size");'
    const out = j.parse(src)
    const sa = findKind(out.children[0], 'static_assert_declaration')
    assert.ok(sa.condition)
    assert.equal(sa.condition.kind, 'binary_expression')
    assert.equal(sa.message?.kind, 'literal_expression')
  })

  // ---- Attribute spec contents (slice 16) -----------------------------

  test('attributes: GCC __attribute__ list with names and args', () => {
    const src = '__attribute__((noreturn, format(printf, 1, 2), nonnull(1, 2))) void die(const char *fmt, ...);'
    const out = j.parse(src)
    const at = findKind(out.children[0], 'attribute_spec')
    assert.ok(at)
    assert.equal(at.attributeForm, 'gcc')
    assert.equal(at.items.length, 3)
    assert.deepEqual(
      at.items.map((i: any) => i.attributeName),
      ['noreturn', 'format', 'nonnull'],
    )
    // noreturn has no argument list.
    assert.equal(at.items[0].argumentList, undefined)
    // format(printf, 1, 2): three arguments.
    const fmtArgs = at.items[1].argumentList
    assert.ok(fmtArgs)
    const fmtArgChildren = fmtArgs.children.filter(
      (c: any) => c.kind === 'identifier_expression' || c.kind === 'literal_expression',
    )
    assert.equal(fmtArgChildren.length, 3)
  })

  test('attributes: MSVC __declspec single parens', () => {
    const src = '__declspec(dllexport) void f(void);'
    const out = j.parse(src)
    const at = findKind(out.children[0], 'attribute_spec')
    assert.equal(at.attributeForm, 'msvc')
    assert.equal(at.items.length, 1)
    assert.equal(at.items[0].attributeName, 'dllexport')
  })

  // ---- GCC __asm__ statement structuring (slice 17) -------------------

  test('asm: template only (no operands)', () => {
    const src = 'void f(void) { __asm__("nop"); }'
    const out = j.parse(src)
    const a = findKind(out.children[0], 'asm_statement')
    assert.ok(a)
    assert.deepEqual(a.qualifiers, [])
    assert.ok(a.template)
    // template's wrapped expression is a literal_expression (string).
    assert.equal(a.template.expression.kind, 'literal_expression')
    assert.equal(a.template.expression.literalKind, 'LIT_STRING')
    // No operand sections.
    assert.equal(a.asm_outputs, undefined)
  })

  test('asm: full extended form with outputs/inputs/clobbers', () => {
    const src = `
      int add(int a, int b) {
        int r;
        __asm__ volatile (
          "addl %2, %0"
          : "=r" (r)
          : "0" (a), "r" (b)
          : "cc"
        );
        return r;
      }
    `
    const out = j.parse(src)
    const a = findKind(out.children[0], 'asm_statement')
    assert.ok(a)
    assert.deepEqual(a.qualifiers, ['volatile'])
    assert.ok(a.template)
    // outputs
    const outputs = a.asm_outputs
    assert.ok(outputs)
    const outOps = outputs.children.filter((c: any) => c.kind === 'asm_operand')
    assert.equal(outOps.length, 1)
    assert.equal(outOps[0].constraint.value, '"=r"')
    assert.equal(outOps[0].value.expression.kind, 'identifier_expression')
    assert.equal(outOps[0].value.expression.name, 'r')
    // inputs (two operands)
    const inputs = a.asm_inputs
    assert.ok(inputs)
    const inOps = inputs.children.filter((c: any) => c.kind === 'asm_operand')
    assert.equal(inOps.length, 2)
    // clobbers
    const clobbers = a.asm_clobbers
    assert.ok(clobbers)
    const cl = clobbers.children.filter((c: any) => c.kind === 'asm_clobber')
    assert.equal(cl.length, 1)
    assert.equal(cl[0].value, '"cc"')
  })

  test('asm: goto qualifier with labels section', () => {
    const src = `
      void f(void) {
        __asm__ goto ("jmp %l[done]" : : : : done);
      done:
        return;
      }
    `
    const out = j.parse(src)
    const a = findKind(out.children[0], 'asm_statement')
    assert.deepEqual(a.qualifiers, ['goto'])
    assert.ok(a.asm_labels)
    const labels = a.asm_labels.children.filter((c: any) => c.kind === 'asm_label_ref')
    assert.equal(labels.length, 1)
    assert.equal(labels[0].labelName, 'done')
  })

  // ---- for_controls 3-way split (slice 19) ----------------------------

  test('for: init declaration / cond / iter all structured', () => {
    const src = 'void g(void) { for (int i = 0; i < 10; i++) ; }'
    const out = j.parse(src)
    const fs = findKind(out.children[0], 'for_statement')
    const ctl = findKind(fs, 'for_controls')
    assert.ok(ctl)
    // init slot has a declaration with declared name 'i'.
    assert.ok(ctl.init)
    assert.equal(ctl.init.value.kind, 'declaration')
    assert.equal(findKind(ctl.init, 'init_declarator').declaredName, 'i')
    // cond slot has a binary_expression i < 10.
    assert.ok(ctl.cond.value)
    assert.equal(ctl.cond.value.kind, 'binary_expression')
    assert.equal(ctl.cond.value.op, '<')
    // iter slot has a postfix_unary_expression i++.
    assert.ok(ctl.iter.value)
    assert.equal(ctl.iter.value.kind, 'postfix_unary_expression')
    assert.equal(ctl.iter.value.op, '++')
  })

  test('for: init expression form', () => {
    const src = 'void g(void) { int i; for (i = 0; i < 10; i++) ; }'
    const out = j.parse(src)
    const fs = findKind(out.children[0], 'for_statement')
    const ctl = findKind(fs, 'for_controls')
    // init is an expression (assignment_expression), not a declaration.
    assert.ok(ctl.init.value)
    assert.equal(ctl.init.value.kind, 'assignment_expression')
    assert.equal(ctl.init.value.op, '=')
  })

  test('for: empty controls (for(;;))', () => {
    const src = 'void g(void) { for (;;) break; }'
    const out = j.parse(src)
    const fs = findKind(out.children[0], 'for_statement')
    const ctl = findKind(fs, 'for_controls')
    // All three slots present but each has no value.
    assert.ok(ctl.init)
    assert.equal(ctl.init.value, undefined)
    assert.ok(ctl.cond)
    assert.equal(ctl.cond.value, undefined)
    assert.ok(ctl.iter)
    assert.equal(ctl.iter.value, undefined)
  })

  test('asm: operand with [asm-name] prefix', () => {
    const src = `
      void f(int x) {
        int r;
        __asm__("movl %[in], %[out]"
                : [out] "=r" (r)
                : [in]  "r"  (x));
      }
    `
    const out = j.parse(src)
    const a = findKind(out.children[0], 'asm_statement')
    const outOps = a.asm_outputs.children.filter((c: any) => c.kind === 'asm_operand')
    assert.ok(outOps[0].asmName)
    assert.equal(outOps[0].constraint.value, '"=r"')
  })

  test('attributes: C23 [[nodiscard]] on a function declaration', () => {
    const src = '[[nodiscard]] int compute(int n);'
    const out = j.parse(src)
    const at = findKind(out.children[0], 'attribute_spec')
    assert.ok(at)
    assert.equal(at.attributeForm, 'c23')
    assert.equal(at.items.length, 1)
    assert.equal(at.items[0].attributeName, 'nodiscard')
  })

  test('attributes: C23 namespaced [[gnu::pure]]', () => {
    const src = '[[gnu::pure]] int g(int n);'
    const out = j.parse(src)
    const at = findKind(out.children[0], 'attribute_spec')
    assert.equal(at.attributeForm, 'c23')
    assert.equal(at.items.length, 1)
    assert.equal(at.items[0].attributePrefix, 'gnu')
    assert.equal(at.items[0].attributeName, 'pure')
  })

  test('attributes: C23 [[deprecated("reason")]] with argument list', () => {
    const src = '[[deprecated("use g instead")]] int old(void);'
    const out = j.parse(src)
    const at = findKind(out.children[0], 'attribute_spec')
    assert.equal(at.items.length, 1)
    assert.equal(at.items[0].attributeName, 'deprecated')
    assert.ok(at.items[0].argumentList)
    const argLits = at.items[0].argumentList.children.filter(
      (c: any) => c.kind === 'literal_expression',
    )
    assert.equal(argLits.length, 1)
    assert.equal(argLits[0].literalKind, 'LIT_STRING')
  })

  test('attributes: C23 [[…]] on enumerator', () => {
    const src = 'enum E { A [[deprecated]] = 1, B };'
    const out = j.parse(src)
    const en = findKind(out.children[0], 'enum_specifier')
    const enums = findKind(en, 'enumerator_list')
      .children.filter((c: any) => c.kind === 'enumerator')
    const a = enums[0]
    const at = findKind(a, 'attribute_spec')
    assert.ok(at)
    assert.equal(at.attributeForm, 'c23')
    assert.equal(at.items[0].attributeName, 'deprecated')
  })

  test('attributes: const-keyword name accepted (e.g. __attribute__((const)))', () => {
    const src = '__attribute__((const)) int f(int);'
    const out = j.parse(src)
    const at = findKind(out.children[0], 'attribute_spec')
    assert.equal(at.items.length, 1)
    assert.equal(at.items[0].attributeName, 'const')
  })

  test('_Generic: controlling expression and three associations', () => {
    const src = `
      void g(int x) {
        int r = _Generic(x,
          int:    1,
          double: 2,
          default: 0
        );
      }
    `
    const out = j.parse(src)
    const gs = findKind(out.children[0], 'generic_selection')
    assert.ok(gs)
    assert.ok(gs.controlling)
    assert.equal(gs.controlling.expression.kind, 'identifier_expression')
    assert.equal(gs.controlling.expression.name, 'x')
    assert.equal(gs.associations.length, 3)
    assert.deepEqual(
      gs.associations.map((a: any) => a.associationKind),
      ['type', 'type', 'default'],
    )
    // Each value is structured (not opaque tokens).
    for (const a of gs.associations) {
      assert.ok(a.value)
      assert.equal(a.value.kind, 'literal_expression')
    }
  })

  test('e2e: a small .c source with function definitions parses cleanly', () => {
    const src = `
      #include "vec.h"

      static int sign(int x) {
        if (x > 0) return  1;
        if (x < 0) return -1;
        return 0;
      }

      vec_t vec_add(vec_t a, vec_t b) {
        vec_t r;
        r.x = a.x + b.x;
        r.y = a.y + b.y;
        r.z = a.z + b.z;
        return r;
      }

      int vec_dot(const vec_t *a, const vec_t *b) {
        return a->x * b->x + a->y * b->y + a->z * b->z;
      }
    `
    // Pre-register vec_t as a typedef so the parameters parse as
    // typed (not as identifier names).
    // The parser does this via a typedef directive in the actual .h
    // file; for this synthetic test we inject it inline.
    const j2 = (new Tabnas().use(jsonic).use(C, { extended: true }) as any)
    const out = j2.parse(`typedef struct { int x; int y; int z; } vec_t;\n${src}`)
    // After the synthetic typedef, our source begins with #include then
    // three function definitions.
    const fns = out.children.filter(
      (c: any) => c.declKind === 'function_definition',
    )
    assert.equal(fns.length, 3)
    const fnNames = fns.map((f: any) => {
      const decl = findKind(f, 'declarator')
      return decl?.declaredName
    })
    assert.deepEqual(fnNames, ['sign', 'vec_add', 'vec_dot'])

    // sign() body has two if-statements and a return.
    const signBody = findKind(fns[0], 'compound_statement')
    const ifs = signBody.children.filter((c: any) => c.kind === 'if_statement')
    assert.equal(ifs.length, 2)
    const rets = signBody.children.filter(
      (c: any) => c.kind === 'jump_statement' && c.jumpKind === 'return',
    )
    assert.equal(rets.length, 1)

    // vec_dot() body has one return whose expression is a chain of +.
    const dotBody = findKind(fns[2], 'compound_statement')
    const dotRet = dotBody.children.find((c: any) => c.kind === 'jump_statement')
    const topPlus = dotRet.children.find((c: any) => c.kind === 'binary_expression')
    assert.equal(topPlus.op, '+')
  })

})

// ---- Path-dispatch spec (test/spec/path-dispatch.tsv) ----
//
// Data-driven assertion that each catalogued shape flows through
// the expected path (grammar | legacy | legacy-unknown). Catches
// silent reroutes between paths — useful when @looks-simple-decl
// is extended (e.g. wider lookahead) and a shape that used to
// flow through legacy now hits a latent grammar bug, or vice
// versa. Both paths emit identical CST shapes; the marker is set
// by @finalize-new-path / finalizeExternalDeclaration.

interface PathSpec {
  src: string
  path: string
  declKind: string
  declIdx: number
  notes: string
  line: number
}

function loadPathSpec(): PathSpec[] {
  // Test runs with cwd = project root. The spec lives at
  // test/spec/path-dispatch.tsv.
  const tsvPath = join(process.cwd(), 'test', 'spec', 'path-dispatch.tsv')
  const text = readFileSync(tsvPath, 'utf8')
  const rows: PathSpec[] = []
  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    if (!raw) continue
    if (raw.startsWith('#')) continue
    const cols = raw.split('\t')
    if (cols.length < 3) {
      throw new Error(
        `path-dispatch.tsv:${i + 1}: expected 3+ tab-separated cols, got ${cols.length}: ${JSON.stringify(raw)}`,
      )
    }
    const [src, path, declKind, col4, col5] = cols
    // Column 4 is declIdx if it parses as an integer, else it's
    // notes. Column 5 (when present) is always notes. This keeps
    // most rows at 3 columns and only opt in to declIdx when a
    // source produces multiple external_declarations.
    let declIdx = 0
    let notes = ''
    if (col4 != null && /^\d+$/.test(col4)) {
      declIdx = parseInt(col4, 10)
      notes = col5 || ''
    } else {
      notes = col4 || ''
    }
    rows.push({ src, path, declKind, declIdx, notes, line: i + 1 })
  }
  return rows
}

describe('path-dispatch spec', () => {
  const rows = loadPathSpec()

  for (const row of rows) {
    const tag = row.notes
      ? `${row.path}: ${row.src}  (${row.notes})`
      : `${row.path}: ${row.src}`
    test(tag, () => {
      // path-dispatch rows include extension shapes (preprocessor,
      // GCC __attribute__, asm). Construct the parser with extensions
      // enabled so those rows assert the correct dispatch path.
      const parser = new Tabnas().use(jsonic).use(C, { extended: true })
      const out = parser.parse(row.src)
      const decls = (out.children || []).filter(
        (c: any) => c.kind === 'external_declaration',
      )
      assert.ok(
        decls.length > row.declIdx,
        `path-dispatch.tsv:${row.line}: source produced ${decls.length} external_declaration(s), declIdx=${row.declIdx} out of range`,
      )
      const decl = decls[row.declIdx]
      assert.equal(
        decl.viaPath,
        row.path,
        `path-dispatch.tsv:${row.line}: viaPath mismatch for ${JSON.stringify(row.src)}`,
      )
      assert.equal(
        decl.declKind,
        row.declKind,
        `path-dispatch.tsv:${row.line}: declKind mismatch for ${JSON.stringify(row.src)}`,
      )
    })
  }
})

// Search for a node where `match(n)` is true.
function findKindAndPick(root: any, kind: string, match: (n: any) => boolean): any {
  if (!root) return null
  if (root.kind === kind && match(root)) return root
  if (Array.isArray(root.children)) {
    for (const c of root.children) {
      const hit = findKindAndPick(c, kind, match)
      if (hit) return hit
    }
  }
  return null
}
