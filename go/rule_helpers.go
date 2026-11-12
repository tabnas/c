/* Copyright (c) 2026 Richard Rodger and contributors, MIT License */

package tabnasc

import (
	tabnas "github.com/tabnas/parser/go"
)

// uStr returns the string value of r.U[key] ("" if absent).
func uStr(r *tabnas.Rule, key string) string {
	s, _ := r.U[key].(string)
	return s
}

// intOr returns v as an int, or d when it is not a number.
func intOr(v any, d int) int {
	switch n := v.(type) {
	case int:
		return n
	case float64:
		return int(n)
	}
	return d
}
