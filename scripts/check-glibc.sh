#!/usr/bin/env bash
# Fail if a Linux binary needs a newer glibc than allowed.
#
#   scripts/check-glibc.sh <binary> [max-version]     (default max: 2.36)
#
# 2.36 is the glibc of Debian 12, which both the build image (golang:*-bookworm)
# and the runtime image (distroless/cc-debian12) are based on. Exit status:
# 0 ok, 1 the binary needs a newer glibc, 2 bad usage, a missing tool or a file readelf cannot read.
set -euo pipefail

bin="${1:-}"
max="${2:-2.36}"
if [ -z "$bin" ] || [ ! -f "$bin" ]; then
  echo "usage: $0 <binary> [max-version]" >&2
  exit 2
fi
if ! [[ "$max" =~ ^[0-9]+(\.[0-9]+)*$ ]]; then
  echo "check-glibc: max-version must look like 2.36, got '$max'" >&2
  exit 2
fi
if ! command -v readelf >/dev/null; then
  echo "check-glibc: readelf (binutils) is required" >&2
  exit 2
fi

# readelf reads the dynamic symbol table of any architecture, so this also
# checks a cross-compiled arm64 binary on an amd64 host.
if ! syms="$(readelf --dyn-syms -W "$bin" 2>&1)"; then
  echo "check-glibc: readelf cannot read $bin:" >&2
  printf '%s\n' "$syms" >&2
  exit 2
fi
versions="$(printf '%s\n' "$syms" | grep -o 'GLIBC_[0-9][0-9.]*' | sed 's/^GLIBC_//' | sort -Vu || true)"
if [ -z "$versions" ]; then
  echo "check-glibc: $bin references no versioned glibc symbols (static?)"
  exit 0
fi
highest="$(printf '%s\n' "$versions" | tail -n 1)"

# The highest of {highest, max} under version ordering must be max itself.
if [ "$(printf '%s\n%s\n' "$highest" "$max" | sort -V | tail -n 1)" != "$max" ]; then
  echo "check-glibc: $bin needs GLIBC_$highest, newer than the allowed GLIBC_$max" >&2
  exit 1
fi
echo "check-glibc: $bin needs at most GLIBC_$highest (allowed: $max)"
