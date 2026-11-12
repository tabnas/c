/* Copyright (c) 2026 Richard Rodger and contributors, MIT License */

// The armed fallback: how an external declaration the rules cannot parse
// becomes an unknown declaration, where the parser up to 0.5 handed it to
// a structurer that took any token run.
//
// `external_declaration` dispatches on its head (c-grammar.jsonic). A
// route the parser has always held to the rules is strict: a declaration
// the rules cannot parse there is refused. Every other route is armed. An
// armed declaration is the token run the 0.5 parser's chomp absorbed, and
// that run ends where the chomp ended it: after a `;` at brace depth 0,
// after the newline that ends a `#` line, after a `}` back to depth 0
// when the next token starts a declaration (`startsNewDeclaration`), or
// at the end. Inside it:
//
// - every rule below `external_declaration` has a last alternate, in each
//   state, that marks the declaration failed where no other alternate
//   matches (the catch-all), and a first one that, once it is failed,
//   ends the state without taking a token (the bail). The rules close
//   down to `external_declaration`, whose close turns the declaration
//   into an unknown one: the tokens since its first, flat, and the rest
//   of the run up to the chomp's end (`unknown_declaration`).
// - every alternate that takes a token is held back once the tokens taken
//   reach the chomp's end (the fence), so the rules end there or fail
//   there; and a declaration the rules end before the chomp's end takes
//   the rest of the run, flat, after what the rules built.
//
// So an armed declaration is accepted whatever it holds, as the
// structurer accepted it, and the next declaration starts where it
// started. Nothing is rewound and nothing probes: the plugin records the
// tokens it lexes (the sub-lex hook in c.ts) and trims the record at each
// declaration's start, and the engine's count of the tokens taken
// (`ctx.vAbs`) says how many of them the declaration holds.

import type { Rule, Context, Token } from '@tabnas/parser'
import type { CMeta } from './symbols.js'

// The state of the external declaration being parsed.
export interface ExtDecl {
  // The route is armed (above), not strict.
  armed: boolean
  // An armed declaration the rules failed on: every state bails.
  failed: boolean
  // The declaration is an unknown one: its children are its tokens.
  unknown: boolean
  // The rules ended an armed declaration before the chomp's end: the
  // rest of the run follows what they built, flat.
  trailing: boolean
  // The chomp's state over the tokens taken so far.
  scanned: number
  depth: number
  terminated: boolean
  justClosed: boolean
  first: string | undefined
  // A JavaScript error a ref threw in an armed declaration, which failed
  // it (the declaration is then unknown, as the structurer's would be).
  crashed?: unknown
  // The open local scopes, innermost last: a rule that catches a failure
  // below it and reads the rest of its tokens flat, as 0.5's rules did
  // (asm_operand). A failure inside one fails the scope, not the
  // declaration.
  locals: LocalScope[]
}

export interface LocalScope {
  vAbs: number
  failed: boolean
}

export function newExtDecl(): ExtDecl {
  return {
    armed: false, failed: false, unknown: false, trailing: false,
    scanned: 0, depth: 0, terminated: false, justClosed: false,
    first: undefined, locals: [],
  }
}

// Open a local scope at the tokens taken so far.
export function openLocal(ctx: Context): LocalScope | undefined {
  const ed = edOf(ctx)
  if (!ed) return undefined
  const scope = { vAbs: (ctx as any).vAbs, failed: false }
  ed.locals.push(scope)
  return scope
}

// Close a local scope (and any left open inside it).
export function closeLocal(ctx: Context, scope: LocalScope | undefined): void {
  const ed = edOf(ctx)
  if (!ed || !scope) return
  const i = ed.locals.lastIndexOf(scope)
  if (i >= 0) ed.locals.length = i
}

// The tokens taken since a count of tokens taken.
export function tokensSince(ctx: Context, vAbs: number): Token[] {
  const m = cmetaOf(ctx)
  if (!m || !m.rec) return []
  const base = m.recBase as number
  return m.rec.slice(Math.max(0, vAbs - base), (ctx as any).vAbs - base)
}

// The depth of `(` and `[` a run of tokens leaves open.
export function bracketDepth(tokens: Token[]): number {
  let d = 0
  for (const t of tokens) {
    const n = (t as any).name
    if (n === 'PUNC_LPAREN' || n === 'PUNC_LBRACKET') d++
    else if (n === 'PUNC_RPAREN' || n === 'PUNC_RBRACKET') d--
  }
  return d
}

function innermost(ed: ExtDecl): LocalScope | undefined {
  return ed.locals[ed.locals.length - 1]
}

export function cmetaOf(ctx: Context): CMeta | undefined {
  return ctx && ctx.meta ? (ctx.meta as any).cmeta : undefined
}

export function edOf(ctx: Context): ExtDecl | undefined {
  const m = cmetaOf(ctx)
  return m ? m.ed : undefined
}

// Record a token the lexer gave the parser. Called from the sub-lex hook
// for every token that is not trivia; the engine takes them in the order
// they are lexed.
export function recordToken(m: CMeta, tkn: Token): void {
  if (!m.rec) { m.rec = []; m.recBase = 0 }
  const rec = m.rec
  // A re-announced token (the engine's relex undo) replaces the last.
  const last = rec[rec.length - 1] as any
  if (last && last.sI === (tkn as any).sI) { rec[rec.length - 1] = tkn; return }
  rec.push(tkn)
}

// Start an external declaration: drop the record's tokens the previous
// ones took, and reset the state.
export function startDeclaration(m: CMeta, ctx: Context): ExtDecl {
  if (!m.rec) { m.rec = []; m.recBase = 0 }
  const taken = (ctx as any).vAbs - (m.recBase as number)
  if (taken > 0) m.rec = m.rec.slice(taken)
  m.recBase = (ctx as any).vAbs
  m.ed = newExtDecl()
  return m.ed
}

// The tokens the declaration has taken, in order.
export function takenTokens(m: CMeta, ctx: Context): Token[] {
  const n = (ctx as any).vAbs - (m.recBase as number)
  return (m.rec || []).slice(0, Math.max(0, n))
}

// Bring the chomp's state up to the tokens taken.
function chompSync(m: CMeta, ed: ExtDecl, ctx: Context): number {
  const n = (ctx as any).vAbs - (m.recBase as number)
  const rec = m.rec || []
  for (let i = ed.scanned; i < n && i < rec.length; i++) {
    const name = (rec[i] as any).name
    if (i === 0) ed.first = name
    ed.justClosed = false
    if (name === 'PUNC_LBRACE') ed.depth++
    else if (name === 'PUNC_RBRACE') {
      ed.depth--
      if (ed.depth <= 0) ed.justClosed = true
    }
    else if (name === 'PUNC_SEMI' && ed.depth === 0) ed.terminated = true
    else if (name === 'PP_NEWLINE' && ed.depth === 0 && ed.first === 'PP_HASH') {
      ed.terminated = true
    }
  }
  ed.scanned = Math.max(ed.scanned, Math.min(n, rec.length))
  return n
}

// True when the chomp would end the declaration after the tokens taken,
// given the next token (ctx.t[0], which the caller has fetched).
export function chompEnded(ctx: Context): boolean {
  const m = cmetaOf(ctx)
  const ed = m && m.ed
  if (!m || !ed) return false
  const n = chompSync(m, ed, ctx)
  if (n <= 0) return false
  if (ed.terminated) return true
  return ed.justClosed && startsNewDeclaration(ctx)
}

// The fence: an armed declaration that has reached the chomp's end takes
// no more tokens.
export function fenced(ctx: Context): boolean {
  const ed = edOf(ctx)
  if (!ed || !ed.armed || ed.failed) return false
  return chompEnded(ctx)
}

// Token-name sets of the chomp's own test (`startsNewDeclaration`),
// unchanged from 0.5.
const STORAGE_CLASS = new Set<string>([
  'KW_TYPEDEF', 'KW_EXTERN', 'KW_STATIC', 'KW_AUTO', 'KW_REGISTER',
  'KW__THREAD_LOCAL', 'KW_THREAD_LOCAL', 'KW_CONSTEXPR',
  'KW___THREAD',
])
const TYPE_SPEC_KEYWORD = new Set<string>([
  'KW_VOID', 'KW_CHAR', 'KW_SHORT', 'KW_INT', 'KW_LONG', 'KW_FLOAT',
  'KW_DOUBLE', 'KW_SIGNED', 'KW_UNSIGNED', 'KW_BOOL', 'KW__BOOL',
  'KW__COMPLEX', 'KW__IMAGINARY',
  'KW___SIGNED__', 'KW___SIGNED',
  'KW___INT8', 'KW___INT16', 'KW___INT32', 'KW___INT64',
  'KW_STRUCT', 'KW_UNION', 'KW_ENUM',
  'KW_TYPEOF', 'KW_TYPEOF_UNQUAL',
  'KW___TYPEOF__', 'KW___TYPEOF',
  'KW__BITINT',
])
const TYPE_QUALIFIER = new Set<string>([
  'KW_CONST', 'KW_VOLATILE', 'KW_RESTRICT', 'KW__ATOMIC',
  'KW___CONST__', 'KW___CONST',
  'KW___VOLATILE__', 'KW___VOLATILE',
  'KW___RESTRICT__', 'KW___RESTRICT',
])
const FUNCTION_SPECIFIER = new Set<string>([
  'KW_INLINE', 'KW___INLINE__', 'KW___INLINE',
  'KW__NORETURN',
])

// True when the next token is one that starts an external declaration.
// The chomp asked this after a `}` back to depth 0, to tell a function
// body's end from a struct body's.
export function startsNewDeclaration(ctx: Context): boolean {
  let i = 0
  while (i < ctx.t.length) {
    const tkn = ctx.t[i] as any
    if (!tkn) break
    const n = tkn.name
    if (n === '#SP' || n === '#LN' || n === '#CM' ||
        n === 'TRIVIA_LINE_COMMENT' || n === 'TRIVIA_BLOCK_COMMENT' ||
        n === 'TRIVIA_LINE_CONT') { i++; continue }
    if (n === '#ZZ') return true
    if (n === 'PP_HASH') return true
    if (n === 'PUNC_HASH') return true
    if (STORAGE_CLASS.has(n)) return true
    if (TYPE_SPEC_KEYWORD.has(n)) return true
    if (TYPE_QUALIFIER.has(n)) return true
    if (FUNCTION_SPECIFIER.has(n)) return true
    if (n === 'KW___ATTRIBUTE__' || n === 'KW___ATTRIBUTE') return true
    if (n === 'KW___DECLSPEC') return true
    if (n === 'KW___EXTENSION__') return true
    if (n === 'TYPEDEF_NAME') return true
    return false
  }
  return false
}

// The rules above the fallback: they are not given the bail and the
// catch-all, and their refs are not wrapped.
const ABOVE = new Set<string>([
  'translation_unit', 'extdecl_loop', 'conditional_group',
  'conditional_branch', 'external_declaration', 'unknown_declaration',
])

function tokenCount(s: any): number {
  if (Array.isArray(s)) return s.length
  if ('string' === typeof s) return s.split(/\s+/).filter((x) => x).length
  return 0
}

// An alternate takes a token when it matches more tokens than it gives
// back.
function takesToken(alt: any): boolean {
  return tokenCount(alt.s) - ('number' === typeof alt.b ? alt.b : 0) > 0
}

// Give every rule below `external_declaration` the bail and the
// catch-all, put the fence on every alternate that takes a token, and
// wrap the refs the rules use: a lifecycle action does nothing once the
// declaration has failed, and a ref that throws in an armed declaration
// fails it.
export function withFallback(spec: any, refs: Record<string, Function>): void {
  const used = new Set<string>()
  for (const name of Object.keys(spec.rule || {})) {
    if (ABOVE.has(name)) continue
    const rs = spec.rule[name]
    for (const state of ['open', 'close']) {
      const alts = rs[state]
      if (!Array.isArray(alts) || alts.length === 0) continue
      for (const alt of alts) {
        if (!alt || 'object' !== typeof alt) continue
        for (const key of ['a', 'c']) {
          if ('string' === typeof alt[key]) used.add(alt[key])
        }
        if (takesToken(alt)) {
          if ('string' === typeof alt.c) {
            const fencedName = alt.c + '~fenced'
            if (!refs[fencedName]) {
              const cond = alt.c
              refs[fencedName] = (rule: Rule, ctx: Context, out: any) =>
                !fenced(ctx) && refs[cond](rule, ctx, out)
            }
            alt.c = fencedName
          } else if (null == alt.c) {
            alt.c = '@c-unfenced'
          }
        }
      }
      // A rule that catches a failure below it has its catch first, and
      // the bail after it.
      const at = alts[0] && 'string' === typeof alts[0].g &&
        alts[0].g.startsWith('catch-') ? 1 : 0
      alts.splice(at, 0, { c: '@c-bailing', g: 'c-bail' })
      alts.push({ c: '@c-armed', a: '@c-fail', g: 'c-fail' })
    }
    for (const phase of ['bo', 'ao', 'bc', 'ac']) used.add(`@${name}-${phase}`)
  }
  for (const key of used) {
    const fn = refs[key]
    if ('function' !== typeof fn || key.endsWith('~fenced')) continue
    const lifecycle = /-(bo|ao|bc|ac)$/.test(key)
    refs[key] = function (this: any, ...args: any[]) {
      const ctx = args[1] as Context
      const ed = edOf(ctx)
      const sc = ed ? innermost(ed) : undefined
      if (lifecycle && ed && (ed.failed || (sc && sc.failed))) return undefined
      if (!ed || (!ed.armed && !sc)) return fn.apply(this, args)
      try {
        return fn.apply(this, args)
      } catch (err: any) {
        if (err && err.constructor && err.constructor.name === 'TabnasError') throw err
        if (sc) sc.failed = true
        else ed.failed = true
        ed.crashed = err
        return undefined
      }
    }
  }
  Object.assign(refs, {
    '@c-unfenced': (_rule: Rule, ctx: Context): boolean => !fenced(ctx),
    '@c-bailing': (_rule: Rule, ctx: Context): boolean => {
      const ed = edOf(ctx)
      if (!ed) return false
      const sc = innermost(ed)
      return ed.failed || !!(sc && sc.failed)
    },
    '@c-armed': (_rule: Rule, ctx: Context): boolean => {
      const ed = edOf(ctx)
      if (!ed || ed.failed) return false
      const sc = innermost(ed)
      return sc ? !sc.failed : ed.armed
    },
    '@c-fail': (rule: Rule, ctx: Context): void => {
      const ed = edOf(ctx)
      if (ed) {
        const sc = innermost(ed)
        if (sc) sc.failed = true
        else ed.failed = true
      }
      // A diagnostic hook for the conformance tools: where the rules
      // failed, when a caller has asked (globalThis.__cFallbackLog).
      const log = (globalThis as any).__cFallbackLog
      if (Array.isArray(log)) {
        const t = ctx.t[0] as any
        log.push({ rule: rule.name, state: rule.state, tkn: t && t.src,
          tname: t && t.name, row: t && t.rI, col: t && t.cI })
      }
    },
  })
}

// The same for rules a plugin installs below the grammar, whose
// alternates and actions are functions rather than refs: expr's `val`,
// `expr`, `paren` and `ternary`, over which C's expressions are read. Each
// state gets the bail first and the catch-all last; an alternate that
// takes a token gets the fence; an alternate's error hook, in an armed
// declaration, fails it rather than refusing the document; and an
// action, a condition or a lifecycle action that throws in an armed
// declaration fails it, as a ref does.
export function withRuleFallback(tn: any, names: string[]): void {
  const guard = (fn: Function, lifecycle: boolean): Function =>
    function (this: any, ...args: any[]) {
      const ctx = args[1] as Context
      const ed = edOf(ctx)
      const sc = ed ? innermost(ed) : undefined
      if (lifecycle && ed && (ed.failed || (sc && sc.failed))) return undefined
      if (!ed || (!ed.armed && !sc)) return fn.apply(this, args)
      try {
        return fn.apply(this, args)
      } catch (err: any) {
        if (err && err.constructor && err.constructor.name === 'TabnasError') throw err
        if (sc) sc.failed = true
        else ed.failed = true
        ed.crashed = err
        return undefined
      }
    }
  const bailing = (_rule: Rule, ctx: Context): boolean => {
    const ed = edOf(ctx)
    if (!ed) return false
    const sc = innermost(ed)
    return ed.failed || !!(sc && sc.failed)
  }
  const armed = (_rule: Rule, ctx: Context): boolean => {
    const ed = edOf(ctx)
    if (!ed || ed.failed) return false
    const sc = innermost(ed)
    return sc ? !sc.failed : ed.armed
  }
  const fail = (_rule: Rule, ctx: Context): void => {
    const ed = edOf(ctx)
    if (!ed) return
    const sc = innermost(ed)
    if (sc) sc.failed = true
    else ed.failed = true
  }
  for (const name of names) {
    tn.rule(name, (rs: any) => {
      for (const state of ['open', 'close']) {
        const alts: any[] = rs.def[state]
        if (!Array.isArray(alts) || 0 === alts.length) continue
        for (const alt of alts) {
          if (!alt || 'object' !== typeof alt) continue
          for (const key of ['a', 'h']) {
            if ('function' === typeof alt[key]) alt[key] = guard(alt[key], false)
          }
          const cond = 'function' === typeof alt.c ? guard(alt.c, false) : undefined
          const takes = 0 < (alt.sN || 0) - ('number' === typeof alt.b ? alt.b : 0)
          if (takes) {
            alt.c = cond
              ? (rule: Rule, ctx: Context, out: any) => !fenced(ctx) && cond(rule, ctx, out)
              : (_rule: Rule, ctx: Context) => !fenced(ctx)
          } else if (cond) {
            alt.c = cond
          }
          if ('function' === typeof alt.e) {
            const ef = alt.e
            alt.e = (rule: Rule, ctx: Context, out: any) => {
              if (armed(rule, ctx)) { fail(rule, ctx); return undefined }
              return ef(rule, ctx, out)
            }
          }
        }
        rs[state]([{ c: bailing, g: 'c-bail' }], { append: false })
        rs[state]([{ c: armed, a: fail, g: 'c-fail' }], { append: true })
      }
      for (const phase of ['bo', 'ao', 'bc', 'ac']) {
        const acts: any[] = rs.def[phase]
        if (!Array.isArray(acts)) continue
        for (let i = 0; i < acts.length; i++) {
          if ('function' === typeof acts[i]) acts[i] = guard(acts[i], true)
        }
      }
    })
  }
}
