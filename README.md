# canbox-catalog

Data production repository for the Canbox APP catalog: automatically discovers, verifies and scores GitHub repositories tagged with the `canbox-app` topic, then publishes the results to [canbox-catalog-data](https://github.com/canbox-io/canbox-catalog-data) for the website and manager to consume.

[简体中文](./README_zh-CN.md)

## Purpose

canbox-catalog provides no UI and does not participate in downloading or running APPs. It does one thing: **turn Canbox APP repositories scattered across GitHub into a continuously maintained, frontend-consumable catalog dataset**.

Its responsibilities are:

- Discover repositories tagged with the `canbox-app` topic through the GitHub Search API, with continuous incremental scanning
- Fetch and validate `.canbox-app` and `package.json` inside each repository
- Compute a 0–100 risk score from repository availability, configuration completeness, update activity and consecutive failures
- Maintain the APP state machine (active / warning / critical / stale / removed)
- Filter, transform, sort and shard the data into platform-neutral `catalog.json` and `catalogs/shard-*.json`
- Write all artifacts to the separate `canbox-catalog-data` repository and commit them automatically through GitHub Actions

The data format is decoupled from GitHub: platform-specific constants live in `scripts/github/adapter.js`, shared logic lives in `scripts/common/`, and adding another platform such as Gitee only requires a new adapter directory.

## Position In The Ecosystem

```text
GitHub repositories (topic: canbox-app)
        │  GitHub Search API
        ▼
  canbox-catalog (GitHub Actions)
  discover → verify / reconcile → assemble
        │  auto commit
        ▼
  canbox-catalog-data (catalog.json + shards)
        │  raw.githubusercontent.com
        ├──────────────► canbox-pages (website APP center)
        └──────────────► canbox-manager (repository page)
```

canbox-catalog is the **data producer**, `canbox-catalog-data` is the **data store**, and canbox-pages / canbox-manager are **data consumers**. They are decoupled through public raw URLs and require no shared deployment.

## Data Flow And Artifacts

```text
discover / reconcile / rediscover
        │  write app_lists_shards/shard-XXX.json
        ▼
verify (round-robin shard refresh)
        │  update the same shards
        ▼
assemble
        │  filter + transform + sort + shard
        ▼
catalog.json + catalogs/shard-XXX.json
```

All artifacts live at the root of the `canbox-catalog-data` repository:

| File | Content | Main consumers |
| --- | --- | --- |
| `catalog.json` | Display index: schemaVersion, totalApps, shard list, filter rules | canbox-pages, canbox-manager |
| `catalogs/shard-XXX.json` | Display shards, 100 APPs each, already converted to platform-neutral format | canbox-pages, canbox-manager |
| `app_lists.json` | Raw data index: shard list and `nextShardToVerify` cursor | canbox-catalog itself |
| `app_lists_shards/shard-XXX.json` | Raw data shards, 200 APPs each, including verification state and score | canbox-catalog itself |
| `discovery_cursor.json` | Discovery cursor: `lastRun`, `firstRun`, total discovered count and the last 100 history entries | canbox-catalog itself |
| `.{action}-result.json` | Trigger marker: number of new APPs, used by CI to decide whether to trigger assemble | GitHub Actions |

Consumer URL examples:

```text
https://raw.githubusercontent.com/canbox-io/canbox-catalog-data/main/catalog.json
https://raw.githubusercontent.com/canbox-io/canbox-catalog-data/main/catalogs/shard-001.json
```

## GitHub Actions Jobs

| Workflow | Trigger | Purpose |
| --- | --- | --- |
| `discover.yml` | Hourly (`0 * * * *`) + manual | Incrementally discover newly created APP repositories; the first run performs a full scan |
| `verify.yml` | Every 2 hours (`0 */2 * * *`) + manual | Round-robin verification of **one** shard: refresh metadata, detect renames, re-validate, recompute score |
| `reconcile.yml` | Every Monday 02:00 UTC + manual | Full topic reconciliation, catching repositories that added the topic long after creation |
| `rediscover.yml` | Manual only | Scan repositories created before `firstRun` to backfill anything the first full scan missed |
| `assemble.yml` | Dispatched by upstream + manual | Filter, transform, sort and shard into `catalog.json` and `catalogs/*` |

Details and relationships:

- **discover**: reads `discovery_cursor.json`. Without `lastRun` it pages through a full `topic:canbox-app` scan; otherwise it queries only `created:{lastRun-30min}..{now}`. The 30-minute lookback tolerates Actions scheduling delays — scanning extra is preferred, and shard-level deduplication is the safety net. The new count is written to `.discover-result.json` and triggers assemble when greater than 0.
- **verify**: reads `nextShardToVerify` from `app_lists.json`, processes exactly one shard per run, and checks each APP for repository availability (404 / 403), owner/repo renames (301 redirects), refreshes stars/forks/lastCommit, re-fetches `.canbox-app` and `package.json`, and recomputes score and status. The cursor then advances and wraps around. Round-robin sharding prevents exhausting the GitHub API quota in one run.
- **reconcile**: queries all currently tagged repositories without a `created` filter, diffs them against existing shards by repository ID and repository URL, and only adds the missing ones without refreshing. It covers the blind spot where a repository existed long before gaining the topic and can never be found by creation-time incremental scans.
- **rediscover**: scans only `created:<=firstRun` to backfill early repositories missed by the first full scan due to API throttling or the 1000-result limit. It also only adds missing entries.
- **assemble**: reads every raw shard, filters by status and score, converts to display format, sorts by stars descending, writes 100 APPs per file into `catalogs/`, rebuilds the index and removes obsolete shards. It uses `concurrency: catalog-assemble`, so simultaneous upstream triggers run serially instead of overwriting each other.

## Discovery Paths

Every discovery path ultimately uses the same GitHub Search query, `topic:canbox-app`; only the time constraint and trigger differ.

| Path | Query | Coverage | Trigger |
| --- | --- | --- | --- |
| First full scan | `topic:canbox-app` | All currently tagged repositories | discover when the cursor has no `lastRun` |
| Incremental discovery | `topic:canbox-app created:{since..now}` | Repositories created from 30 minutes before the last run to now | Hourly discover |
| Topic reconciliation | `topic:canbox-app` | All current repositories, diffed against existing data | Weekly reconcile |
| Early backfill | `topic:canbox-app created:<=firstRun` | Repositories created before `firstRun` | Manual rediscover |

All three write paths share the same deduplication and persistence logic:

1. Derive the APP ID from the repository URL, e.g. `https://github.com/acme/notes` → `com.github.acme.notes`
2. Deduplicate primarily by GitHub repository ID (`githubRepoId`), falling back to repository URL (`repo`)
3. Append to the last non-full raw shard; each shard holds up to 200 APPs. When full, a new `shard-XXX.json` is created and `app_lists.json` is updated

The GitHub Search API returns at most 1000 results per query. Full-scan jobs print a warning when they hit that limit; once the catalog exceeds 1000 repositories, queries must be split by time windows.

## APP Discovery Example

Consider a developer creating `https://github.com/acme/notes`:

1. **Tagging**: the developer adds the `canbox-app` topic in the repository settings.
2. **Discovery**: the next hourly `discover.yml` run has a `created` window covering this repository, and the Search API returns it.
3. **Parsing**: the script generates the APP ID `com.github.acme.notes` and fetches `.canbox-app` and `package.json` through the Contents API (missing files are tolerated as 404 and do not abort the batch).
4. **Validation**:
   - `.canbox-app` must contain `type` with a value of `native` / `web` / `pwa`; `native` additionally requires `electron.range`
   - `package.json` must contain `name`, `version` and `main`
   - `category` is optional; if present but outside the nine-value enum, it records a warning and deducts points without blocking
5. **Score and status**: starts at 100 and deducts for inaccessible repository, missing configuration, no update in 180 days, consecutive failures and category warnings. When both `.canbox-app` and `package.json` pass, the status is set directly to `active`.
6. **Persistence**: the APP is appended to `app_lists_shards/shard-001.json`, the cursor and history are updated, and `.discover-result.json` is written with `newCount=1`.
7. **Assembly trigger**: when the new count is greater than 0, `discover` commits the data repository and dispatches `assemble.yml`.
8. **Display data generation**: assemble keeps only `active` / `warning` / `critical` APPs with a score of at least 30, converts them to fields such as `id`, `name`, `description`, `logo`, `stars`, `riskLevel` and `showDownload`, writes them sorted by stars into `catalogs/shard-001.json`, and rebuilds `catalog.json`.
9. **Consumption**: canbox-pages and canbox-manager fetch the raw URLs, show the APP in the APP center, and allow download.

Two other typical scenarios:

- **An existing repository later gains the topic**: incremental scans only look at `created` and can never find it; the weekly `reconcile` diff catches it.
- **A repository is renamed**: while checking the repository, `verify` detects that the actual owner/repo no longer matches the record, updates the APP ID and repository URL, and subsequent checks use the new address.

## State Machine And Scoring

| Status | Entry condition | Included in catalog |
| --- | --- | --- |
| `unknown` | Just discovered, no successful validation yet | No |
| `active` | Configuration validation passes | Yes |
| `warning` | 3–4 consecutive failures | Yes |
| `critical` | 5 or more consecutive failures | Yes (when score ≥ 30) |
| `stale` | critical for more than 30 days | No |
| `removed` | critical for more than 365 days | No |

Scoring rules (starts at 100; deductions are summed and clamped to 0–100):

| Deduction | Points |
| --- | --- |
| Repository 404 | −40 |
| Repository private (403) | −30 |
| `.canbox-app` validation failed | −20 |
| `package.json` validation failed | −10 |
| No commit record or no update for over 180 days | −10 |
| Consecutive failures | −2 each, capped at −20 |
| Invalid `category` warning | −10 |

Catalog filter rules: include `active` / `warning` / `critical`, exclude `stale` / `removed`, and require a score of at least 30.

## Repository Structure

```text
canbox-catalog/
├── .github/workflows/       # 5 GitHub Actions workflows
│   ├── discover.yml
│   ├── verify.yml
│   ├── reconcile.yml
│   ├── rediscover.yml
│   └── assemble.yml
├── scripts/
│   ├── common/              # platform-neutral logic
│   │   ├── assemble.js      # filter, transform, shard, build index
│   │   ├── category.js      # nine-value category enum and normalization
│   │   ├── constants.js     # shard sizes, statuses, filter rules, schema version
│   │   ├── index.js         # unified export for shared modules
│   │   ├── paths.js         # CLI argument and data directory resolution
│   │   ├── platform-adapter.js  # adapter registry, APP ID, display conversion
│   │   ├── scoring.js       # scoring, state machine, filtering, error history
│   │   ├── storage.js       # JSON I/O, shards, cursor, trigger markers
│   │   └── validate.js      # .canbox-app and package.json validation
│   └── github/              # GitHub platform implementation
│       ├── adapter.js       # idPrefix, host patterns, raw URL construction
│       ├── helpers.js       # Octokit wrapper, Search API, file fetch, repo check
│       ├── discover.js
│       ├── verify.js
│       ├── reconcile.js
│       ├── rediscover.js
│       └── assemble.js
├── package.json
└── README.md / README_zh-CN.md
```

## Local Usage

```bash
npm install
```

Scripts take the platform and data repository path as arguments:

```bash
node scripts/github/discover.js --platform=github --data-repo-root=../canbox-catalog-data
node scripts/github/verify.js --platform=github --shard=1 --data-repo-root=../canbox-catalog-data
node scripts/github/reconcile.js --platform=github --data-repo-root=../canbox-catalog-data
node scripts/github/assemble.js --platform=github --data-repo-root=../canbox-catalog-data
```

The corresponding npm scripts are defined in `package.json`:

| Command | Description |
| --- | --- |
| `npm run catalog:discover` | Incremental discovery (full scan on the first run) |
| `npm run catalog:verify` | Verify a specific shard |
| `npm run catalog:reconcile` | Full topic reconciliation |
| `npm run catalog:rediscover` | Backfill repositories created before `firstRun` |
| `npm run catalog:assemble` | Generate display data |

Environment variables:

| Variable | Description |
| --- | --- |
| `CATALOG_GITHUB_TOKEN` | Preferred GitHub token |
| `GITHUB_TOKEN` | Fallback token; the workflow token is used in CI |

When `--data-repo-root` is omitted, scripts fall back to the in-repo `data/github` directory (ignored by `.gitignore`), which is intended for local debugging only. Production runs must point to a cloned `canbox-catalog-data` directory.

## Related Repositories

- [canbox-catalog-data](https://github.com/canbox-io/canbox-catalog-data): catalog artifact storage
- [canbox-pages](https://github.com/canbox-io/canbox-pages): website and APP center
- [canbox-manager](https://github.com/canbox-io/canbox-manager): desktop manager consuming the catalog on its repository page
- [canbox-core](https://github.com/canbox-io/canbox-core): shared runtime injection module
