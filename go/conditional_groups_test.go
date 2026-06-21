/* Copyright (c) 2026 Richard Rodger and contributors, MIT License */

package tabnasc

import "testing"

// directiveDecl builds an external_declaration whose first child is a
// conditional_directive with the given directive name.
func directiveDecl(name string) CNode {
	d := makeNode("conditional_directive", nil)
	d["directive"] = name
	ed := makeNode("external_declaration", nil)
	ed["children"] = []any{d}
	return ed
}

// plainDecl builds a non-directive external_declaration tagged by id.
func plainDecl(id string) CNode {
	ed := makeNode("external_declaration", nil)
	ed["declKind"] = id
	return ed
}

func TestConditionalGroupBasic(t *testing.T) {
	tu := makeNode("translation_unit", nil)
	tu["children"] = []any{
		directiveDecl("if"),
		plainDecl("a"),
		directiveDecl("else"),
		plainDecl("b"),
		directiveDecl("endif"),
		plainDecl("after"),
	}
	structureConditionalGroups(tu)

	kids := tu["children"].([]any)
	if len(kids) != 2 {
		t.Fatalf("expected [group, after], got %d children", len(kids))
	}
	grp, ok := kids[0].(CNode)
	if !ok || grp["kind"] != "conditional_group" {
		t.Fatalf("first child not a conditional_group: %v", kids[0])
	}
	branches := grp["branches"].([]any)
	if len(branches) != 2 {
		t.Fatalf("expected 2 branches (if, else), got %d", len(branches))
	}
	if b0 := branches[0].(CNode); b0["branchKind"] != "if" {
		t.Errorf("branch0 kind = %v, want if", b0["branchKind"])
	}
	if b1 := branches[1].(CNode); b1["branchKind"] != "else" {
		t.Errorf("branch1 kind = %v, want else", b1["branchKind"])
	}
	if after := kids[1].(CNode); after["declKind"] != "after" {
		t.Errorf("trailing decl not preserved: %v", kids[1])
	}
}

func TestConditionalGroupNested(t *testing.T) {
	tu := makeNode("translation_unit", nil)
	tu["children"] = []any{
		directiveDecl("ifdef"),
		directiveDecl("if"),
		plainDecl("inner"),
		directiveDecl("endif"),
		directiveDecl("endif"),
	}
	structureConditionalGroups(tu)
	kids := tu["children"].([]any)
	if len(kids) != 1 {
		t.Fatalf("expected single outer group, got %d", len(kids))
	}
	grp := kids[0].(CNode)
	if grp["kind"] != "conditional_group" {
		t.Fatalf("not a group: %v", grp)
	}
	// The single branch's body should contain a nested conditional_group.
	branch := grp["branches"].([]any)[0].(CNode)
	body := branch["body"].([]any)
	foundNested := false
	for _, b := range body {
		if bm, ok := b.(CNode); ok && bm["kind"] == "conditional_group" {
			foundNested = true
		}
	}
	if !foundNested {
		t.Errorf("nested #if not grouped inside branch body: %v", body)
	}
}

func TestConditionalGroupUnterminated(t *testing.T) {
	// No matching #endif: children left unchanged.
	tu := makeNode("translation_unit", nil)
	tu["children"] = []any{directiveDecl("if"), plainDecl("a")}
	structureConditionalGroups(tu)
	kids := tu["children"].([]any)
	if len(kids) != 2 {
		t.Fatalf("unterminated #if should leave children intact, got %d", len(kids))
	}
}
