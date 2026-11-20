# CBBT Mentoring mode — implementation notes (issue #180)

**Status:** Mode authored and **published** on production (`cbbt-mentoring`, `published: true`).
Verified via round-trip `GET` and a live admin-origin smoke test.

> **Naming.** This mode was prototyped as `fia-trainer`, briefly published as `fia-mentoring`,
> and is now **`cbbt-mentoring`** (label "CBBT Mentoring", switch command `#cbbt-mentoring`).
> The existing team-facing `fia-coach` mode is being renamed to **`fia-drafting`**
> ("FIA Drafting", `#fia-drafting`). To avoid dropping users mid-flight, `fia-coach` and
> `fia-drafting` currently coexist as clones; the alias/migration that retires `fia-coach`
> will be handled separately by the engineering team. This mode's cross-references already
> point to `#fia-drafting`.

## What this is

`cbbt-mentoring` is a **trainer-facing** CBBT Training Assistant — for the people who
_facilitate_ the three Church-Based Bible Translation courses. It is distinct from the
team-facing `fia-drafting` (which walks a translation team through the six FIA steps on a
passage). `cbbt-mentoring` helps trainers:

- answer questions about the CBBT curriculum (Courses 1–3),
- build customized, day-by-day training schedules,
- answer questions through a defined knowledge hierarchy,
- adapt for **hearing and deaf** training contexts,
- track trainer/network context in structured persistent memory,
- turn schedules/handouts into paste-ready documents.

The mode document lives at [`docs/modes/cbbt-mentoring.mode.md`](../modes/cbbt-mentoring.mode.md).

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
PUT /api/v1/admin/orgs/unfoldingWord/modes/cbbt-mentoring
{ "name": "cbbt-mentoring", "label": "CBBT Mentoring",
  "description": "...", "published": true,
  "document": "<contents of docs/modes/cbbt-mentoring.mode.md>" }
```

## Verification

- **Round-trip `GET`:** stored as a `document` (no `originalSlots`), `format: markdown`, all
  seven slot headers present, well under the 64,000-char limit.
- **Live admin-origin smoke test** (throwaway user, deleted afterward): curriculum Q&A (modules
  cited by name/number, Google-Doc link, source-level transparency), a 5-day deaf-community
  Course 1 schedule, paste-ready document output (with the honesty caveat), and structured
  memory all worked.

## Acceptance criteria (issue #180)

All eight met, with one scoped deferral: verbatim full-text Q&A (criterion 3) is deferred to the
growth path (the mode links the source Doc instead).

## Growth path (post-demo, not in this PR)

- **Verbatim AI access:** a CBBT-content MCP server, or extend the existing FIA MCP worker with
  `get_course_outline` / `search_curriculum` / `get_module`, or a generic fetch/Docs MCP tool
  (which would also enable issue #180 "Option C"). Then flip Tool-Guidance level 2 from
  "link out" to "retrieve and cite."
- **Real downloadable documents:** a docx/pptx generator modeled on `generate_scripture_pdf`
  plus the existing R2/`attachments` delivery path.
- **`fia-coach` → `fia-drafting` migration:** retire the `fia-coach` slug via alias/migration so
  currently-assigned users are not dropped.

## Out of scope (per issue #180)

Communication-platform features (versioning/ideas/updates/connect), real-time network feed,
automated document versioning.
