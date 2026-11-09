#!/usr/bin/env bash
# The version gate release.yml runs. package.json is the manifest. The Worker
# is deployed from this repository rather than installed from a registry, so
# the git tag is the only record of a release.
#
#   version      print the manifest's version
#   consistency  fail if anything disagrees with the manifest
#   check        print version= and release=true|false for $GITHUB_OUTPUT
set -euo pipefail

die() {
  echo "release-version: $*" >&2
  exit 1
}

tag_exists() {
  local rc=0
  git ls-remote --exit-code --tags origin "refs/tags/v$version" >/dev/null || rc=$?
  case "$rc" in
    0) return 0 ;;
    2) return 1 ;;
    *) die "git ls-remote failed with $rc" ;;
  esac
}

version=$(jq -r .version package.json)
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "no X.Y.Z version in the manifest: '$version'"

case "${1:-}" in
  version)
    echo "$version"
    ;;
  consistency)
    constant=$(sed -n "s/^const VERSION = '\([^']*\)'$/\1/p" src/index.ts)
    [ "$constant" = "$version" ] || die "src/index.ts has '$constant', package.json has $version"
    grep -qF "cloudflare-worker/$version" tests/index.test.ts || die "tests/index.test.ts does not expect $version"
    grep -qF "cloudflare-worker/$version" README.md || die "README.md does not state $version"
    ;;
  check)
    echo "version=$version"
    if tag_exists; then
      echo "v$version is already tagged" >&2
      echo "release=false"
    else
      echo "release=true"
    fi
    ;;
  *)
    die "usage: release-version.sh version|consistency|check"
    ;;
esac
