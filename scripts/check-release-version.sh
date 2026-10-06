#!/usr/bin/env bash
# Fail unless a release tag agrees with the plugin's manifest.
#
#   scripts/check-release-version.sh <tag> [repo-root]
#
# Obsidian installs a plugin from the GitHub release whose tag is exactly the
# version in manifest.json (no leading "v"), and reads versions.json to find
# the newest release an older Obsidian can run. The server and the plugin
# share these X.Y.Z tags. Exit status: 0 ok, 1 the tag and the files disagree,
# 2 bad usage.
set -euo pipefail

tag="${1:-}"
root="${2:-.}"
if [ -z "$tag" ] || [ ! -f "$root/manifest.json" ]; then
  echo "usage: $0 <tag> [repo-root with manifest.json and versions.json]" >&2
  exit 2
fi

fail() { echo "check-release-version: $*" >&2; exit 1; }

[[ "$tag" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "tag '$tag' must be a bare X.Y.Z version (no v prefix, no suffix)"

manifest_version="$(jq -er .version "$root/manifest.json")" || fail "manifest.json has no version"
min_app="$(jq -er .minAppVersion "$root/manifest.json")" || fail "manifest.json has no minAppVersion"
[ "$manifest_version" = "$tag" ] || fail "tag $tag is not the manifest.json version ($manifest_version)"

listed="$(jq -er --arg v "$tag" '.[$v]' "$root/versions.json" 2>/dev/null)" || fail "versions.json has no entry for $tag"
[ "$listed" = "$min_app" ] || fail "versions.json says $tag needs Obsidian $listed, manifest.json says $min_app"

echo "check-release-version: $tag matches manifest.json and versions.json (Obsidian $min_app or newer)"
