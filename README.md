# nori-slack-cli

A CLI for the Slack Web API, designed for coding agents. Used as the Slack driver for [Nori Sessions](https://norisessions.com/) background agents.

`nori-slack-cli` is a thin command-line wrapper around the Slack Web API that maps **1:1 to Bolt** (`@slack/web-api`). Every method Bolt exposes is reachable through a single dynamic command — there is no curated subset, no opinionated abstraction layer, and no business logic. If Bolt can call it, this CLI can call it.

## Why this exists

Bolt is built for human developers writing TypeScript. This CLI is built for coding agents that need to drive Slack from a shell. That shapes every design decision:

- **No interactive prompts, no ASCII art.** Every successful response is a single line of JSON on stdout. Errors are JSON on stdout *and* a human-readable line on stderr.
- **Exhaustive surface.** The agent has access to the full Slack Web API — not a hand-picked subset. Capability boundaries are enforced through **bot token scopes**, not through code.
- **Bot tokens only.** Uses `SLACK_BOT_TOKEN` exclusively. There is no user-OAuth flow because there is no human in the loop.
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

Then set your bot token:

```bash
export SLACK_BOT_TOKEN=xoxb-...
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

### Top-level flags

| Flag | Purpose |
| --- | --- |
| `--json-input` | Read parameters as JSON from stdin (CLI flags override stdin values). |
| `--paginate` | Use cursor pagination and return a single merged JSON response. |
| `--dry-run` | Resolve params and print the planned request without calling the API. |

### Exit codes

- `0` — success
- `1` — Slack API error or missing token
- `2` — bad CLI usage (missing args, invalid stdin JSON)

## Authentication

Set `SLACK_BOT_TOKEN` in the environment. The CLI does not read tokens from any other source. To control what the agent can do, scope the bot token in the Slack app's OAuth & Permissions page — the CLI itself imposes no method-level restrictions.

## License

See [LICENSE](LICENSE) and [LICENSE-ADDENDUM.txt](LICENSE-ADDENDUM.txt).

---

Created and maintained by [Nori](https://noriagentic.com).
