# Meeting → GitHub Issues (central, multi-repo)

One repo that posts issues into **any unfoldingWord repo** you choose at run
time. Maintain the toolkit in a single place; fan out to all your repos with
one shared token.

Use this variant when you want this to work across several repos (you do:
4–10, all in unfoldingWord). For a single repo, the simpler per-repo variant
is fine.

## Layout

```
<this central repo>/
├── .github/workflows/post-issues.yml   ← the workflow (repo root)
├── post-issues.sh                       ← generic poster
├── issues/*.md                          ← the issues for the current batch
└── README.md
```

Pick any repo to be the "central" one — an existing `ops`/`tooling` repo, or
a new repo just for this (e.g. `unfoldingWord/meeting-issues`).

## One-time setup

### 1. Create the central repo and add these files
Commit `post-issues.sh`, `issues/`, `README.md`, and
`.github/workflows/post-issues.yml` (the workflow MUST be at the repo root,
under `.github/workflows/`).

### 2. Create ONE fine-grained personal access token
GitHub → **Settings → Developer settings → Fine-grained tokens → Generate new token**.
- **Resource owner:** `unfoldingWord`
- **Repository access:** "All repositories" (covers current + future repos),
  or select just the ones you want.
- **Permissions:** Repository permissions → **Issues: Read and write**.
  (That's the only one needed. Metadata read is added automatically.)
- **Expiration:** set a sensible date (e.g. 90 days) and renew. Avoid "no
  expiration".

> Org note: fine-grained tokens against an org may need org approval. If the
> token shows as "pending" for unfoldingWord, an org owner must approve it
> under the org's token-access policy. If your org hasn't enabled
> fine-grained tokens, a classic PAT with `repo` scope works too, but it's
> broader access — prefer fine-grained.

### 3. Store the token as a secret in the central repo
Central repo → **Settings → Secrets and variables → Actions → New repository
secret**.
- **Name:** `ISSUE_POSTER_TOKEN` (exact — the workflow looks for this)
- **Value:** the token

The token lives only here, as one secret. None of your other repos need any
setup.

## Each run

1. Central repo → **Actions** tab → **Post meeting issues (central)** →
   **Run workflow**.
2. Inputs:
   - **target_repo** — which repo to post into, e.g.
     `unfoldingWord/bt-servant-worker`.
   - **marker** — unique name for this batch, e.g. `sync-2026-07-01`.
   - **dry_run** — `true` to preview, `false` to post.
   - **labels_on** — `true` only if those labels exist in the *target* repo.
3. Run it. The log shows created issue URLs and a `created / skipped /
   failed` tally.

Re-running is safe: the marker makes it skip issues already posted to that
target repo, so a failed run is fixed by running again.

## New batch / new meeting

Edit or replace `issues/*.md`, commit, push, then run the workflow with a
fresh `marker` and the right `target_repo`. Loop: **edit files → push → Run
workflow.**

## Issue file format

Front matter between `---` lines, then a markdown body:

```markdown
---
title: Concise issue title
labels: P0, right-diamond
---
## Problem
...

## Scope
- [ ] subtask
```

- `title` required (quote it if it contains a colon).
- `labels` optional, comma-separated; OFF unless `labels_on` is true.
- The filename slug is the dedup key (combined with `marker`).

## Why a token here (when the single-repo version needed none)

An Action's built-in `GITHUB_TOKEN` can only write to *its own* repo. To post
into *other* repos from one central place, you need a credential that spans
them — that's the one fine-grained PAT. It's a single secret in a single
repo, scoped to Issues-write on unfoldingWord. That's the trade for central
maintenance across many repos.

## Security notes

- Fine-grained, Issues-write only, org-scoped, with an expiry. Least
  privilege for the job.
- The token is a repo secret — never printed in logs, never in the code.
- Anyone with write access to the central repo can trigger runs (and thus use
  the token to file issues). Keep the central repo's access list tight.
- Rotate the token on its expiry; update the one secret.

## Requirements
- The central repo with Actions enabled.
- The `ISSUE_POSTER_TOKEN` secret set as above.
- No local tooling needed — everything runs on GitHub.
