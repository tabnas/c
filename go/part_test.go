/* Copyright (c) 2026 Richard Rodger and contributors, MIT License */

package tabnasc

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"testing"
)

// The part's copy of C's operator table holds to the reader's.
//
// C's transducer part (alchemy/transduce.alc) places each operator of an
// expression itself, over expr's passes, by a copy of C's operator table
// in alchemy text: the maintainer ruled so on 2026-11-13. The copy is a
// second statement of C's precedence, so this test holds it to the table
// the reader gives expr, cOpTable, entry for entry, and a drift between
// the two fails here. Each entry of the copy is [name kind src left right]:
// the kind (infix, prefix, suffix, ternary, paren, cast), the operator's
// token (an opener for a paren or a cast, the first token of a ternary),
// and its binding powers, -1 where the table gives none.
func TestPartOperatorTable(t *testing.T) {
	part := Translate().Transduce
	if part == nil {
		t.Fatal("c carries no transducer")
	}
	got := partOperatorTable(t, part.Source)
	want := map[string]string{}
	for name, raw := range cOpTable() {
		op := raw.(map[string]any)
		want[name] = opEntry(op)
	}
	for name, entry := range want {
		if got[name] != entry {
			t.Errorf("%s: the part has %q, the reader's table %q", name, got[name], entry)
		}
	}
	for name := range got {
		if _, ok := want[name]; !ok {
			t.Errorf("%s: the part has an operator the reader's table does not", name)
		}
	}
}

var partOpLine = regexp.MustCompile(`^\s*\["([^"]*)" "([^"]*)" "([^"]*)" (-?\d+) (-?\d+)\]\s*$`)

// partOperatorTable reads the copy between its markers, by name.
func partOperatorTable(t *testing.T, source string) map[string]string {
	t.Helper()
	begin := strings.Index(source, "; BEGIN C_OP_TABLE")
	end := strings.Index(source, "; END C_OP_TABLE")
	if begin < 0 || end < begin {
		t.Fatal("the part has no C_OP_TABLE block")
	}
	out := map[string]string{}
	for _, line := range strings.Split(source[begin:end], "\n") {
		m := partOpLine.FindStringSubmatch(line)
		if m == nil {
			continue
		}
		left, _ := strconv.Atoi(m[4])
		right, _ := strconv.Atoi(m[5])
		out[m[1]] = fmt.Sprintf("%s %s %d %d", m[2], m[3], left, right)
	}
	if len(out) == 0 {
		t.Fatal("the part's C_OP_TABLE block holds no entry")
	}
	return out
}

// opEntry is an operator of the reader's table as the copy writes it.
func opEntry(op map[string]any) string {
	flag := func(key string) bool { v, _ := op[key].(bool); return v }
	power := func(key string) int {
		if v, ok := op[key].(int); ok {
			return v
		}
		return -1
	}
	kind := "?"
	for _, k := range []string{"cast", "paren", "ternary", "infix", "prefix", "suffix"} {
		if flag(k) {
			kind = k
			break
		}
	}
	src := ""
	switch kind {
	case "cast", "paren":
		src, _ = op["osrc"].(string)
	case "ternary":
		if s, ok := op["src"].([]any); ok && len(s) > 0 {
			src, _ = s[0].(string)
		}
	default:
		src, _ = op["src"].(string)
	}
	return fmt.Sprintf("%s %s %d %d", kind, src, power("left"), power("right"))
}
