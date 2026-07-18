#!/usr/bin/env bash
#
# fork-surface.sh — Show this fork's conflict surface versus upstream.
#
# The fork's customizations fall into two buckets:
#   ADDED files     — new files upstream doesn't have. These can NEVER conflict.
#   MODIFIED files  — upstream files we edited. This is the ENTIRE conflict
#                     surface you must review on every upstream merge.
#
# Run this BEFORE merging a new upstream release so you know exactly which
# files can conflict. Keeping the MODIFIED list small and additive is what
# keeps upstream merges cheap (see MERGING.md).
#
# Usage:
#   scripts/fork-surface.sh [<upstream-ref>] [<fork-ref>]
#     <upstream-ref>  upstream mirror branch or release tag   (default: canary)
#     <fork-ref>      the fork branch to inspect              (default: current branch)
#
# Examples:
#   scripts/fork-surface.sh                     # current branch vs canary mirror
#   scripts/fork-surface.sh v0.27.0             # current branch vs a release tag
#   scripts/fork-surface.sh canary requesty-provider-spec
#
set -euo pipefail

UPSTREAM_REF="${1:-canary}"
FORK_REF="${2:-HEAD}"

if ! git rev-parse --verify --quiet "$UPSTREAM_REF" >/dev/null; then
  echo "error: upstream ref '$UPSTREAM_REF' not found. Fetch it first (e.g. git fetch origin --tags)." >&2
  exit 1
fi

BASE=$(git merge-base "$FORK_REF" "$UPSTREAM_REF")

echo "Fork ref      : $(git rev-parse --abbrev-ref "$FORK_REF" 2>/dev/null || echo "$FORK_REF")"
echo "Upstream ref  : $UPSTREAM_REF"
echo "Merge-base    : $(git log -1 --format='%h %s' "$BASE")"
echo

STATUS=$(git diff --name-status "$BASE" "$FORK_REF")

n_mod=$(printf '%s\n' "$STATUS" | grep -c '^M' || true)
n_add=$(printf '%s\n' "$STATUS" | grep -c '^A' || true)
n_del=$(printf '%s\n' "$STATUS" | grep -c '^D' || true)

echo "== CONFLICT SURFACE: $n_mod upstream files MODIFIED by the fork =="
echo "   (review each of these when resolving an upstream merge)"
printf '%s\n' "$STATUS" | awk '$1=="M"{print "   "$2}'
echo

if [ "$n_del" -gt 0 ]; then
  echo "== $n_del upstream files DELETED by the fork (also review on merge) =="
  printf '%s\n' "$STATUS" | awk '$1=="D"{print "   "$2}'
  echo
fi

echo "== SAFE: $n_add files ADDED by the fork (never conflict) — by area =="
printf '%s\n' "$STATUS" | awk '$1=="A"{print $2}' \
  | sed -E 's#^([^/]+/[^/]+/[^/]+).*#\1#' | sort | uniq -c | sort -rn
echo
echo "Summary: $n_mod modified, ${n_del} deleted (conflict risk) · $n_add added (safe)."
