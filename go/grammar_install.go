/* Copyright (c) 2026 Richard Rodger and contributors, MIT License */

package tabnasc

import (
	"strings"

	jsonic "github.com/tabnas/jsonic/go"
	tabnas "github.com/tabnas/parser/go"
)

// Grammar installation: parse the embedded jsonic-DSL grammar text into a
// GrammarSpec, strip extension rules in plain-C mode, bind the @-named ref
// map (real handlers from makeGrammarRefs, typed no-op stubs for any not yet
// ported), and install it. Mirrors the parseGrammar + jsonic.grammar() flow
// in c.ts.

// extensionRules are stripped from the spec in plain-C (!extended) mode.
var extensionRules = []string{
	// GCC inline assembly
	"asm_statement", "asm_template", "asm_section",
	"asm_operand", "asm_clobber", "asm_label_ref",
	// Preprocessor
	"preprocessor_line", "preprocessor_directive",
	"define_directive", "macro_parameter_list", "macro_body",
	"undef_directive", "include_directive", "header_form",
	"conditional_directive", "simple_directive",
	// Compiler-specific attribute spec syntax
	"attribute_spec_gcc", "attribute_spec_msvc",
}

// installGrammar parses, refs, and installs the C grammar onto j.
func installGrammar(j *tabnas.Tabnas, opts COptions) error {
	parsed := jsonic.Make().Parse
	out, err := parsed(grammarText)
	if err != nil {
		return err
	}
	gsMap, ok := out.(map[string]any)
	if !ok {
		return errInstall("grammar text did not parse to a map")
	}
	ruleMapRaw, _ := gsMap["rule"].(map[string]any)
	if ruleMapRaw == nil {
		return errInstall("grammar has no rule section")
	}

	if !opts.Extended {
		for _, name := range extensionRules {
			delete(ruleMapRaw, name)
		}
	}

	rules := convertRules(ruleMapRaw)

	// Collect @refs referenced in alt c:/a: fields and build the ref map:
	// real handlers where ported, typed no-op stubs otherwise.
	ref := makeGrammarRefs(opts)
	scanAndStubRefs(ruleMapRaw, ref)

	gs := &tabnas.GrammarSpec{Rule: rules, Ref: ref}
	return j.Grammar(gs)
}

type installErr string

func (e installErr) Error() string { return "tabnasc: " + string(e) }
func errInstall(s string) error    { return installErr(s) }

// convertRules converts a parsed rule map into typed GrammarRuleSpec map
// (replicates the engine's unexported mapToGrammarRules for the alt shapes the
// C grammar uses: plain open/close arrays, fields s,b,c,a,p,r,n,u,k,g).
func convertRules(ruleMap map[string]any) map[string]*tabnas.GrammarRuleSpec {
	rules := make(map[string]*tabnas.GrammarRuleSpec, len(ruleMap))
	for name, v := range ruleMap {
		rm, ok := v.(map[string]any)
		if !ok {
			continue
		}
		spec := &tabnas.GrammarRuleSpec{}
		if open, ok := rm["open"]; ok {
			spec.Open = convertAlts(open)
		}
		if close, ok := rm["close"]; ok {
			spec.Close = convertAlts(close)
		}
		rules[name] = spec
	}
	return rules
}

func convertAlts(v any) any {
	arr, ok := v.([]any)
	if !ok {
		return nil
	}
	alts := make([]*tabnas.GrammarAltSpec, 0, len(arr))
	for _, item := range arr {
		m, ok := item.(map[string]any)
		if !ok {
			continue
		}
		alts = append(alts, convertAlt(m))
	}
	return alts
}

func convertAlt(m map[string]any) *tabnas.GrammarAltSpec {
	alt := &tabnas.GrammarAltSpec{}
	if v, ok := m["s"]; ok {
		alt.S = v
	}
	if v, ok := m["b"]; ok {
		alt.B = v
	}
	if v, ok := m["p"].(string); ok {
		alt.P = v
	}
	if v, ok := m["r"].(string); ok {
		alt.R = v
	}
	if v, ok := m["a"]; ok {
		alt.A = v
	}
	if v, ok := m["c"]; ok {
		alt.C = v
	}
	if v, ok := m["n"].(map[string]any); ok {
		alt.N = make(map[string]int, len(v))
		for k, val := range v {
			alt.N[k] = cfgInt(val)
		}
	}
	if v, ok := m["u"].(map[string]any); ok {
		alt.U = v
	}
	if v, ok := m["k"].(map[string]any); ok {
		alt.K = v
	}
	if v, ok := m["g"].(string); ok {
		alt.G = v
	}
	return alt
}

func cfgInt(v any) int {
	switch n := v.(type) {
	case float64:
		return int(n)
	case int:
		return n
	}
	return 0
}

// scanAndStubRefs walks every alt's c:/a: fields and, for each @ref not
// already in ref, installs a typed no-op stub: a false-returning AltCond for
// c: refs, a no-op AltAction for a: refs. This lets the grammar install while
// the real handlers (makeGrammarRefs) are ported incrementally.
func scanAndStubRefs(ruleMap map[string]any, ref map[tabnas.FuncRef]any) {
	visit := func(field string, isCond bool) func(any) {
		return func(v any) {
			s, ok := v.(string)
			if !ok || !strings.HasPrefix(s, "@") {
				return
			}
			key := tabnas.FuncRef(s)
			if _, exists := ref[key]; exists {
				return
			}
			if isCond {
				ref[key] = tabnas.AltCond(func(_ *tabnas.Rule, _ *tabnas.Context) bool { return false })
			} else {
				ref[key] = tabnas.AltAction(func(_ *tabnas.Rule, _ *tabnas.Context) {})
			}
		}
	}
	stubCond := visit("c", true)
	stubAction := visit("a", false)

	for _, rv := range ruleMap {
		rm, ok := rv.(map[string]any)
		if !ok {
			continue
		}
		for _, phase := range []string{"open", "close"} {
			arr, ok := rm[phase].([]any)
			if !ok {
				continue
			}
			for _, item := range arr {
				m, ok := item.(map[string]any)
				if !ok {
					continue
				}
				if c, ok := m["c"]; ok {
					stubCond(c)
				}
				if a, ok := m["a"]; ok {
					stubAction(a)
				}
			}
		}
	}
}
