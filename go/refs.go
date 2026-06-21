/* Copyright (c) 2026 Richard Rodger and contributors, MIT License */

package tabnasc

import tabnas "github.com/tabnas/parser/go"

// makeGrammarRefs returns the @-named condition/action handlers the C grammar
// binds. Port of makeGrammarRefs in c.ts (the ~471-entry ref map). Handlers
// are being ported incrementally; any @ref referenced by the grammar but not
// present here is given a typed no-op stub by scanAndStubRefs at install time
// (false-returning condition / no-op action), so the grammar always installs.
//
// As handlers are ported, add them here keyed by their grammar name
// (conditions as tabnas.AltCond, actions as tabnas.AltAction) and by phase
// (e.g. "@rule-bc" as tabnas.StateAction).
func makeGrammarRefs(opts COptions) map[tabnas.FuncRef]any {
	ref := map[tabnas.FuncRef]any{}

	// --- extension gate ---------------------------------------------------
	// @extended-on / @extended-off gate the GCC/MSVC/preprocessor alts.
	extended := opts.Extended
	ref["@extended-on"] = tabnas.AltCond(func(_ *tabnas.Rule, _ *tabnas.Context) bool {
		return extended
	})
	ref["@extended-off"] = tabnas.AltCond(func(_ *tabnas.Rule, _ *tabnas.Context) bool {
		return !extended
	})

	return ref
}
