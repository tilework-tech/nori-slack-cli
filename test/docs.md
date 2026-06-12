# Noridoc: test

Path: @/test

### Overview
- Unit tests for `parseArgs`, `formatError`, `mergePages`, and method metadata coverage, plus integration tests that invoke the CLI as a subprocess (direct mode against the real Slack API, proxy mode against a local fake broker), plus an end-to-end packaging test that installs the npm tarball
- Uses Vitest as the test runner; integration tests in `cli.test.ts` and `proxy-mode.test.ts` use `tsx` to run TypeScript source directly via the shared helpers in [helpers.ts](helpers.ts), `build.test.ts` compiles via `tsc` and runs the built `dist/index.js` artifact, and `packaging.test.ts` runs `npm pack` and installs the tarball into a tmpdir

### How it fits into the larger codebase
- Tests cover the pure utility modules in [@/src](../src/): argument parsing, error formatting, pagination merging, and method metadata
- Integration tests in [cli.test.ts](cli.test.ts) and [proxy-mode.test.ts](proxy-mode.test.ts) exercise the full CLI binary by spawning `npx tsx src/index.ts` as a child process, verifying end-to-end behavior including exit codes, stdout JSON structure, and stderr output
- [proxy-mode.test.ts](proxy-mode.test.ts) is the blackbox verification of the proxy transport in [@/src/transport.ts](../src/transport.ts) -- it pins the wire contract that the Nori Sessions broker depends on
- [packaging.test.ts](packaging.test.ts) closes the loop on the npm distribution path documented in [@/docs.md](../docs.md) -- it is the guard against the `0.1.0` regression where `dist/` was missing from the published tarball
- All tests run on every PR and on every push to `main` via the workflows in [@/.github/workflows](../.github/workflows/)
- The test directory is excluded from TypeScript compilation via `tsconfig.json`

### Core Implementation

**`parse-args.test.ts`** -- Tests the argument parser in isolation:
- Verifies `--key value` pairs, `--key=value` syntax, and standalone boolean flags
- Confirms kebab-to-snake conversion (`--unfurl-links` becomes `unfurl_links`)
- Validates type coercion: booleans, numbers, JSON arrays/objects, and preservation of leading-zero strings

**`errors.test.ts`** -- Tests error formatting for each Slack error category:
- Platform errors (e.g., `channel_not_found`) produce suggestions referencing relevant API methods
- Rate limit errors include retry timing
- Network errors surface the underlying error message
- Missing-credential (`no_token`) errors suggest setting `SLACK_BOT_TOKEN`; proxy-specific error mapping is covered end-to-end in [proxy-mode.test.ts](proxy-mode.test.ts)

**`paginate.test.ts`** -- Unit tests for the `mergePages` function:
- Uses a `toAsyncIterable` helper to create async iterables from arrays of page objects
- Verifies array concatenation across pages, preservation of metadata from the last page, handling of empty arrays and single pages

**`method-metadata.test.ts`** -- Coverage guard for method metadata:
- Asserts that `getMethodMetadata` returns a curated (non-fallback) description for every method in `KNOWN_METHODS`, ensuring new methods added to the catalog also get metadata entries

**`helpers.ts`** -- Shared infrastructure for the subprocess integration tests:
- `runCli` spawns the CLI with `execFile` (10-second timeout) and captures stdout/stderr/exit code; `runCliWithStdin` uses `spawn` with piped stdin for `--json-input` tests
- Both build a hermetic environment: `SLACK_BOT_TOKEN`, `NORI_SLACK_PROXY_URL`, and `NORI_SLACK_CONTEXT_TOKEN` are stripped from the inherited process env before per-test overrides are applied. This exists because Nori session machines export the proxy vars, which would otherwise silently flip tests into proxy mode
- `startFakeBroker()` starts a real local `http.Server` that records every request (URL, headers, parsed JSON body) and serves queued responses (defaulting to `{ok: true}`); its URL includes a path prefix so tests can verify URL joining

**`cli.test.ts`** -- Direct-mode integration tests that run the CLI as a subprocess:
- Uses the shared `runCli`/`runCliWithStdin` helpers from [helpers.ts](helpers.ts)
- Tests use fake tokens (`xoxb-fake-token`) which produce real Slack `invalid_auth` errors, proving the full request path works without needing a valid token
- Validates: no-args usage error, missing token error, `list-methods` output, structured JSON for API failures, stdin JSON input, source path in errors, suggestion text presence, `--paginate` flag acceptance, `--dry-run` behavior, `describe` command behavior, and `list-methods` filtering/description options
- Describe tests cover: known method metadata output (required/optional params, docs URL), fallback for unknown methods (`known: false`), pagination support flags, deprecation notices, missing argument error, and spot-checks across newly-added namespaces (e.g., `dnd.setSnooze`, `usergroups.create`, `views.open`, `team.info`)
- `list-methods` tests cover: `--namespace` filtering (verifies all returned methods share the prefix and unrelated methods are excluded), empty namespace returning an empty array, `--descriptions` changing the output shape to objects with `method` and `description` fields, and composition of both flags together
- Suggestion tests cover: dry-run with misspelled methods verifying `suggestions` array and `warning` field in JSON output, case-correction suggestions, and stderr "Did you mean" warnings before API calls

**`proxy-mode.test.ts`** -- Blackbox subprocess tests of the proxy transport against the fake broker from [helpers.ts](helpers.ts) (no real Slack traffic):
- Pins the wire contract: POST `{method, args}` JSON to `<proxy>/method` with an `authorization: Bearer <context token>` header, plus trailing-slash URL handling and proxy-over-direct precedence when both credential sets are set
- Verifies param handling is unchanged through the proxy (kebab-to-snake conversion, type coercion, `--json-input` pass-through) and that `--paginate` follows broker-supplied cursors and merges pages
- Verifies error mapping: broker error envelopes, Slack platform-code extraction from "An API error occurred" messages, the 401 context-token suggestion, and the no-credentials envelope mentioning both auth options
- Verifies `--dry-run` reports the correct `transport` value for all three modes without contacting the broker

**`suggest.test.ts`** -- Unit tests for the `findSimilarMethods` function:
- Verifies exact matches return no suggestions, case-insensitive matches return the correctly-cased method, single-character typos find the right method, nonsense input returns empty, result count respects the `maxResults` parameter, and results are sorted by similarity (closest first)

**`build.test.ts`** -- Build verification tests that exercise the compiled output:
- `beforeAll` runs `tsc` once; all tests share the resulting `dist/index.js`
- Uses `node dist/index.js` directly (unlike `cli.test.ts` which uses `npx tsx src/index.ts`), verifying the actual build artifact that a global install would expose
- Validates `--version` output, `list-methods` JSON structure, and no-args usage error exit code

**`packaging.test.ts`** -- End-to-end packaging test that validates the npm distribution path:
- `beforeAll` creates two tmpdirs, runs `npm pack` on the project root to produce a `.tgz`, then `npm init -y` + `npm install --no-save <tarball>` in the second tmpdir to simulate a downstream install
- Asserts the installed `node_modules/.bin/nori-slack` binary exists and that running it with `list-methods --namespace chat` returns exit 0 with JSON containing `chat.postMessage`
- Runs on every `npm test` invocation (not gated) so the tarball contents are continuously verified; the `beforeAll` has a 180s timeout because `npm pack` + `npm install` of the tarball is slow
- This test is the enforcement mechanism for the packaging invariant documented in [@/docs.md](../docs.md): if `prepare`, `files`, or `bin` regress, this test fails before a broken version can be published

### Things to Know
- Direct-mode integration tests in [cli.test.ts](cli.test.ts) make real HTTP calls to Slack's API (with invalid tokens), so they require network access; proxy-mode tests talk only to the local fake broker
- The `runCli` helper in [helpers.ts](helpers.ts) sets a 10-second timeout to prevent hangs
- The hermetic env in [helpers.ts](helpers.ts) means tests can never see host Slack credentials -- each test passes exactly the env vars it wants, and transport selection is fully determined by that input
- Tests intentionally verify structure (JSON shape, field presence, field types) rather than exact string values, making them resilient to Slack API message changes
- `packaging.test.ts` shells out to `npm` and writes into `os.tmpdir()`, so CI runners must have npm available and writable tmp space

Created and maintained by Nori.
