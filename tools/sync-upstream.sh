#!/usr/bin/env bash
# sync-upstream.sh: bring this fork up to date with michael-denyer/pstack-claude.
#
#   tools/sync-upstream.sh            merge upstream main, re-apply the fork overlay, regenerate, check, commit
#   tools/sync-upstream.sh --check    report whether upstream moved; change nothing
#
# Exit codes: 0 nothing to do or synced and committed; 2 the merge needs a human (conflicts listed in
# sync-conflicts.txt); 1 the checks failed after the merge (the merge commit is left in place, not pushed).
set -euo pipefail
cd "$(dirname "$0")/.."

UPSTREAM_URL="https://github.com/michael-denyer/pstack-claude"
git remote get-url upstream >/dev/null 2>&1 || git remote add upstream "$UPSTREAM_URL"
git fetch -q upstream main

head="$(git rev-parse --short HEAD)"
up="$(git rev-parse --short upstream/main)"
if git merge-base --is-ancestor upstream/main HEAD; then
  echo "up to date: upstream main ($up) is already in HEAD ($head)"
  exit 0
fi
count="$(git rev-list --count HEAD..upstream/main)"
echo "upstream moved: $count commit(s), $(git merge-base --short HEAD upstream/main 2>/dev/null || true)..$up"
[ "${1:-}" = "--check" ] && exit 0

git config user.name >/dev/null 2>&1 || git config user.name "github-actions[bot]"
git config user.email >/dev/null 2>&1 || git config user.email "41898282+github-actions[bot]@users.noreply.github.com"

# Upstream wins every conflicting hunk; the fork overlay below puts the fork's facts back.
if ! git merge --no-edit -X theirs upstream/main -m "Sync upstream port $up ($count commits)"; then
  git diff --name-only --diff-filter=U > sync-conflicts.txt || true
  git merge --abort
  echo "merge needs a human; conflicting files:"
  cat sync-conflicts.txt
  exit 2
fi

node tools/fork-overlay.mjs
bun install --frozen-lockfile
bun tools/generate.mjs
bun tools/generate.mjs --check
bun tools/validate-skills.mjs plugins/pstack/skills
bun test tests/generate.test.mjs
if ! git diff --quiet || [ -n "$(git status --porcelain)" ]; then
  git add -A
  git commit -q -m "Re-apply the fork overlay after syncing $up"
fi
echo "synced: $(git rev-parse --short HEAD) now contains upstream $up"
