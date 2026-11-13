// Copyright (c) 2025 Richard Rodger and other contributors, MIT License

package tabnasc

// parity_test.go — cross-runtime conformance, driven by the shared
// `test/spec/*.tsv` fixtures at the repo root (see ../test/AGENTS.md).
//
// The fixture loader, the escape codec, the ERROR:<code> contract and the
// row loop all come from github.com/tabnas/support/go, whose TypeScript
// half ts/test/parity.test.ts and Rust half rs/tests/parity_test.rs use to
// run the SAME files — so the three implementations cannot drift without
// one of them going red, and neither can the loaders.
//
// What is left here is only what is specific to c: how to build the parser
// for a row's options, and how to flatten a result for comparison.

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	tabnas "github.com/tabnas/parser/go"
	support "github.com/tabnas/support/go"
)

// TestSpec runs every fixture in the spec directory. FindSpecDir walks up
// from the package directory, and Dir discovers the files by listing, so
// adding a .tsv runs it in every runtime without touching any runner.
func TestSpec(t *testing.T) {
	specDir, err := support.FindSpecDir("")
	if err != nil {
		t.Fatal(err)
	}

	support.Runner{
		ParseRow: func(input string, row *support.Row) (any, error) {
			opts := map[string]any{}
			if raw := row.Named("opts"); "" != raw {
				if err := json.Unmarshal([]byte(raw), &opts); err != nil {
					return nil, err
				}
			}

			// The opts column is {plugin?, start?, find?, nth?, member?}:
			// `plugin` is the C plugin's own options (extension constructs
			// are opt-in), `start` overrides the engine's start rule so an
			// expression can be parsed directly, and `member` reads a
			// node's member back (memberRow).
			pluginOpts := map[string]any{}
			if p, ok := opts["plugin"].(map[string]any); ok {
				pluginOpts = p
			}

			j, err := MakeC(pluginOpts)
			if err != nil {
				return nil, err
			}
			if start, ok := opts["start"].(string); ok && "" != start {
				j.SetOptions(tabnas.Options{Rule: &tabnas.RuleOptions{Start: start}})
			}

			tree, err := j.Parse(input)
			if err != nil {
				return nil, err
			}
			if name, ok := opts["member"].(string); ok && "" != name {
				return memberRow(tree, opts, name)
			}
			return tree, nil
		},

		// Flatten through JSON so the parser's own containers and numeric
		// types compare against the fixture's decoded shape. Normalize runs
		// outermost first, so the top node is enough — the plain values it
		// yields pass through unchanged.
		Normalize: jsonFlatten,
	}.Dir(t, specDir)
}

// memberRow reads a node's member back through the API, as the TypeScript
// runner does: the `nth` node of kind `find` (depth first, the root's
// children before their children), its member, each node it gives
// projected to its kind, its span's start and its tokens' text, so a row
// stays short and still names the one node it means.
func memberRow(tree any, opts map[string]any, name string) (any, error) {
	kind, _ := opts["find"].(string)
	nth := 0
	if v, ok := opts["nth"].(float64); ok {
		nth = int(v)
	}
	node := findNth(tree, kind, nth)
	if node == nil {
		return nil, fmt.Errorf("members: no %s #%d", kind, nth)
	}
	return projectMember(Member(node, name)), nil
}

func findNth(root any, kind string, nth int) CNode {
	seen := 0
	stack := []any{root}
	for len(stack) > 0 {
		n := stack[0]
		stack = stack[1:]
		m, ok := n.(map[string]any)
		if !ok || m == nil || m["kind"] == "token" {
			continue
		}
		if m["kind"] == kind {
			if seen == nth {
				return m
			}
			seen++
		}
		if kids, ok := m["children"].([]any); ok {
			stack = append(append([]any{}, kids...), stack...)
		}
	}
	return nil
}

func memberText(n any) string {
	var out []string
	var walk func(x any)
	walk = func(x any) {
		m, ok := x.(map[string]any)
		if !ok || m == nil {
			return
		}
		if m["kind"] == "token" {
			if tn, _ := m["tname"].(string); !strings.HasPrefix(tn, "TRIVIA") {
				src, _ := m["src"].(string)
				out = append(out, src)
			}
			return
		}
		kids, _ := m["children"].([]any)
		for _, c := range kids {
			walk(c)
		}
	}
	walk(n)
	return strings.Join(out, " ")
}

func projectMember(v any) any {
	switch m := v.(type) {
	case nil:
		return nil
	case []any:
		out := make([]any, len(m))
		for i, x := range m {
			out[i] = projectMember(x)
		}
		return out
	case map[string]any:
		span, _ := m["span"].(map[string]any)
		return map[string]any{"kind": m["kind"], "start": span["start"], "text": memberText(m)}
	}
	return v
}

// jsonFlatten renders a value as JSON and reads it back as plain
// map/slice/float64/string/bool/nil. A value that will not marshal is
// returned as it is: the comparison then fails and prints it, which says
// more than a panic here would.
func jsonFlatten(v any) any {
	raw, err := json.Marshal(v)
	if err != nil {
		return v
	}
	var out any
	if err := json.Unmarshal(raw, &out); err != nil {
		return v
	}
	return out
}
