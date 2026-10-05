#!/usr/bin/env bash
# Tests for check-release-version.sh. Run: scripts/check-release-version_test.sh
set -u
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
script="$here/check-release-version.sh"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
failures=0

expect() { # expect <description> <want-exit> <command...>
  local desc="$1" want="$2"; shift 2
  local out got
  out="$("$@" 2>&1)"; got=$?
  if [ "$got" -ne "$want" ]; then
    echo "FAIL: $desc: exit $got, want $want"; echo "$out" | sed 's/^/    /'
    failures=$((failures + 1))
  else
    echo "ok:   $desc"
  fi
}

# A repository root with the files the script reads.
repo() { # repo <manifest-version> <min-app-version> <versions.json>
  mkdir -p "$tmp/r"
  printf '{"id":"obsync","version":"%s","minAppVersion":"%s"}\n' "$1" "$2" > "$tmp/r/manifest.json"
  printf '%s\n' "$3" > "$tmp/r/versions.json"
}

repo 0.2.0 1.5.7 '{"0.1.0":"1.5.7","0.2.0":"1.5.7"}'
expect "a tag that matches the manifest and versions.json passes" 0 "$script" 0.2.0 "$tmp/r"
expect "a leading v is refused (Obsidian wants bare X.Y.Z tags)" 1 "$script" v0.2.0 "$tmp/r"
expect "a tag with a suffix is refused" 1 "$script" 0.2.0-rc1 "$tmp/r"
expect "a tag that is not the manifest version is refused" 1 "$script" 0.3.0 "$tmp/r"
repo 0.2.0 1.5.7 '{"0.1.0":"1.5.7"}'
expect "a version missing from versions.json is refused" 1 "$script" 0.2.0 "$tmp/r"
repo 0.2.0 1.5.7 '{"0.2.0":"1.4.0"}'
expect "a versions.json entry with another minAppVersion is refused" 1 "$script" 0.2.0 "$tmp/r"
repo 0.2.0 1.5.7 'not json'
expect "an unreadable versions.json is refused" 1 "$script" 0.2.0 "$tmp/r"
expect "no arguments is a usage error" 2 "$script"
expect "a directory without manifest.json is a usage error" 2 "$script" 0.2.0 "$tmp/nowhere"

if [ "$failures" -ne 0 ]; then echo "$failures failed"; exit 1; fi
echo "all passed"
