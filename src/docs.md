# Noridoc: src

Path: @/src

### Overview
- Contains all source modules for the CLI: entry point, argument parsing, transport selection, error formatting, pagination, fuzzy method suggestion, the known-methods catalog, and the method metadata registry
- Compiles from `src/` to `dist/` via TypeScript (ES2022 target, Node16 module resolution)

### How it fits into the larger codebase
- [index.ts](index.ts) is the CLI entry point (shebang `#!/usr/bin/env node`), compiled to `dist/index.js` and exposed as the `nori-slack` binary via the `bin` field in [../package.json](../package.json). The compiled `dist/` directory is produced at pack time by the `prepare` script and shipped to the npm registry via the `files` allowlist -- see [../docs.md](../docs.md) for the full packaging chain
- [transport.ts](transport.ts) is the only module that knows how to reach Slack. It selects between proxy mode (a Nori Sessions broker, configured by `NORI_SLACK_PROXY_URL` + `NORI_SLACK_CONTEXT_TOKEN`) and direct mode (`SLACK_BOT_TOKEN` via `@slack/web-api`); everything downstream works against its `Transport` interface
- [parse-args.ts](parse-args.ts) and [errors.ts](errors.ts) are pure utility modules with no side effects; [paginate.ts](paginate.ts) is transport-generic (no Slack SDK dependency). All are independently testable and tested in [@/test](../test/)
- [methods.ts](methods.ts) is a static data file backing discoverability (`list-methods`) and unknown-method warnings via `isKnownMethod`; `KNOWN_METHODS` has no effect on which real Slack methods the CLI can call, while `PROXY_METHODS` additionally gates the direct-mode rejection of broker-only pseudo-methods

### Core Implementation

**Entry point (`index.ts`)**
- Sets up Commander with three subcommands: `list-methods`, `describe`, and the default dynamic method handler
- The dynamic handler: optionally reads JSON from stdin, parses CLI flags, merges params (CLI flags win over stdin), then branches into three paths:
  1. `--dry-run`: short-circuits immediately after param resolution -- outputs a JSON preview with `ok`, `dry_run`, `method`, `params`, `transport`, `token_present`, `paginate`, and optionally a `warning` for unknown methods. Does not require credentials. Always exits 0.
  2. `--paginate`: resolves the transport via `resolveTransport()`, then runs `mergePages(paginatePages(transport, method, params))`
  3. Default: resolves the transport, then makes a single `transport.call(method, params)`
- If `resolveTransport()` returns null (no credentials in either mode), the handler emits the `no_token` error envelope and exits 1 before any API path runs
- After resolving a transport, a proxy-only method (anything in `PROXY_METHODS`, currently just `files.download`) invoked in direct mode is rejected with the `proxy_only_method` error envelope (exit 1) before any call is made, because those pseudo-methods only exist on the broker
- `files.download` plus `--output <path>`: after the call returns, the base64 `file.contentBase64` is decoded and written to the resolved path with `writeFileSync`, and the printed JSON is replaced with a summary (`ok`, `file: { id, name, mimetype, contentType, bytes, path }`) that omits the base64 blob. Without `--output` the raw broker response (including `contentBase64`) is printed as-is
- When no arguments are provided (`process.argv.length <= 2`), help text and error go to stderr and the process exits with code 2
- The `list-methods` subcommand supports two options that compose together: `--namespace <ns>` filters the method list to those starting with the given prefix (e.g., `chat.`), and `--descriptions` changes the output shape from `string[]` to `Array<{ method, description }>` by pulling descriptions from `getMethodMetadata()`. When `--namespace` is provided, a `namespace` field is added to the response JSON.

**Transport selection (`transport.ts`)**
- `detectTransportMode(env)` returns `'proxy' | 'direct' | 'none'`: proxy when both `NORI_SLACK_PROXY_URL` and `NORI_SLACK_CONTEXT_TOKEN` are non-empty, otherwise direct when `SLACK_BOT_TOKEN` is set, otherwise none. Proxy takes precedence over a bot token
- `resolveTransport(env)` returns a `Transport` (`{ mode, call(method, params) }`) or `null` when no credentials are available
- Proxy `call` POSTs `{ method, args }` as JSON to `<proxy-url>/method` (trailing slashes are stripped from the configured URL first) with an `authorization: Bearer <context token>` header. A 2xx response is returned as the raw Slack JSON body; a non-2xx response throws `ProxyError` (code `nori_slack_proxy_error`) carrying the HTTP status and the broker's `error` message
- Direct `call` wraps `WebClient.apiCall` from `@slack/web-api`

**Pagination (`paginate.ts`)**
- `paginatePages(transport, method, params)` is an async generator that repeatedly calls the transport, following `response_metadata.next_cursor` and terminating when the cursor is empty or missing. It replaces the old `WebClient.paginate()` path so pagination works identically over both transports
- `mergePages(pages)` takes an `AsyncIterable` of page objects and returns a single merged object
- Array-valued keys are concatenated across pages; scalar/metadata keys (`ok`, `response_metadata`, `headers`, `warning`) are overwritten with the last page's value
- This design means the function works generically with any Slack method's response shape -- it does not need to know which key holds the data (e.g., `channels`, `members`, `messages`)

**Argument parsing (`parse-args.ts`)**
- `parseArgs(argv)` walks the args array linearly, handling three patterns: `--key value`, `--key=value`, and standalone `--flag` (boolean true)
- `kebabToSnake` converts all flag names from CLI convention to Slack API convention
- `coerceValue` applies type inference: `"true"`/`"false"` become booleans, numeric strings become numbers (except those with leading zeros), and strings starting with `[` or `{` are attempted as JSON parse

**Error formatting (`errors.ts`)**
- `formatError(error, sourceDir)` returns a `CliError` object with fields: `ok`, `error`, `message`, `suggestion`, `source`
- Handles six specific error codes: the `@slack/web-api` codes `slack_webapi_platform_error`, `slack_webapi_rate_limited_error`, and `slack_webapi_request_error`, plus the custom `no_token`, the custom `proxy_only_method` (a `PROXY_METHODS` entry attempted in direct mode), and the proxy transport's `nori_slack_proxy_error`
- For `nori_slack_proxy_error`: broker messages of the form "An API error occurred: \<code\>" have the Slack platform code extracted and mapped through the same `SUGGESTIONS` table as direct-mode platform errors; HTTP 401 maps to `proxy_unauthorized` with a context-token rotation suggestion; any other status maps to `proxy_error` with a suggestion about the session's access grant
- Broker wire contract behind those mappings: 200 returns raw Slack JSON; error statuses (e.g., 401, 403, 404) return `{ error: message }`
- The `SUGGESTIONS` map provides agent-friendly remediation text for common Slack platform errors like `channel_not_found`, `not_in_channel`, `rate_limited`, etc.

**Fuzzy method suggestion (`suggest.ts`)**
- `findSimilarMethods(input, methods?, maxResults?)` returns up to 3 similar method names from `KNOWN_METHODS` for typo correction
- Three-tier matching: exact match returns `[]` (no suggestions needed), case-insensitive exact match returns the correctly-cased method as a fast path, then Levenshtein distance ranking with a dynamic threshold of `max(3, floor(input.length * 0.4))`
- Levenshtein comparison is case-insensitive (both sides lowercased) to maximize match quality
- Used in `index.ts` at two integration points: the `--dry-run` path adds `suggestions` array and enriched `warning` to the JSON output, and the pre-API-call path emits a stderr warning with "Did you mean: X?"

**Methods catalog (`methods.ts`)**
- `KNOWN_METHODS` is a static string array of Slack Web API methods available to bot tokens
- Serves as a discoverability aid only; the comment in the file explicitly notes the CLI is not limited to these methods
- `PROXY_METHODS` is a separate static array of broker pseudo-methods that are *not* real Slack Web API methods and only work in proxy mode (currently just `files.download`)
- `isKnownMethod(method)` returns true when the method is in either `KNOWN_METHODS` or `PROXY_METHODS`; it backs `list-methods`, the unknown-method warnings, and the `--dry-run` warning so pseudo-methods are not flagged as unknown

**Method metadata (`method-metadata.ts`)**
- `METHOD_METADATA` is a static `Record<string, MethodMetadata>` map providing parameter documentation for every method in `KNOWN_METHODS`, plus the `files.download` pseudo-method
- Each entry includes: `description`, `required_params`, `optional_params` (both `Record<string, string>` mapping param name to human-readable description), `supports_pagination` (boolean), optional `deprecated` notice, and `docs_url`
- `getMethodMetadata(method)` looks up the map and returns the entry if present; for unknown methods, it returns a fallback with empty params and a generated docs URL
- The `docsUrl()` helper constructs URLs in the form `https://api.slack.com/methods/{method}`; the `files.download` entry overrides this with a GitHub README anchor since it is not a real Slack method
- The `describe` command in [index.ts](index.ts) wraps `getMethodMetadata` output with `ok`, `method`, and `known` fields (where `known` is `true` only when the method has a curated entry in `METHOD_METADATA`)

### Things to Know
- `--json-input`, `--paginate`, `--dry-run`, and `--output <path>` are consumed by Commander as known options; all other flags pass through via `allowUnknownOption()` and are parsed by `parseArgs` from `process.argv`
- The raw args filter strips the boolean options (`--json-input`, `--paginate`, `--dry-run`) and the value option `--output` together with its following value (and the `--output=value` form) before passing to `parseArgs`, preventing any of them from being sent as Slack API parameters
- When both stdin JSON and CLI flags provide the same key, the CLI flag value wins due to spread order: `{ ...stdinParams, ...cliParams }`
- Non-flag arguments (tokens not starting with `--`) are silently skipped by `parseArgs` -- they do not cause errors
- Rate limit errors extract `retryAfter` from the `@slack/web-api` error object and include the retry duration in the message
- The `--dry-run` output's `token_present` field only reflects `SLACK_BOT_TOKEN`; the `transport` field is the authoritative indicator of which mode would be used (proxy wins when both credential sets are present)
- The missing-credentials error keeps the error code `no_token` for backward compatibility, but its message ("No Slack credentials provided.") and suggestion cover both credential sets

Created and maintained by Nori.
