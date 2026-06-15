# FIA Trainer mode — implementation notes (issue #180)

**Status:** Mode authored and registered to **production as a draft** (`published: false`).
Verified via round-trip `GET` and a live admin-origin smoke test. Publish (`published: true`)
when ready for the demo.

## What this is

`fia-trainer` is a new, **trainer-facing** prompt mode: a CBBT Training Assistant for the
people who _facilitate_ the three Church-Based Bible Translation courses. It is distinct from
the team-facing `fia-coach` (which walks a translation team through the six FIA steps on a
passage). `fia-trainer` helps trainers:

- answer questions about the CBBT curriculum (Courses 1–3),
- build customized, day-by-day training schedules,
- answer questions through a defined knowledge hierarchy,
- adapt for **hearing and deaf** training contexts,
- track trainer/network context in structured persistent memory,
- turn schedules/handouts into paste-ready documents.

The mode document lives at [`docs/modes/fia-trainer.mode.md`](../modes/fia-trainer.mode.md).

## Approach (and why)

Shipped as **pure configuration** — a single markdown `document` (the post-#200 mode shape),
no worker code changes, no new service. The document carries the seven prompt slots plus an
embedded **curriculum digest** of all three courses (module/activity index + concise summaries

- Google-Doc links) under _Teaching Methodology_.

Why a digest rather than an MCP server or live document fetch, for now:

- The course manuals are ~78 KB of prose each (~237 KB total) — too large for the 64,000-char
  mode-document limit, but a **digest** (~15 KB for all three) fits comfortably.
- `execute_code` runs in a QuickJS sandbox with **no network/fetch** — only registered MCP
  tools — so the AI cannot fetch the Google Docs at query time (issue #180 "Option C" is not
  possible without new infrastructure). The mode therefore **links trainers to the Google Doc**
  for full/verbatim text instead of fetching or fabricating it.
- There is **no general document-generation tool** in the worker (the only artifact tool is
  `generate_scripture_pdf`). The mode therefore produces **paste-ready Markdown** for Google
  Docs/Word and is explicit that it cannot attach a downloadable file.

## Knowledge hierarchy (Tool Guidance slot)

1. **FIA methodology** → the existing `fia` MCP server (already registered for `unfoldingWord`).
2. **CBBT curriculum** → the embedded digest; link out to the Google Doc for full text.
3. **Subject-area docs** → not yet available; acknowledged rather than invented.
4. **Network** → suggest connecting with the CBBT trainer network.

The mode states which level it answered from, and is instructed never to fabricate curriculum
content, module names, or activities.

## Registration

Registered with the admin API (super-admin `ENGINE_API_KEY`):

```
PUT /api/v1/admin/orgs/unfoldingWord/modes/fia-trainer
{ "name": "fia-trainer", "label": "FIA Trainer",
  "description": "...", "published": false,
  "document": "<contents of docs/modes/fia-trainer.mode.md>" }
```

To make it available to non-admin users for the demo, re-PUT the same body with
`"published": true` (drafts are reachable only from admin-origin chat).

## Verification

- **Round-trip `GET`:** stored as a `document` (no `originalSlots`), `format: markdown`, all
  seven slot headers present, 27,836 chars (< 64,000).
- **Live admin-origin smoke test** (throwaway user, deleted afterward):
  - _Curriculum Q&A_ — listed Course 2 modules by name/number from the digest, linked the
    Google Doc, and stated its source ("from the CBBT curriculum digest").
  - _Schedule generation_ — produced a 5-day, day-by-day Course 1 schedule with time estimates.
  - _Deaf-context adaptation_ — visual-first throughout (SLTT video, sightlines, interpreter
    notes, FIA Step 6 → "Signing the Word", chose Module 8's visual/oral option).
  - _Document creation_ — returned paste-ready Markdown and was explicit it cannot attach a file.
  - _Memory_ — wrote structured sections (Trainer Profile / Training History / Preferences and
    Adaptations / Network Notes).

## Acceptance criteria (issue #180)

All eight met, with one scoped deferral: criterion 3 (course content accessible) is met for
**structure and summaries with module-level citation**; **verbatim full-text Q&A** is deferred
to the growth path below (the mode links the source Doc instead).

## Growth path (post-demo, not in this PR)

- **Verbatim AI access:** a CBBT-content MCP server, or extend the existing FIA MCP worker
  (reuse its hosting/auth) with `get_course_outline` / `search_curriculum` / `get_module`, or a
  generic fetch/Docs MCP tool (which would also enable issue #180 "Option C"). Then flip
  Tool-Guidance level 2 from "link out" to "retrieve and cite."
- **Real downloadable documents:** a docx/pptx generator modeled on `generate_scripture_pdf`
  plus the existing R2/`attachments` delivery path.

## Out of scope (per issue #180)

Communication-platform features (versioning/ideas/updates/connect), real-time network feed,
automated document versioning.
