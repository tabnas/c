/* Copyright (c) 2026 Richard Rodger and contributors, MIT License */

package tabnasc

// Symbol and macro tables used by the C parser to resolve the classic
// identifier/typedef-name disambiguation problem. Port of ../ts/src/symbols.ts.
//
// Both tables live on the per-parse CMeta (stashed on the engine Context) so
// lex matchers and rule actions read and mutate the same instance. The
// identifier-classification matcher consults SymbolTable.IsTypedef before
// deciding ID vs TYPEDEF_NAME, and MacroTable.Has to optionally emit
// MACRO_NAME.
//
// Scopes form a stack; the parser pushes/pops on file, function-prototype,
// function-body, block, struct-or-union, enum and for-init boundaries. Inner
// scopes shadow outer ones; lookups walk the stack outward.

// ScopeKind enumerates the C scope kinds.
type ScopeKind string

const (
	ScopeFile        ScopeKind = "file"
	ScopeFnProto     ScopeKind = "fn-proto"
	ScopeFnBody      ScopeKind = "fn-body"
	ScopeBlock       ScopeKind = "block"
	ScopeStructUnion ScopeKind = "struct-union"
	ScopeEnum        ScopeKind = "enum"
	ScopeForInit     ScopeKind = "for-init"
)

// BindKind records whether a name is bound as a typedef or an ordinary name.
type BindKind string

const (
	BindTypedef  BindKind = "typedef"
	BindOrdinary BindKind = "ordinary"
)

// TagKind records the kind of a struct/union/enum tag.
type TagKind string

const (
	TagStruct TagKind = "struct"
	TagUnion  TagKind = "union"
	TagEnum   TagKind = "enum"
)

// Scope is one lexical scope frame.
type Scope struct {
	Kind ScopeKind
	// Bind maps names bound in this scope to their kind. Ordinary identifiers
	// are recorded so an inner non-typedef declaration hides an outer typedef.
	Bind map[string]BindKind
	// Tags (struct/union/enum names) live in a separate namespace in C.
	Tags map[string]TagKind
}

func newScope(kind ScopeKind) *Scope {
	return &Scope{
		Kind: kind,
		Bind: map[string]BindKind{},
		Tags: map[string]TagKind{},
	}
}

// SymbolTable is the scope stack.
type SymbolTable struct {
	stack []*Scope
}

// NewSymbolTable creates a table with the (never-popped) file scope.
func NewSymbolTable() *SymbolTable {
	return &SymbolTable{stack: []*Scope{newScope(ScopeFile)}}
}

// Enter pushes a new scope.
func (st *SymbolTable) Enter(kind ScopeKind) {
	st.stack = append(st.stack, newScope(kind))
}

// Exit pops the current scope (never the file scope).
func (st *SymbolTable) Exit() {
	if len(st.stack) <= 1 {
		return
	}
	st.stack = st.stack[:len(st.stack)-1]
}

// Depth returns the number of scopes on the stack.
func (st *SymbolTable) Depth() int {
	return len(st.stack)
}

// Current returns the innermost scope.
func (st *SymbolTable) Current() *Scope {
	return st.stack[len(st.stack)-1]
}

// IsTypedef reports whether name resolves to a typedef-name in any visible
// scope, innermost binding winning.
func (st *SymbolTable) IsTypedef(name string) bool {
	for i := len(st.stack) - 1; i >= 0; i-- {
		if b, ok := st.stack[i].Bind[name]; ok {
			return b == BindTypedef
		}
	}
	return false
}

// IsBound reports whether name is bound at all (typedef or ordinary).
func (st *SymbolTable) IsBound(name string) bool {
	for i := len(st.stack) - 1; i >= 0; i-- {
		if _, ok := st.stack[i].Bind[name]; ok {
			return true
		}
	}
	return false
}

// BindTypedef binds name as a typedef in the current scope.
func (st *SymbolTable) BindTypedef(name string) {
	st.Current().Bind[name] = BindTypedef
}

// BindOrdinary binds name as an ordinary identifier in the current scope.
func (st *SymbolTable) BindOrdinary(name string) {
	st.Current().Bind[name] = BindOrdinary
}

// BindTag binds a struct/union/enum tag in the current scope.
func (st *SymbolTable) BindTag(name string, kind TagKind) {
	st.Current().Tags[name] = kind
}

// HasTag reports whether a tag with name is visible.
func (st *SymbolTable) HasTag(name string) bool {
	for i := len(st.stack) - 1; i >= 0; i-- {
		if _, ok := st.stack[i].Tags[name]; ok {
			return true
		}
	}
	return false
}

// MacroDef is a captured #define. We do not expand; we only track names so
// call sites can be tagged.
type MacroDef struct {
	Name           string
	IsFunctionLike bool
	Params         []string // present iff IsFunctionLike
	Variadic       bool     // ... in parameter list
}

// MacroTable records #define'd names.
type MacroTable struct {
	defs map[string]*MacroDef
}

// NewMacroTable creates an empty macro table.
func NewMacroTable() *MacroTable {
	return &MacroTable{defs: map[string]*MacroDef{}}
}

// Define records a macro.
func (mt *MacroTable) Define(def *MacroDef) {
	mt.defs[def.Name] = def
}

// Undefine removes a macro.
func (mt *MacroTable) Undefine(name string) {
	delete(mt.defs, name)
}

// Has reports whether name is a defined macro.
func (mt *MacroTable) Has(name string) bool {
	_, ok := mt.defs[name]
	return ok
}

// Get returns the macro def for name, or nil.
func (mt *MacroTable) Get(name string) *MacroDef {
	return mt.defs[name]
}

// LexMode are lex-mode flags that ride on CMeta. Lex matchers read these to
// know whether to enter directive-line mode (where newline becomes a token
// and header-name forms are valid) or normal mode.
type LexMode struct {
	// InDirective is true between the start-of-logical-line `#` and the
	// terminating newline.
	InDirective bool
	// ExpectHeaderName is true when the next token inside a directive should
	// be parsed as a header-name (set by the #include matcher).
	ExpectHeaderName bool
	// DirectiveName is the directive currently being parsed, or "".
	DirectiveName string
}

// CMeta holds all C-parser per-parse state, accessible from any matcher or
// rule via the engine Context.
type CMeta struct {
	Symbols *SymbolTable
	Macros  *MacroTable
	Mode    *LexMode
	// PendingTrivia buffers trivia tokens (comments, line continuations)
	// emitted since the last non-trivia token. The sub-lex hook drains this
	// onto each non-trivia token's leading-trivia so trivia stays attached to
	// the token it precedes even though the parser IGNOREs it.
	PendingTrivia []any
}

// MakeCMeta builds a fresh CMeta.
func MakeCMeta() *CMeta {
	return &CMeta{
		Symbols:       NewSymbolTable(),
		Macros:        NewMacroTable(),
		Mode:          &LexMode{},
		PendingTrivia: nil,
	}
}
