#!/usr/bin/env bash
# Tests for check-glibc.sh. Run: scripts/check-glibc_test.sh
set -u
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
script="$here/check-glibc.sh"
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

# A real dynamically linked binary of the host: it needs some GLIBC_2.x symbol.
# On a host whose ls is static or not linked against glibc (Alpine, busybox)
# these two cases do not apply; the shim cases below still run.
real="$(command -v ls)"
if readelf --dyn-syms -W "$real" 2>/dev/null | grep -q 'GLIBC_[0-9]'; then
  expect "real binary passes a generous limit" 0 "$script" "$real" 99
  expect "real binary fails an impossibly old limit" 1 "$script" "$real" 2.0
else
  echo "skip: $real has no versioned glibc symbols, so the real-binary cases do not apply"
fi

# A shim readelf lets us state the symbol versions exactly.
mkdir -p "$tmp/bin"
cat > "$tmp/bin/readelf" <<'SHIM'
#!/usr/bin/env bash
printf '%s\n' "$FAKE_READELF_OUTPUT"
exit "${FAKE_READELF_EXIT:-0}"
SHIM
chmod +x "$tmp/bin/readelf"
fake="$tmp/fake-binary"; : > "$fake"
with_syms() { # with_syms <symbols-text> <script args...>
  local syms="$1"; shift
  PATH="$tmp/bin:$PATH" FAKE_READELF_OUTPUT="$syms" "$script" "$@"
}
syms='     1: 0000 0 FUNC GLOBAL DEFAULT UND memcpy@GLIBC_2.14 (2)
     2: 0000 0 FUNC GLOBAL DEFAULT UND getrandom@GLIBC_2.36 (3)
     3: 0000 0 FUNC GLOBAL DEFAULT UND free@GLIBC_2.2.5 (4)'
expect "exactly the limit passes (default 2.36)" 0 with_syms "$syms" "$fake"
expect "one minor over the limit fails" 1 with_syms "$syms" "$fake" 2.35
expect "versions compare numerically, not as text" 0 with_syms "$syms" "$fake" 2.100
expect "three-part versions count" 1 with_syms 'a@GLIBC_2.2.5 (2)' "$fake" 2.2
expect "no GLIBC symbols (static binary) passes" 0 with_syms 'nothing here' "$fake"
expect "the failure names the offending version" 0 bash -c \
  "PATH='$tmp/bin':\$PATH FAKE_READELF_OUTPUT='$syms' '$script' '$fake' 2.35 2>&1 | grep -q 'GLIBC_2.36'"

expect "missing binary is a usage error" 2 "$script" "$tmp/does-not-exist"
expect "no arguments is a usage error" 2 "$script"
expect "malformed limit is a usage error" 2 "$script" "$real" abc
expect "a file readelf cannot read is an error, not a static binary" 2 "$script" "$script"
expect "a failing readelf is an error, not a static binary" 2 env PATH="$tmp/bin:$PATH" FAKE_READELF_OUTPUT='' FAKE_READELF_EXIT=1 "$script" "$fake"

if [ "$failures" -ne 0 ]; then echo "$failures failure(s)"; exit 1; fi
echo "all passed"
