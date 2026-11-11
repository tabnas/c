package tabnasc

import (
	"testing"

	jsonic "github.com/tabnas/jsonic/go"
	tabnas "github.com/tabnas/parser/go"
)

// TestMakeCDeclaresNoWindow: the parser MakeC builds declares lex.window
// false, its own setting, so that ParseReader reads a reader whole: the
// plugin's matchers are not yet verified at the window's edge.
func TestMakeCDeclaresNoWindow(t *testing.T) {
	j, err := MakeC()
	if err != nil {
		t.Fatal(err)
	}
	if j.Config().Window {
		t.Error("MakeC declares lex.window")
	}
}

// TestMakeCOnAWindowedBase: the parser's own setting wins over its
// base's. A base that declares lex.window, as jsonic's own constructor
// may, given the constructor's steps, comes out with the window off.
func TestMakeCOnAWindowedBase(t *testing.T) {
	yes := true
	base := jsonic.Make()
	base.SetOptions(tabnas.Options{Lex: &tabnas.LexOptions{Window: &yes}})
	if !base.Config().Window {
		t.Fatal("the base does not declare lex.window")
	}
	j, err := makeCOn(base, nil)
	if err != nil {
		t.Fatal(err)
	}
	if j.Config().Window {
		t.Error("the base's lex.window reaches the C parser")
	}
	if _, err := j.Parse("int main(void) { return 0; }"); err != nil {
		t.Errorf("parse: %v", err)
	}
}
