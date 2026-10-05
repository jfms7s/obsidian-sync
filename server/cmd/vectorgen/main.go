// Command vectorgen writes the plugin's known-answer test vectors. It
// implements the plan 2 crypto specification with Go's standard library and
// golang.org/x/crypto, independently of the TypeScript code under test.
package main

import (
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"sort"
)

func main() {
	out := flag.String("out", "../plugin/test/vectors", "directory to write the vector files to")
	flag.Parse()
	if err := os.MkdirAll(*out, 0o755); err != nil {
		fmt.Fprintln(os.Stderr, "vectorgen:", err)
		os.Exit(1)
	}
	rendered := render()
	names := make([]string, 0, len(rendered))
	for name := range rendered {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		if err := os.WriteFile(filepath.Join(*out, name), rendered[name], 0o644); err != nil {
			fmt.Fprintln(os.Stderr, "vectorgen:", err)
			os.Exit(1)
		}
		fmt.Println("wrote", filepath.Join(*out, name))
	}
}
