# Keeping forked changes on top of upstream

Playbook for maintaining this repo's deltas against its various upstreams (git remotes like `opencode-pi-upstream`, the npm dependency `@earendil-works/pi-coding-agent`, and individually forked packages such as pi-compact-thinking / pi-hashline-edit).

## 1. Structure the fork so conflicts are rare by construction

- **Keep local code in files upstream doesn't own.** New files (e.g. `extensions/renderer/tool/hashline.ts`), vendored copies in `vendor/`, and runtime replacement of stock components (pi-cc-ui replaces `ToolExecutionComponent` via `setToolsComponentFactory` instead of patching upstream source) mean upstream can't conflict with code it doesn't know about. Conflicts only happen where both sides touch the same lines.
- **One feature = one well-formed commit.** Rebase pain scales with commit count and messiness. Small, self-contained commits replay cleanly and are easy to drop when upstream absorbs the same fix.

## 2. Pick rebase or merge — and be consistent

- **Rebase** (`git fetch <upstream> && git rebase <upstream>/main`): local commits literally sit on top; history stays a clean patch stack. Cost: history rewrites (force-push), and long-running branches re-resolve conflicts repeatedly.
- **Merge** (`git merge <upstream>/main`): no rewrites, conflicts resolved once per merge. Cost: interleaved history; harder to see "what's mine".
- **Compromise**: keep `main` tracking upstream fast-forward; maintain local work on a branch rebased periodically (`git rebase --onto <upstream>/main <last-sync>`). Tag a baseline before every sync (see `backup/pre-upstream-2.9.0` for the established pattern).

## 3. For vendored/forked files, record the fork point

- Record **package + version/commit** in the file header. Example convention already in use: `compact-thinking.ts` starts with `fork 自 pi-compact-thinking（MIT，…）` — extend it to include the exact upstream sha, e.g. `fork 自 pi-compact-thinking@a1b2c3d`.
- To sync: diff upstream's file between then and now — `git diff <old-sha> <new-sha> -- <path>` in the upstream clone (or GitHub compare) — then re-apply the labeled local patches.
- Label each local delta in a comment (e.g. `// fork patch：subagent 工具执行期间保持思考动画`) so intentional forks are distinguishable from drift at a glance.

## 4. Let the test suite be the port guard

For the npm-dependency flavor of upstream (`@earendil-works/pi-coding-agent`): bump the version, then `tsc --noEmit` and the package tests are the conflict detector. Tests exercise the real loader paths, so a breaking upstream change surfaces as a test failure instead of a silent runtime regression. Cheap, frequent small bumps beat rare big ones.

## 5. Per-sync checklist

```bash
git fetch <upstream>
git tag backup/pre-upstream-$(date +%F)                        # rollback point
git diff HEAD..<upstream>/main --stat -- packages/pi-cc-ui     # preview blast radius
git rebase <upstream>/main                                     # or merge
pnpm run check && pnpm test                                    # repo gates
```

Then regenerate derived artifacts (e.g. `npm run docs:tool-render` snapshots) in the same sync commit so the tree stays self-consistent.

## 6. Known upstream relationships in this repo

| Local surface | Upstream | Sync flavor |
| --- | --- | --- |
| Whole repo | `opencode-pi-upstream` (luongnv89/pi-extensions), `pi-accounts-upstream`, `session-recap-upstream`, … | git fetch + rebase/merge |
| pi-cc-ui stock component internals | `@earendil-works/pi-coding-agent` (npm) | version bump + typecheck + tests |
| `extensions/feature/compact-thinking.ts` | pi-compact-thinking | vendored file; header records fork point; local patches labeled inline |
| hashline tool rendering | pi-hashline-edit (upstream output formats) | textual detection only, zero runtime dep — re-verify shapes if upstream changes its format |
| pi-cc-ui (`this repo`) | `upstream` = minuque/pi-cc-extensions (git) | rebase stack on `origin` = yofriadi/pi-cc-extensions; recipe below |

## 7. Sync routine for pi-cc-ui (`this fork`)

Remotes: `origin` = `git@github.com:yofriadi/pi-cc-extensions.git` (the fork), `upstream` = minuque/pi-cc-extensions. Local work lives as a rebase stack on `main`.

```bash
# 1. See what's incoming
git fetch upstream
git log --oneline main..upstream/main     # new upstream commits
git diff main...upstream/main --stat       # files they touched

# 2. Baseline — rollback point before every sync
git tag backup/pre-upstream-$(date +%F)    # e.g. backup/pre-upstream-2026-09-13

# 3. Replay the stack on top of upstream's tip
git rebase upstream/main

# 4. Gates — tests are the semantic-merge detector
npm run typecheck && npm run lint && npm test

# 5. Publish (history was rewritten, but only the fork sees it)
git push --force-with-lease origin main
```

Notes:
- `git rebase --abort` is always safe; `git reflog` recovers any rebase step for ~90 days.
- Push `--force-with-lease`, never bare `--force` — it refuses if `origin/main` moved (e.g. another machine pushed).
- Conflicts land mostly in the diff renderer (`diff-parse.ts`, `diff-edit-render.ts`, `compact-mode.ts`, `default-mode.ts` + their tests) — the 2026-09-13 fork sync's overlap surface. 10/11 commits replayed clean; the last needed the gate-fix in d565aed.
- 2026-09-14 sync onto v0.9.1: squashed the 8 openspec process commits into the hashline feature commit (`fixup -C`) so the stack is one commit per concern. Overlap surface: `tests/tool-diff.test.ts` (both sides appended test sections — keep both), README config-sample block (upstream's `enableCustomFooter` line + fork's speed comment). Upstream's `insetComponent` width clamp auto-merged and did not alter hashline renders (snapshot diff was version-stamp + Braille frames only).
- **Never skip step 4.** Textual merges can break runtime: upstream's `PI_LINE_PATTERN` + the hashline gate merged clean but hijacked `-10    removed` as a Pi line number — only the test caught it (fixed in d565aed: any anchor-shaped row `NN#hash:` now suppresses the Pi numeric fallback diff-wide).
- `git config rerere.enabled true` records conflict resolutions and auto-reuses them on the next sync.
- When upstream absorbs one of the fork's fixes, drop that commit in `git rebase -i upstream/main` instead of re-resolving around it.
- After an upstream version bump, regenerate derived artifacts (`npm run docs:tool-render`) in the same sync commit so the tree stays self-consistent.
