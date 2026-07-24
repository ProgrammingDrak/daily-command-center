# Mycelium vault — decade-scale notes (Phase B5)

The Mycelium tab holds VaultStore's index fully in RAM and (re)builds a pure-JS
MiniSearch index at boot. This is deliberately simple and fast for a personal
vault's realistic size, with a sentinel + documented levers for the day it grows.

## What ships now (B5)

- **Boot cache** (`DATA_DIR/.vault-index.json`, `version: 2`): caches each node's
  parsed frontmatter + outlinks keyed by `mtime`+`size`. On the next boot an
  unchanged file skips gray-matter YAML parsing and wikilink extraction — the body
  is split out with a cheap regex proven byte-identical to `gray-matter`. A
  parse-error node or a v1 cache is treated as a miss and re-parsed. The cache is
  a pure optimization: delete it and the vault rebuilds correctly.
- **Search**: two MiniSearch indexes (main + sensitive). The sensitive index is
  queried only for a PIN-unlocked session. Snippets read the live body, so the
  index stores only `title`+`type`. Incremental add/remove rides the same mutation
  sites as the backlink/facet indexes.
- **Pagination**: `GET /api/vault/nodes?limit=&offset=` returns a paged envelope;
  `GET /api/vault/search` paginates and the results dropdown infinite-scrolls.
- **Sentinel**: `GET /api/vault/status.scale` reports node count, working-tree
  bytes (a boot snapshot, `.git` excluded), boot ms, and a `warn` flag when the
  vault crosses **20k nodes** or a **3 GB** working tree. The status summary shows
  `⚠️ scale` with the reason when it trips.

## Measured (synthetic corpus, local SSD)

| Nodes  | Cold boot | Warm boot (cache) | Avg search |
|--------|-----------|-------------------|------------|
| 12,000 | ~1.4 s    | ~1.1 s            | ~4 ms      |

Search stays far under the 100 ms budget; boot is well under 2 s at 12k. The cache
saves ~20% at this size (parsing is a minority of boot; `readFile` + index build
dominate). The cache's value grows as parsing costs rise with node size.

## Year-5 levers (pull when the sentinel warns — not before)

These are intentionally deferred. Reach for them in order:

1. **Explorer lazy-loads folders.** The tree currently fetches every node summary
   to build the folder hierarchy. At ~20k+ nodes, load one folder level at a time
   (`/api/vault/nodes` already paginates) and expand children on demand. This is
   the first thing to do — it removes the largest single client payload.
2. **`git clone --filter=blob:none` (partial clone)** instead of the current
   shallow `--depth 1`. Keeps history reachable without downloading old blobs;
   pairs well with a growing media tree. See `sync-manager.js` `_ensureRepo`.
3. **Sparse checkout.** If whole domains (e.g. archived years) are rarely opened,
   `git sparse-checkout set` the active subtree so the working tree — and the
   3 GB sentinel — stays bounded. Media already lives on LFS/R2/cold tiers.
4. **Cache the mtime-sorted view behind `/recent` + `/nodes`.** These call
   `VaultStore.list()`, which allocates + sorts the whole node set per request
   (the same O(n)+sort shape `/ontology` already has). Pagination bounds the
   *payload*, not the server cost: infinite-scrolling `/recent` re-sorts the full
   corpus per page (~O(n²/limit) across a full scroll). At 20k+ this warrants a
   single mtime-ordered view cached per mutation generation (invalidated on
   `vault-changed`) that paged reads slice. Deferred now because it isn't a
   keystroke-hot path and the cost matches the existing endpoints. (`unlinked()`
   similarly lowercases each candidate body per note-open — bounded by the 20-hit
   cap, same lazy-cache fix if it ever shows up in a profile.)
5. **Search index sharding / persistence.** MiniSearch can `toJSON()`/`loadJSON()`;
   persist the built index alongside `.vault-index.json` to skip the rebuild, or
   shard by year and query only the shards a date-filtered request needs.
6. **Move the index out of process.** Only if the vault becomes genuinely huge:
   a pure-JS embedded store (still no native modules) or an external service. This
   is a future, evidenced decision — `better-sqlite3` was explicitly dropped in the
   2026-07-22 adversarial review; do not reintroduce a native module to "fix" scale
   without numbers that justify it.

## Invariant

Whatever the lever, the sensitive-dir rule is load-bearing: locked git-crypt
ciphertext is never indexed (magic-byte guard), and sensitive nodes live in a
separate index queried only when the session is PIN-unlocked.
