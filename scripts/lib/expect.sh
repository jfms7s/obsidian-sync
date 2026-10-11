# Shared harness for the scripts/*_test.sh files. Source it after setting
# `here` (the scripts directory) and `script` (the script under test):
#   . "$here/lib/expect.sh"
# It provides $tmp (a scratch directory removed on exit), $failures and
# expect.
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
