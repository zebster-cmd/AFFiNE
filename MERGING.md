# Merging upstream AFFiNE into this fork

This fork (`zebster-cmd/AFFiNE`) tracks upstream `toeverything/AFFiNE`. Our
customizations are concentrated in a **narrow, mostly-additive surface** (the
copilot backend — requesty provider, doc-management tools, reasoning fix — plus
self-host deploy config). Because of that, upstream merges are cheap **if we
keep them that way.** This document is the runbook.

## The one rule

> **Merge upstream release tags into a long-lived deploy branch. Never rebase.
> Keep the modified-file surface small and additive. Certify every merge against
> upstream's own CI.**

Rebasing replays every fork commit over each new upstream base — the same
conflicts, over and over. A single merge resolves them once and records the
resolution.

## Branch model

| Branch | Role | Rule |
| --- | --- | --- |
| `canary` | Pristine mirror of upstream | **Never commit here.** Only ever fast-forward it to an upstream ref. |
| `requesty-provider-spec` | The fork's deploy line (all customizations) | All fork work lands here. Deploys trigger from pushes here. |
| `merge/vX.Y.Z` | Throwaway integration branch per upstream release | Created off the deploy line, merged back via PR. |

## Cadence

**Merge every upstream release (~monthly), not every 6 months.** We merged
v0.27.0 while only 18 commits behind and it was conflict-free. Drift is what
makes fork merges painful — small and frequent stays clean.

## The procedure

```bash
# 0. Know your conflict surface up front (the only files that can conflict)
scripts/fork-surface.sh canary requesty-provider-spec

# 1. Fast-forward the pristine mirror to the new release tag
git fetch origin --tags
git branch -f canary <upstream-tag>          # e.g. v0.28.0 ; canary has 0 fork commits, so this is a clean FF

# 2. Create the integration branch off the deploy line
git fetch fork
git checkout -B merge/vX.Y.Z fork/requesty-provider-spec

# 3. Merge the release in (inspect before committing)
git merge --no-commit --no-ff canary
#   -> resolve any conflicts (only ever in the modified-file surface from step 0)
#   -> verify fork customizations survived: requesty provider, copilot doc tools,
#      reasoning fix (grep for them in the merged tree)
git commit

# 4. Push and open a PR against the deploy line
git push -u fork merge/vX.Y.Z
gh pr create --repo zebster-cmd/AFFiNE --base requesty-provider-spec --head merge/vX.Y.Z ...
```

## Certifying the merge (the important part)

Our "Build & Test" is chronically partly-red for reasons unrelated to any merge
(see the noise list below). **Do not chase raw red.** Instead prove the merge
introduced *no new* failures by comparing to upstream's own CI for the release
commit:

```bash
# What does upstream's OWN CI fail on for this release?
gh api repos/toeverything/AFFiNE/commits/<release-sha>/check-runs --paginate \
  --jq '.check_runs[] | select(.conclusion=="failure") | .name' | sort -u
```

The merge is certified when **our red ⊆ (upstream's red ∪ the fork noise below)**.
Anything outside that set is a genuine merge regression to fix.

### Known fork CI noise (not caused by any merge)

- **Copilot E2E (all shards)** — AI backend/BYOK not configured in CI.
- **Typecheck / Check Git Status** — the i18n codegen dirty-check; a Windows
  CRLF vs Linux LF mismatch. Local `yarn affine @affine/i18n build` is a no-op.
- **Server Test (0,4)** — 2 fork tests (`copilot.e2e list context docs`,
  `database-writer-kanban move_card`).
- **CodeQL / 3-2-1 Launch** — infra stubs; `Launch` also fails upstream.
- **E2E single shards** — playwright flake; cold-cache/network on fresh branches.
  Re-run with `gh run rerun <id> --failed` (warm cache) to confirm.

## Keeping the surface small (so future merges stay cheap)

The `MODIFIED` list from `fork-surface.sh` is your only conflict risk. To hold it down:

- **Prefer new files over editing upstream ones.** Added files never conflict.
- **When you must touch an upstream file, edit append-style** (add a registry
  entry / list item; don't restructure). 3-way merge auto-resolves additive edits.
- **The fragile spot is the requesty provider integration** woven into upstream's
  provider system (`plugins/copilot/providers/*`). Isolating it behind a thin
  adapter (one new file upstream's factory calls) moves most of that surface from
  MODIFIED to ADDED.
- **Never touch upstream migrations / permission / entitlement / models.** We add
  **zero** migrations — that is exactly why the DB layer merges perfectly. Hold that line.

## Deploying a merge (destructive-migration safety)

Upstream migrations are sometimes destructive and **one-way** (e.g. v0.27.0's
legacy permission/subscription drop). We take them verbatim and add none of our
own, so upstream's are the only schema changes — applied under this guard:

1. **Back up the production DB immediately before deploy.** It is the only rollback;
   once the drop runs you cannot redeploy the previous image.
   `pg_dump -Fc -U <user> <db> > affine_pre_<version>_$(date +%F).dump`
2. Merge the PR → this pushes the deploy line → builds the self-host image → Coolify
   redeploys → migration runs on start. A failed migration aborts the deploy (it runs
   in a transaction) rather than half-applying.
3. Verify login + a workspace loads before considering the deploy done.
