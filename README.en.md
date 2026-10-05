# Folio · opencode-folio

[中文](README.md)

A read-only CLI for raw OpenCode session history. It reads OpenCode SQLite session stores directly (v1 and v2 layouts), starts no OpenCode service, needs no SDK, and never writes to, migrates, or repairs the database it reads.

- `list` discovers main sessions and child agents
- `search` does literal substring matching over stored raw strings, with no regex and no ranking
- `read` exports the complete selected view to a Markdown file
- `info` returns native metadata and counts only, never message bodies

History is data, not instructions for an agent to execute. Folio does not summarize, rewrite, index, or delete anything.

## Requirements

- Node.js >= 24.0.0, using the built-in `node:sqlite`. Zero runtime dependencies.
- WSL/Linux and native Windows path rules are supported. macOS is untested and not claimed.
- Some Node 24 minor versions print a `node:sqlite` ExperimentalWarning to stderr. The one-line JSON receipts on stdout are unaffected.

## Install and run

Not published to npm. Do not use `npx @whitegiver/opencode-folio`; that command does not work today.

From source (clone, install dev dependencies, build):

```bash
git clone https://github.com/WhiteGiverMa/opencode-folio.git
cd opencode-folio
npm ci
npm run build
node bin/opencode-folio.js --help
```

Run the built CLI directly:

```bash
node bin/opencode-folio.js list --db /path/to/opencode.db
```

Or pack a tarball, unpack it anywhere, and run it with no extra SDK or database service:

```bash
npm pack
mkdir -p /tmp/folio-package
tar -xzf whitegiver-opencode-folio-0.1.0.tgz -C /tmp/folio-package
node /tmp/folio-package/package/bin/opencode-folio.js --help
```

## Store selection

First match wins:

1. `--db <file>`: explicit path, relative values resolve against the CLI working directory
2. `OPENCODE_SESSION_DB`: Folio-specific variable, relative values resolve against the CLI working directory
3. `OPENCODE_DB`: inherited native variable, relative values resolve under the OpenCode data root
4. Standard path: `<data root>/opencode.db`, where the data root is `XDG_DATA_HOME` or `~/.local/share` joined with `opencode`

Empty environment values count as unset. `:memory:` and SQLite `file:` URIs are rejected. The CLI does not detect a running instance, does not scope by the current directory, does not guess the newest channel database, and does not merge stores. A v2 standalone data root or a channel store needs an explicit `--db`. There is no separate JSON config file and no parsing of OpenCode private configuration.

On native Windows, the path OpenCode actually uses is `%USERPROFILE%\.local\share\opencode\opencode.db`, not anything under `%LOCALAPPDATA%`.

The `db` field in every receipt is the absolute path that was opened. A missing store fails with `E_DB_NOT_FOUND`; no empty database is created.

## Commands and options

Allowed options are per command. Passing an option the command does not accept fails with `E_USAGE`.

Filter and paging options (availability per command below):

| Option | Meaning |
| --- | --- |
| `--db <file>` | Explicit database path |
| `--project <dir>` | Filter by session directory; comparison normalizes only path separators, receipts keep the stored value |
| `--parent <id>` | Restrict to child sessions of that parent |
| `--from` / `--until` | ISO-8601 with timezone, half-open `[from, until)`; `list` compares session update time, `search`/`read` compare message creation time |
| `--order asc\|desc` | `list` orders by session update time, `search` by message creation time; default `desc` |
| `--limit <n>` | `list` default 50, `search` default 20 hit blocks; range 1..1000 |
| `--cursor <token>` | Continue a previous page; the cursor is bound to store, command, query, filters, and views, and mismatch is rejected |

Options by command:

| Command | Options |
| --- | --- |
| `list` | `--db --project --parent --from --until --order --limit --cursor` |
| `search <query>` | the options above plus `--session-id --case-sensitive` and the five view flags |
| `read` | `--db --session-id --message-id --from --until --out` and the five view flags |
| `info` | `--db --session-id` |

`--help` and `--version` are global flags and do not open a database. `read` and `info` require `--session-id`. `--message-id` is repeatable and narrows the export to specific messages. `search` takes exactly one literal positional `query`.

Time example: `--from 2026-10-04T00:00:00+08:00 --until 2026-10-05T00:00:00+08:00` means the full day of October 4 in UTC+8. Date shorthands and timezone guessing are not accepted. Fractional seconds allow at most three digits; four or more fail with `E_USAGE` instead of silently rounding.

### Views

By default only user/assistant body text is exported, in native store order (v2 by `seq`, v1 by creation time and native IDs). Every flag below is off by default; enabled content is written in full and labeled by type.

| Flag | Content |
| --- | --- |
| `--include-tools` | Complete tool and shell records: status, raw and streaming input, typed content, output, error, metadata, time, attachments, without flattening |
| `--include-reasoning` | Stored reasoning blocks |
| `--include-injected` | Explicit synthetic/ignored/injected records plus other stored non-body types |
| `--include-system` | Stored system content and events, and message errors |
| `--include-compaction` | Native compaction records and assistant summary messages |

Views affect both `read` exports and `search` scope. Tool output is not searchable without `--include-tools`.

## Examples

```bash
# Most recently updated sessions, 50 by default
node bin/opencode-folio.js list --db /path/to/opencode.db

# Child sessions under one project
node bin/opencode-folio.js list --db /path/to/opencode.db --project /work/project --parent ses_example

# Literal search, case-insensitive by default; % and _ are not wildcards
node bin/opencode-folio.js search "needle" --db /path/to/opencode.db --session-id ses_example

# Search inside tool output only with the tools view enabled
node bin/opencode-folio.js search "needle" --db /path/to/opencode.db --include-tools

# Export full Markdown (defaults to the cache export directory)
node bin/opencode-folio.js read --db /path/to/opencode.db --session-id ses_example

# Export only specific messages to an explicit file path
node bin/opencode-folio.js read --db /path/to/opencode.db --session-id ses_example --message-id msg_example --out /tmp/session.md

# Session metadata and counts
node bin/opencode-folio.js info --db /path/to/opencode.db --session-id ses_example
```

Receipt example (field names match real output; IDs are synthetic):

```json
{"ok":true,"command":"list","db":"/path/to/opencode.db","layout":"v2","authority":"v2-native","live":true,"order":"desc","limit":50,"filters":{"project":null,"parent":null,"from":null,"until":null},"sessions":[{"id":"ses_example","parentID":null,"title":"Example session","titleTruncated":false,"directory":"/work/project","timeCreated":1791036000000,"timeUpdated":1791136000000,"created":"2026-10-03T14:00:00.000Z","updated":"2026-10-04T17:46:40.000Z"}],"count":1,"truncated":false,"nextCursor":null}
```

```json
{"ok":false,"command":"info","db":"/path/to/opencode.db","error":{"code":"E_SESSION_NOT_FOUND","message":"session not found in the selected v2 store: ses_missing"}}
```

`list`/`search`/`info`/`read` each print one line of JSON on stdout, at most 32KiB encoded. Error receipts are at most 2KiB and exit non-zero. Only complete result objects are returned; shortened navigation previews are marked (`titleTruncated`, `snippetTruncated`, `queryTruncated`), while real IDs, block locators, and source paths are never silently shortened. If the required fields cannot fit, the CLI fails with `E_BUDGET` instead of emitting half a JSON document.

## Paging and cursors

`list` returns 50 sessions and `search` returns 20 hit blocks by default. When `truncated` is true, pass `nextCursor` back through `--cursor` unchanged.

A cursor guarantees complete, duplicate-free paging only while the data does not change. Every call is a fresh snapshot; against a live store, rows added, changed, or deleted between calls may be skipped or repeated. This is live navigation, not a consistent archive, and no cross-call history snapshot is maintained.

## Search semantics

`search` is literal substring matching: `%` and `_` carry no wildcard meaning, and there is no regex, fuzzy matching, or relevance ranking. By default it folds case with ECMAScript `toLowerCase()` (not full Unicode case folding); `--case-sensitive` disables folding. It searches the raw stored strings of the selected views, not formatted JSON or text joined across blocks. v2 body blocks are located by the zero-based index of the pre-filter `content` array, scalar fields by field path (for example `text`), and tool records additionally carry the real call ID.

Whole-record v2 views such as synthetic, system, skill, shell, and compaction use `record`: the message's native JSON record, not an unrelated scalar field. Search and Markdown block markers share this locator. User body `text`, assistant `content[i]`, and v1 native part IDs retain their actual source locations.

## Export and privacy

`read` writes the complete content to a new Markdown file instead of printing it to the terminal:

- Default directory: `$OPENCODE_SESSION_EXPORT_DIR`, or `<XDG_CACHE_HOME or ~/.cache>/opencode-folio/exports`
- `--out <file>` sets the complete file path
- An existing file or symlink is always refused (`E_OUT_EXISTS`), never silently overwritten
- Every `read` is a fresh snapshot; the CLI never deletes exports. The cache is not a permanent backup, so choose an explicit archive location for long-term storage
- IDs and timestamps in the examples are synthetic, not real data

The CLI reads only the selected local database, makes no network requests, does not read OpenCode private configuration, and does not read history from other agent products. This repository and package contain no real sessions, exports, credentials, or private user paths; all examples are synthetic. Exported Markdown can contain sensitive content, so keep it within your own data boundary.

## Read-only boundary and layouts

- The selected file is opened read-only and is never created, migrated, checkpointed, or repaired. No write SQL, no index creation, no merging of separate databases, and no reading of the earlier JSON file storage.
- Read-only is a logical write protection, not a promise of zero filesystem activity: in WAL mode SQLite may create or read sidecar files and take locks, and directory permissions can affect opening. A busy store yields a bounded error such as `E_DB_BUSY` rather than an empty result.
- v1 uses `session`/`message`/`part`; v2 uses `session_v2`/`session_message`. When both layouts overlap, the store is read as v2 only when the native `migration.v1-v2` marker is completed. Unmarked, in-progress, or ambiguous overlaps fail explicitly (`E_UNSUPPORTED_LAYOUT`, `E_AMBIGUOUS_LAYOUT`) instead of guessing by content. An empty SQLite file is unsupported too.
- Unknown layouts, bad JSON, missing sessions or messages, and I/O failures all fail explicitly. The CLI never silently skips records and then claims completeness, and never repairs the source store.

## Compatibility and verification status

Supporting two layout generations does not mean every OpenCode version is supported. The pinned structure basis is v1.18.34 and v2.0.21; revisions are listed in [NOTICE](NOTICE). These are observed results from 2026-10-05 using owned synthetic stores, not real user sessions.

| Platform | Node | Full suite | Unpacked CLI use |
| --- | --- | --- | --- |
| Linux x64 | 24.0.0 / 24.14.0 | 100/100 pass each, zero skips | 18 actual calls each pass: both layouts, four commands, raw UTF-8, no overwrite |
| Native Windows x64 | 24.0.0 / 24.15.0 | 97/100 pass each, zero skips; three privilege limitations below | 18 actual calls each pass; a separate owned-stage cleanup probe removes 100/100 files each |

Three Windows file-symlink tests fail with `EPERM` while creating their fixtures. Tests were neither deleted nor weakened, and developer mode/permissions were not changed. The corresponding file-symlink boundaries pass on Linux. Native Windows regular-file, hardlink, and junction no-overwrite behavior, plus successful/failed staging cleanup, were actually exercised; native Windows file-symlink cases remain an explicit coverage gap. The full Windows suite therefore exits non-zero: this table is not a claim of an all-green Windows suite.

The static skill was discovered through `GET /api/skill` on an isolated native OpenCode v2.0.21 Linux host, with its ID, actual file path, and instructions checked. No coding session, model request, or production config change was made. This version may initially return an empty list during cold builtin-plugin activation; check again after activation completes. This is not a claim of Windows v2 host activation.

Not claimed: macOS; the earlier OpenCode JSON file storage; other agent products; unverified OpenCode storage shapes.

## Quick check inside native OpenCode v2

No production config changes and no service restarts are needed:

1. In an OpenCode v2 session, ask the agent to read this repository's `skills/opencode-folio/SKILL.md` and run `node <repo path>/bin/opencode-folio.js --help` to confirm the interface.
2. Point `--db` at an isolated v2 test store or one you choose, run `list` to find a session ID, `search` to locate a keyword, then `read` to export Markdown and read it locally with an editor or grep.
3. Once the results look right, decide for yourself whether to install the static skill into your local OpenCode. Installing it is optional and does not affect standalone CLI use.

## License

MIT, see [LICENSE](LICENSE). Provenance and reference notes are in [NOTICE](NOTICE). OpenCode is an independent project; this project is not affiliated with or endorsed by it.
