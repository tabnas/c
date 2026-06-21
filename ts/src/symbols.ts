/* Copyright (c) 2026 Richard Rodger and contributors, MIT License */

// Symbol and macro tables used by the C parser to resolve the classic
// identifier/typedef-name disambiguation problem.
//
// Both tables live on Context.meta so lex matchers and rule actions can read
// and mutate the same instance. The identifier-classification matcher
// consults SymbolTable.isTypedef(name) before deciding whether to emit
// ID or TYPEDEF_NAME, and consults MacroTable.has(name) to optionally
// emit MACRO_NAME (which the grammar still treats as ID for syntax but
// tags downstream so call_expr.isMacro can be set).
//
// Scopes form a stack; the parser pushes/pops on:
//   - file               (root, never popped)
//   - function-prototype (function declarator with parameter list)
//   - function-body      (the compound-statement of a function definition)
//   - block              (compound-statement)
//   - struct-or-union    (member declaration list)
//   - enum               (enumerator list)
//   - for-init           (the init clause of a for loop, C99+)
//
// Inner scopes shadow outer ones; lookups walk the stack outward.

export type ScopeKind =
  | 'file'
  | 'fn-proto'
  | 'fn-body'
  | 'block'
  | 'struct-union'
  | 'enum'
  | 'for-init'

export interface Scope {
  kind: ScopeKind
  // Names bound in this scope to their kind. We track typedef-ness primarily;
  // ordinary identifiers (variables, functions, enumerators) are recorded so
  // that an inner non-typedef declaration of the same name correctly hides an
  // outer typedef.
  bind: Map<string, 'typedef' | 'ordinary'>
  // Tags (struct/union/enum names) live in a separate namespace in C.
  tags: Map<string, 'struct' | 'union' | 'enum'>
}

export class SymbolTable {
  private stack: Scope[] = [{
    kind: 'file',
    bind: new Map(),
    tags: new Map(),
  }]

  enter(kind: ScopeKind): void {
    this.stack.push({ kind, bind: new Map(), tags: new Map() })
  }

  exit(): void {
    if (this.stack.length <= 1) return // never pop the file scope
    this.stack.pop()
  }

  depth(): number {
    return this.stack.length
  }

  current(): Scope {
    return this.stack[this.stack.length - 1]
  }

  // True if `name` resolves to a typedef-name in any visible scope, with
  // the innermost binding winning.
  isTypedef(name: string): boolean {
    for (let i = this.stack.length - 1; i >= 0; i--) {
      const b = this.stack[i].bind.get(name)
      if (b !== undefined) return b === 'typedef'
    }
    return false
  }

  // True if `name` is bound at all (typedef or ordinary).
  isBound(name: string): boolean {
    for (let i = this.stack.length - 1; i >= 0; i--) {
      if (this.stack[i].bind.has(name)) return true
    }
    return false
  }

  bindTypedef(name: string): void {
    this.current().bind.set(name, 'typedef')
  }

  bindOrdinary(name: string): void {
    this.current().bind.set(name, 'ordinary')
  }

  bindTag(name: string, kind: 'struct' | 'union' | 'enum'): void {
    this.current().tags.set(name, kind)
  }

  hasTag(name: string): boolean {
    for (let i = this.stack.length - 1; i >= 0; i--) {
      if (this.stack[i].tags.has(name)) return true
    }
    return false
  }
}

// Macro definitions captured from #define directives. We do not expand;
// we only need to know which names are macros so call sites can be tagged.
export interface MacroDef {
  name: string
  isFunctionLike: boolean
  params?: string[]      // present iff isFunctionLike
  variadic?: boolean     // ... in parameter list
  // Body is preserved as a raw token sequence on the AST node; we only need
  // names here.
}

export class MacroTable {
  private defs = new Map<string, MacroDef>()

  define(def: MacroDef): void {
    this.defs.set(def.name, def)
  }

  undefine(name: string): void {
    this.defs.delete(name)
  }

  has(name: string): boolean {
    return this.defs.has(name)
  }

  get(name: string): MacroDef | undefined {
    return this.defs.get(name)
  }
}

// Lex-mode flags that ride on Context.meta. Lex matchers read these to know
// whether to enter directive-line mode (where newline becomes a token and
// header-name forms are valid) or normal mode.
export interface LexMode {
  // True between the start-of-logical-line `#` and the terminating newline.
  inDirective: boolean
  // True when the next token inside a directive should be parsed as a
  // header-name (set by the #include matcher upon seeing `include`).
  expectHeaderName: boolean
  // The directive name currently being parsed, or null. Used by matchers
  // that need to know which directive they are inside.
  directiveName: string | null
}

// All C-parser global state lives here, accessible from any matcher or rule
// via ctx.meta.cmeta.
export interface CMeta {
  symbols: SymbolTable
  macros: MacroTable
  mode: LexMode
  // Buffer of trivia tokens (comments, line continuations) emitted since
  // the last non-trivia token. The sub-lex hook drains this buffer onto
  // `tkn.use.leading` of each non-trivia token, so trivia stays attached
  // to the token it precedes even though the parser sees it as IGNORE'd.
  pendingTrivia: any[]
}

export function makeCMeta(): CMeta {
  return {
    symbols: new SymbolTable(),
    macros: new MacroTable(),
    mode: { inDirective: false, expectHeaderName: false, directiveName: null },
    pendingTrivia: [],
  }
}
