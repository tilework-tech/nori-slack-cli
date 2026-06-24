# nori-slack-cli

A CLI for the Slack Web API, designed for coding agents. Used as the Slack driver for [Nori Sessions](https://norisessions.com/) background agents.

`nori-slack-cli` is a thin command-line wrapper around the Slack Web API that maps **1:1 to Bolt** (`@slack/web-api`). Every method Bolt exposes is reachable through a single dynamic command — there is no curated subset, no opinionated abstraction layer, and no business logic. If Bolt can call it, this CLI can call it.

## Why this exists

Bolt is built for human developers writing TypeScript. This CLI is built for coding agents that need to drive Slack from a shell. That shapes every design decision:

- **No interactive prompts, no ASCII art.** Every successful response is a single line of JSON on stdout. Errors are JSON on stdout *and* a human-readable line on stderr.
- **Exhaustive surface.** The agent has access to the full Slack Web API — not a hand-picked subset. Capability boundaries are enforced through **bot token scopes**, not through code.
- **Two transports, one interface.** Direct mode calls Slack with `SLACK_BOT_TOKEN`; proxy mode routes the same `{method, args}` calls through a Nori Sessions broker using `NORI_SLACK_PROXY_URL` + `NORI_SLACK_CONTEXT_TOKEN`, so managed sessions never hold a raw bot token. There is no user-OAuth flow because there is no human in the loop.
- **Self-locating errors.** Every error response includes a `source` field with the on-disk path to the CLI, so an agent can read the source code to debug.
- **Install from npm.** `npm install -g nori-slack-cli` puts `nori-slack` on your `PATH`. Cloning and building from source is also supported for contributors.

## Install

From npm:

```bash
npm install -g nori-slack-cli
```

From source (for contributors):

```bash
git clone https://github.com/tilework-tech/nori-slack-cli.git
cd nori-slack-cli
npm install
npm run build
npm link   # makes `nori-slack` available globally
```

Then set credentials for one of the two transports (see [Authentication](#authentication)):

```bash
# Direct mode
export SLACK_BOT_TOKEN=xoxb-...

# Proxy mode (set automatically inside Nori Sessions)
export NORI_SLACK_PROXY_URL=https://broker.example.com/api/slack-proxy
export NORI_SLACK_CONTEXT_TOKEN=...
```

## Usage

The general shape is `nori-slack <method> [--param value ...]`, where `<method>` is any Slack Web API method (e.g. `chat.postMessage`, `conversations.list`, `users.info`).

```bash
# Send a message
nori-slack chat.postMessage --channel C123 --text "Hello"

# List channels
nori-slack conversations.list --limit 10

# Auto-paginate and merge results
nori-slack conversations.list --paginate

# Pipe parameters in as JSON
echo '{"channel":"C123","text":"hi"}' | nori-slack chat.postMessage --json-input

# Preview a request without sending it (no token required)
nori-slack chat.postMessage --channel C123 --text "Hello" --dry-run
```

Flags are converted from `--kebab-case` to `snake_case` to match Slack's parameter names. Values are auto-coerced (`true`/`false` → boolean, numerics → number, inline JSON → object/array). A bare `--flag` with no value is treated as boolean `true`.

### Discovery (no token required)

```bash
# List every known method, optionally filtered by namespace
nori-slack list-methods --namespace chat
nori-slack list-methods --descriptions

# Get parameter docs, required/optional fields, pagination support, and docs URL for a method
nori-slack describe chat.postMessage
```

### File uploads

Slack's modern file upload is a three-step external flow — mint an upload URL, POST the raw bytes straight to it, then complete the upload to share it into a channel. This is what Bolt exposes as `files.uploadV2`, and the middle byte-POST step cannot ride the dynamic `<method>` path, so uploading gets its own subcommand:

```bash
# Upload a local file and share it into a channel
nori-slack upload --file ./report.pdf --channel C123

# Add a title, a message, and post it into a thread
nori-slack upload --file ./report.pdf --channel C123 \
  --title "Q3 Report" --initial-comment "Numbers are in" --thread-ts 1700000000.000100

# Preview the planned upload without contacting Slack
nori-slack upload --file ./report.pdf --channel C123 --dry-run
```

| Flag | Purpose |
| --- | --- |
| `--file <path>` | Local file to upload (required). |
| `--channel <id>` | Channel to share the file into. |
| `--title <title>` | File title (defaults to the filename). |
| `--filename <name>` | Filename registered with Slack (defaults to the basename of `--file`). |
| `--initial-comment <text>` | Message text posted alongside the file. |
| `--thread-ts <ts>` | Thread timestamp to share the file into. |
| `--alt-text <text>` | Alt text for the file. |
| `--snippet-type <type>` | Snippet type for text snippets. |
| `--dry-run` | Print the planned upload (file, byte length, channel, transport) without contacting Slack. |

The bytes are POSTed directly to Slack's upload host (the upload URL is itself the credential), so they never pass through the broker. The completing call rides the normal transport, so in proxy mode the broker still enforces the session's channel scoping — uploading into a channel outside the grant fails with a structured error.

### File downloads

Downloading a Slack file means fetching the bytes from Slack's private file host with a credential, which cannot ride the dynamic `<method>` path, so downloading gets its own subcommand:

```bash
# Download a file by ID to a local path
nori-slack download --id F123 --output ./report.pdf

# Preview the planned download without contacting Slack
nori-slack download --id F123 --output ./report.pdf --dry-run
```

| Flag | Purpose |
| --- | --- |
| `--id <id>` | Slack file ID to download (required). |
| `--output <path>` | Local path to write the bytes to (required). |
| `--dry-run` | Print the planned download (file ID, output, transport) without contacting Slack. |

In direct mode the CLI looks up the file's private download URL and fetches it with the bot token. In proxy mode the bytes come from the broker's `download` endpoint (the session has no bot token), so the broker enforces that the file is shared in the session's access grant — downloading a file outside the grant fails with a structured error.

### Top-level flags

| Flag | Purpose |
| --- | --- |
| `--json-input` | Read parameters as JSON from stdin (CLI flags override stdin values). |
| `--paginate` | Use cursor pagination and return a single merged JSON response. |
| `--dry-run` | Resolve params and print the planned request without calling the API. |

### Exit codes

- `0` — success
- `1` — Slack API error, proxy error, or missing credentials
- `2` — bad CLI usage (missing args, invalid stdin JSON)

## Authentication

The CLI supports two transports, selected from the environment:

| Mode | Environment | Behavior |
| --- | --- | --- |
| **Proxy** | `NORI_SLACK_PROXY_URL` + `NORI_SLACK_CONTEXT_TOKEN` | POSTs `{method, args}` to `<url>/method` with the context token as a bearer token. Used inside Nori Sessions, where the broker enforces a per-session access grant and the raw bot token never reaches the machine. |
| **Direct** | `SLACK_BOT_TOKEN` | Calls the Slack Web API directly via `@slack/web-api`. |

When both are configured, **proxy mode wins**. All CLI features (`--json-input`, `--paginate`, `--dry-run`, kebab-case conversion, type coercion, error suggestions) behave identically in both modes. `--dry-run` reports which transport would be used via the `transport` field (`proxy`, `direct`, or `none`).

In direct mode, capability boundaries come from the bot token's OAuth scopes. In proxy mode, the broker additionally restricts methods and channels to the session's access grant — requests outside the grant fail with a structured `proxy_error`.

## License

See [LICENSE](LICENSE) and [LICENSE-ADDENDUM.txt](LICENSE-ADDENDUM.txt).

---

Created and maintained by [Nori](https://noriagentic.com).
