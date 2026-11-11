/* Copyright (c) 2026 Richard Rodger and contributors, MIT License */

package tabnasc

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"

	tabnas "github.com/tabnas/parser/go"
	support "github.com/tabnas/support/go"
)

// What every tree holds to (docs/rules.md, "The tree"): `children` holds
// each subtree once, no node holds itself, a node's members are scalars
// (the named members that repeat a child are the API's, Member), every
// node has a span, and every comment the source holds is in the tree but
// one after the last token. Run over every input of the shared fixtures
// and the Csmith corpus. Port of ts/test/tree.test.ts.

var treeTrivia = map[string]bool{
	"TRIVIA_LINE_COMMENT": true, "TRIVIA_BLOCK_COMMENT": true, "TRIVIA_LINE_CONT": true,
}

// treeProblems is the problems a tree has, at most a few.
func treeProblems(tree any) []string {
	var out []string
	seen := map[uintptr]bool{}
	type item struct {
		n  any
		at string
	}
	stack := []item{{tree, ""}}
	for len(stack) > 0 && len(out) < 5 {
		it := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		n, ok := it.n.(map[string]any)
		if !ok || n == nil {
			continue
		}
		id := nodeID(n)
		if seen[id] {
			out = append(out, it.at+": a subtree held twice")
			continue
		}
		seen[id] = true
		if n["kind"] == "token" {
			continue
		}
		span, _ := n["span"].(map[string]any)
		if _, ok := span["start"].(int); !ok {
			out = append(out, it.at+": no span")
		}
		keys := make([]string, 0, len(n))
		for k := range n {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for _, k := range keys {
			if k == "children" || k == "span" || k == "trivia" {
				continue
			}
			switch v := n[k].(type) {
			case map[string]any:
				out = append(out, fmt.Sprintf("%s/%v.%s: a member holds an object", it.at, n["kind"], k))
			case []any:
				for _, x := range v {
					if _, ok := x.(map[string]any); ok {
						out = append(out, fmt.Sprintf("%s/%v.%s: a member holds objects", it.at, n["kind"], k))
						break
					}
				}
			}
		}
		kids, _ := n["children"].([]any)
		for i := len(kids) - 1; i >= 0; i-- {
			stack = append(stack, item{kids[i], fmt.Sprintf("%s/%v[%d]", it.at, n["kind"], i)})
		}
	}
	return out
}

// lostComments is the comments the lexer reads that the tree does not
// hold, those after the last token left out.
func lostComments(t *testing.T, src string, plugin map[string]any, start string) int {
	t.Helper()
	j, err := MakeC(plugin)
	if err != nil {
		t.Fatal(err)
	}
	if start != "" {
		j.SetOptions(tabnas.Options{Rule: &tabnas.RuleOptions{Start: start}})
	}
	lexed, run, tail := 0, 0, 0
	j.Sub(func(tkn *tabnas.Token, _ *tabnas.Rule, _ *tabnas.Context) {
		if tkn == nil {
			return
		}
		switch {
		case treeTrivia[tkn.Name]:
			lexed++
			run++
		case tkn.Name == "#SP" || tkn.Name == "#LN" || tkn.Name == "#CM":
		case tkn.Name == "#ZZ":
			tail = run
		default:
			run = 0
		}
	}, nil)
	tree, err := j.Parse(src)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	kept := 0
	stack := []any{tree}
	for len(stack) > 0 {
		n, _ := stack[len(stack)-1].(map[string]any)
		stack = stack[:len(stack)-1]
		if n == nil {
			continue
		}
		if n["kind"] == "token" {
			if tn, _ := n["tname"].(string); treeTrivia[tn] {
				kept++
			}
			continue
		}
		kids, _ := n["children"].([]any)
		stack = append(stack, kids...)
	}
	return lexed - tail - kept
}

func TestTreeOfEveryFixture(t *testing.T) {
	specDir, err := support.FindSpecDir("")
	if err != nil {
		t.Fatal(err)
	}
	files, _ := filepath.Glob(filepath.Join(specDir, "*.tsv"))
	sort.Strings(files)
	rows := 0
	for _, f := range files {
		raw, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		lines := strings.Split(string(raw), "\n")
		head := strings.Split(lines[0], "\t")
		col := func(name string) int {
			for i, h := range head {
				if h == name {
					return i
				}
			}
			return -1
		}
		for li, line := range lines {
			if li == 0 || strings.TrimSpace(line) == "" ||
				(strings.HasPrefix(line, "#") && !strings.Contains(line, "\t")) {
				continue
			}
			cols := strings.Split(line, "\t")
			if strings.HasPrefix(cols[col("expected")], "ERROR") {
				continue
			}
			opts := map[string]any{}
			if c := col("opts"); c >= 0 && c < len(cols) && strings.TrimSpace(cols[c]) != "" {
				if err := json.Unmarshal([]byte(cols[c]), &opts); err != nil {
					t.Fatal(err)
				}
			}
			plugin, _ := opts["plugin"].(map[string]any)
			if plugin == nil {
				plugin = map[string]any{}
			}
			start, _ := opts["start"].(string)
			src := support.Unescape(cols[0])
			j, err := MakeC(plugin)
			if err != nil {
				t.Fatal(err)
			}
			if start != "" {
				j.SetOptions(tabnas.Options{Rule: &tabnas.RuleOptions{Start: start}})
			}
			tree, err := j.Parse(src)
			if err != nil {
				t.Fatalf("%s:%d: %v", filepath.Base(f), li+1, err)
			}
			if p := treeProblems(tree); len(p) > 0 {
				t.Errorf("%s:%d: %v", filepath.Base(f), li+1, p)
			}
			if n := lostComments(t, src, plugin, start); n != 0 {
				t.Errorf("%s:%d: %d comments lost", filepath.Base(f), li+1, n)
			}
			rows++
		}
	}
	if rows < 100 {
		t.Errorf("%d rows", rows)
	}
}

func TestTreeOfEveryCsmithProgram(t *testing.T) {
	corpusDir := filepath.Join("..", "ts", "test", "csmith-corpus")
	entries, err := os.ReadDir(corpusDir)
	if err != nil {
		t.Skipf("csmith corpus not present: %v", err)
	}
	seed := regexp.MustCompile(`^seed-\d+\.c$`)
	n := 0
	for _, e := range entries {
		if !seed.MatchString(e.Name()) {
			continue
		}
		raw, err := os.ReadFile(filepath.Join(corpusDir, e.Name()))
		if err != nil {
			t.Fatal(err)
		}
		src := strings.ReplaceAll(strings.ReplaceAll(string(raw), "\r\n", "\n"), "\r", "\n")
		tree, err := parseCsmithSource(src)
		if err != nil {
			t.Fatalf("%s: %v", e.Name(), err)
		}
		if p := treeProblems(tree); len(p) > 0 {
			t.Errorf("%s: %v", e.Name(), p)
		}
		n++
	}
	if n == 0 {
		t.Skip("csmith corpus empty")
	}
}

// The embedded grammar is ts/c-grammar.jsonic, which ts/embed-grammar.js
// copies here.
func TestEmbeddedGrammarMatchesSource(t *testing.T) {
	src, err := os.ReadFile(filepath.Join("..", "ts", "c-grammar.jsonic"))
	if err != nil {
		t.Skipf("ts/c-grammar.jsonic not present: %v", err)
	}
	if string(src) != Grammar() {
		t.Fatal("go/c-grammar.jsonic differs from ts/c-grammar.jsonic: run npm run embed in ts")
	}
}
