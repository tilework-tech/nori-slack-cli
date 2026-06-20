# Noridoc: nori-slack-cli

Path: @/

### Overview
- A TypeScript CLI that exposes the entire Slack Web API as a single command: `nori-slack <method> [--param value ...]`
- Designed for coding agents: all output is JSON on stdout, human-readable errors go to stderr
- Supports two transports, resolved in [src/transport.ts](src/transport.ts): direct calls to Slack via the `@slack/web-api` WebClient, or a Nori Sessions broker proxy. Dispatch is dynamic in both modes -- the CLI is not limited to a fixed set of methods
- Supports automatic cursor pagination via `--paginate`, which fetches all pages and returns a single merged JSON response
- Supports `--dry-run` to preview resolved API requests without sending them -- designed as a safety net for coding agents to validate parameter resolution
- Supports `describe <method>` to look up parameter documentation for any Slack API method without requiring a token -- the metadata map covers all methods in `KNOWN_METHODS`, so agents always get full parameter documentation rather than a fallback
- Supports an `upload` subcommand that drives Slack's modern three-step external file upload flow -- a distinct capability because the raw byte upload cannot ride the dynamic `<method>` dispatch path (see [src/upload.ts](src/upload.ts))

### How it fits into the larger codebase
- Standalone repository (was originally imported from the `nori-integrations` monorepo and now lives on its own). Distributed via the public npm registry as `nori-slack-cli`
- The canonical install path is `npm install -g nori-slack-cli`, which places the `nori-slack` binary on `PATH`; `npm link` from a local clone is retained for contributors
- Two credential modes, no user OAuth flows: direct mode via the `SLACK_BOT_TOKEN` environment variable, and proxy mode via `NORI_SLACK_PROXY_URL` + `NORI_SLACK_CONTEXT_TOKEN` (both must be set; Nori session machines export them). Proxy mode takes precedence when both credential sets are present
- Proxy mode exists so Nori Sessions can route Slack calls through its broker's scoped access grants. It replaced a separate hand-rolled proxy client script in the sessions repo, consolidating two diverging implementations of the same command behind this one CLI
- The CLI is a thin wrapper -- it does not contain business logic, scheduling, or state management; it translates CLI flags into Slack API calls and returns the raw JSON response
- The pagination logic in [src/paginate.ts](src/paginate.ts) is decoupled from the Slack SDK -- the cursor loop talks only to the `Transport` interface, and the merge step operates on any `AsyncIterable` of page objects
- User-facing installation and usage documentation lives in [README.md](README.md)

### Core Implementation
- Entry point is [src/index.ts](src/index.ts), which uses Commander.js with `allowUnknownOption()` so arbitrary `--flag value` pairs pass through without Commander rejecting them
- The dynamic handler has three code paths: `--dry-run` short-circuits after param resolution (no credentials required, no API call, reports which transport would be used), `--paginate` runs the generic cursor loop `paginatePages()` + `mergePages()` from [src/paginate.ts](src/paginate.ts), and the default path makes a single `transport.call()`. The transport is resolved once per invocation and both API paths route through it, so behavior (including pagination) is identical in proxy and direct mode
- Two input modes: CLI flags (`--channel C123 --text "hi"`) and piped JSON via `--json-input`; when both are provided, CLI flags override stdin values
- Two discovery subcommands that do not require credentials: `list-methods` outputs known method names as JSON (supports `--namespace` filtering and `--descriptions` to include method descriptions), and `describe <method>` returns structured parameter documentation
- The `upload` subcommand, orchestrated by [src/upload.ts](src/upload.ts), runs Slack's external upload as three ordered steps: (1) `files.getUploadURLExternal` mints an upload URL + `file_id` via the transport, (2) the raw file bytes are POSTed DIRECTLY to Slack's upload host with no token (the URL is itself the credential, so these bytes never touch the broker proxy), and (3) `files.completeUploadExternal` shares the file via the transport. Because the completing call rides the normal transport, proxy-mode channel scoping is enforced by the broker at that step automatically. This flow is what Bolt exposes as `files.uploadV2` and is why it cannot be reached through the dynamic dispatch path
- `describe` uses [src/method-metadata.ts](src/method-metadata.ts), a hand-curated static map covering every method in `KNOWN_METHODS` -- this is static because `@slack/web-api` erases parameter type information at compile time, so runtime introspection is not possible
- For unknown methods (not in `KNOWN_METHODS`), `getMethodMetadata()` returns a fallback entry with empty params and a generated docs URL, so `describe` never errors; the `known` field in the output distinguishes curated entries from fallbacks
- When an unknown method is used, [src/suggest.ts](src/suggest.ts) provides fuzzy matching via Levenshtein distance against `KNOWN_METHODS`, surfacing "Did you mean?" suggestions; suggestions are non-blocking -- unknown methods still proceed to the API
- Successful API responses and error responses both go to stdout as JSON; errors additionally write a human-readable line to stderr
- Exit codes: `0` for success, `1` for API/token errors, `2` for missing args or invalid stdin JSON

### Packaging and distribution

The published npm artifact is assembled at pack time, not committed to git. The relevant `package.json` fields form a single chain that must stay in sync:

```
dist/ (gitignored)
  └─ produced by `prepare: "npm run build"` (runs on npm pack / npm publish / npm install from tarball)
  └─ made executable by `postbuild: "chmod +x dist/index.js"`
  └─ included in the tarball by `files: ["dist"]`
  └─ exposed as `nori-slack` via `bin: { "nori-slack": "./dist/index.js" }`
  └─ verified end-to-end by test/packaging.test.ts on every `npm test`
```

- `test/packaging.test.ts` runs `npm pack`, installs the resulting tarball into a tmpdir, and executes the installed `nori-slack` binary to confirm `dist/` actually ships. See [test/docs.md](test/docs.md) for test-level detail
- CI is defined in [.github/workflows/pr-ci.yaml](.github/workflows/pr-ci.yaml) (on pull requests to `main`) and [.github/workflows/main-ci.yaml](.github/workflows/main-ci.yaml) (on push to `main`). Both mirror `nori-registrar` conventions: checkout, `actions/setup-node` reading Node version from [.nvmrc](.nvmrc), `npm install`, `npm run build`, `npm test`
- [.nvmrc](.nvmrc) pins Node 22 to match the `nori-registrar` baseline

### Things to Know
- Flag parsing in [src/parse-args.ts](src/parse-args.ts) converts `--kebab-case` to `snake_case` because the Slack API uses snake_case parameter names
- Type coercion in `coerceValue` handles booleans (`"true"`/`"false"`), numbers (but preserves leading-zero strings like `"007"`), and inline JSON arrays/objects
- A standalone `--flag` with no following value (or followed by another `--flag`) is treated as boolean `true`
- Error formatting in [src/errors.ts](src/errors.ts) maps Slack error codes to actionable suggestions (e.g., `channel_not_found` suggests running `conversations.list`); unknown errors get a generic suggestion pointing to the source directory. Broker errors from proxy mode are normalized into the same envelope, including extracting Slack platform codes embedded in broker messages
- Every error response includes a `source` field with the filesystem path to the CLI, so agents can locate the source code for debugging
- The method metadata in [src/method-metadata.ts](src/method-metadata.ts) marks `files.upload` as deprecated with a pointer to the `files.getUploadURLExternal` + `files.completeUploadExternal` flow -- the `upload` subcommand (see [src/upload.ts](src/upload.ts)) is the client-side orchestration of exactly that flow, so agents should reach for `upload` rather than the deprecated single-call `files.upload`
- The CLI version string is currently duplicated: once in [package.json](package.json) `version` and once as a hardcoded argument to Commander's `.version()` call in [src/index.ts](src/index.ts). Both must be bumped together on release
- **Packaging invariant**: anything that changes how the distributed artifact is produced must keep the `prepare` script, the `files` allowlist, `bin`, and [test/packaging.test.ts](test/packaging.test.ts) consistent. Concretely, any future change that removes `prepare`, removes `files`, emits generated code outside `dist/`, or adds a second bin entry needs matching updates in the allowlist and the packaging test -- otherwise `npm install -g nori-slack-cli` silently ships a broken binary (this was the exact `0.1.0` regression)

Created and maintained by Nori.
