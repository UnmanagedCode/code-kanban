#!/usr/bin/env bash
# Symlink node_modules from the parent repo into this worktree.
#
# Reusing the parent checkout's already-installed dependencies avoids a slow
# (and, on flaky-DNS hosts, unreliable) `npm install` in every new worktree.
#
# Run by code-conductor after creating a worktree, with cwd in the new
# worktree. CC_PARENT_PATH is set by the orchestrator to the parent checkout's
# absolute path (see code-conductor src/worktrees.ts).

set -e

# Share the parent checkout's .wiki with this worktree. .wiki is kept out of
# git (.git/info/exclude), so every worktree links to the one real copy.
# Runs before the node_modules logic, which exits early on some paths. Never
# fails the hook: called in an `||` context, so `set -e` does not apply inside.
link_wiki() {
    [ -n "${CC_PARENT_PATH}" ] || return 0
    local src="${CC_PARENT_PATH}/.wiki"
    [ -d "$src" ] || return 0
    if [ -e .wiki ] || [ -L .wiki ]; then
        return 0
    fi
    ln -s "$src" .wiki || return 1
    echo "[post-worktree-create] Symlinked .wiki from ${src}."
}
link_wiki || echo "[post-worktree-create] WARNING: could not symlink .wiki; continuing." >&2

if [ -e node_modules ] || [ -L node_modules ]; then
    echo "[post-worktree-create] node_modules already exists - skipping symlink."
    exit 0
fi

if [ -z "${CC_PARENT_PATH}" ]; then
    echo "[post-worktree-create] WARNING: CC_PARENT_PATH unset; skipping node_modules symlink." >&2
    exit 0
fi

PARENT_NM="${CC_PARENT_PATH}/node_modules"

if [ ! -d "$PARENT_NM" ]; then
    echo "[post-worktree-create] WARNING: ${PARENT_NM} not found; skipping node_modules symlink." >&2
    exit 0
fi

# A missing link is recoverable with `npm install`, so a failed symlink must not
# fail worktree creation (set -e would otherwise exit 1 with no clear message).
if ln -s "$PARENT_NM" node_modules; then
    echo "[post-worktree-create] Symlinked node_modules from ${PARENT_NM}."
else
    echo "[post-worktree-create] WARNING: could not symlink node_modules; continuing." >&2
fi
