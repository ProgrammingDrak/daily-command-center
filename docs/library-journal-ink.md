# Library and shared journal Ink

`/library` provides one shelf. Journals is a permanent collection of dated vault
entries. Ordinary notebooks retain their existing InkStore namespace, notebook
IDs, page dimensions, sync endpoint, and archives. No notebook is converted into
a daily entry, moved, or deleted. `/ink` and `/ink.html` redirect to Library;
the internal `/library/notebook` editor preserves the proven Ink application.
All three entry routes retain the existing `requireAdmin` boundary.

The journal sketchbook uses the same `InkStrokes.createLiveRenderer` and
`InkCanvas.createPointerInput` as the notebook editor. This shares incremental
live strokes, bitmap lift, coalesced points, palm-first takeover, capture loss,
cancellation, finger drawing, page swipes, and post-Pencil palm suppression.
Journals retain their existing coordinates, legacy ink, text, images, and objects.

The writing controls expose ballpoint, fineliner, fountain, graphite pencil,
mechanical pencil, marker, highlighter, brush, and calligraphy. Color, width,
and nib angle use the existing device preferences. Paper options expose the
15 Ink layouts, tone, spacing, and ruled margins. Existing legacy papers keep
their appearance. Optional `papers` metadata extends the existing Markdown
marker without changing its version or rewriting untouched entries.

Journal drawing exports contain editable pages and can be imported additively.
Each journal also exports Markdown with its ink. Existing notebook import/export
continues using InkArchive; name/ID collisions create copies instead of replacing
the existing notebook. Notebook settings remain available by selecting its title
in the editor, including its existing deletion confirmation.

## Full-screen sketchbook

The Sketchbook card opens the same stage inside DCC's shared blocking overlay
(`core-ui.js`), so the canvas is never remounted. Minimize with the top-right
button, Escape, or browser Back; a backdrop click does not close it. Page
scroll locks while open and focus returns to the card. Layers fit the page
aspect and carry device-pixel backing stores, re-rendering from stroke data on
resize. Minimizing after an edit calls `onSketchMinimize`: Library flushes its
local draft, and the DCC journal editor writes the note while staying open.

## Journal text blocks

New journals open empty; the vault template supplies frontmatter only. The
text surface edits like a block editor and stores plain markdown.
`journal-blocks.js` adds markdown shortcuts (`#`, `-`, `1.`, `[]`, `>`,
```` ``` ````, `---`, `**bold**`, `` `code` ``), a "/" block menu, per-block
add and drag handles, clickable to-dos, and markdown paste. The serializer in
`completion-memories.js` writes headings, lists (nested and to-do), quotes,
code, dividers, and inline marks back to markdown.

## Durability and conflicts

`JournalDrafts` uses a separate account-scoped IndexedDB database. Each journal
row holds both the editable record and its coalesced pending mutation. A local
save is reported only after the transaction commits. Writes serialize, and a
vault acknowledgement clears only the exact revision sent. Acknowledging an
older revision advances its optimistic-lock base while retaining newer edits.

Journal changes debounce local snapshots by 700 ms. Remote sync waits eight
seconds, checks active input, verifies the current account, and uses the existing
vault `expectedHash` write contract. Retry intervals are 30 seconds, two minutes,
ten minutes, and thirty minutes. Reconnection and visibility resume work.
Journal cache warming pauses during pen input. New offline dates first resolve
the canonical daily-note endpoint; an existing nonempty entry becomes a conflict
instead of being overwritten. Conflicts keep the local draft across reload and
offer local export plus a separate read-only vault copy. Resolving their content
remains a deliberate action; the client never guesses which copy should win.

The Library shell caches static application files only, including the notebook
worker. API responses and media never enter Cache Storage. A complete shell must
install before activation. Updates wait for an explicit reload after local saves.
Previously opened journals and device-local notebooks work offline; journal cache
warming makes additional entries available. Uncached attachments require a network.

## Validation

```text
DCC_REVIEW_LIBRARY=1 PORT=8102 npm run ui-review:serve
node scripts/verify-library.mjs
node scripts/verify-journal-pencil.mjs
node scripts/verify-journal-fullscreen.mjs
node scripts/verify-journal-blocks.mjs
node --test journal-library.test.js journal-notebook.test.js ink*.test.js notebook-production-boundary.test.js
```

The Library browser script refuses fixture writes unless `/api/health` identifies
the synthetic review server. It checks actual IndexedDB, journal/vault writes,
offline reload, exact acknowledgements, separate owners, conflicts, notebook
integration, route handoff, and phone layout. The Pencil regression exercises
100 rapid strokes and a 10,000-point stroke. Desktop simulation does not replace
physical iPad/Pencil acceptance.
