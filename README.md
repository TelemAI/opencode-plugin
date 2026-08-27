# @telemai/opencode-plugin

Telem web search (telem_search) and page fetch (telem_fetch) tools for OpenCode. Searches show up in the Telem console as live session trajectories.

## Installation

The guided installer is the quickest path — it configures the plugin and captures
your API key from [app.telem.ai](https://app.telem.ai) in one pass:

```bash
npm create @telemai
```

Pick **OpenCode** when it asks, or skip the interview entirely:

```bash
npm create @telemai -- --client opencode
```

### By hand

Set the endpoint and your key explicitly — `npm create @telemai` writes both for you:

```bash
opencode plugin @telemai/opencode-plugin --global
export TELEM_BASE_URL=https://router.telem.ai
export TELEM_API_KEY=...              # from https://app.telem.ai
```

This writes the plugin entry to OpenCode's config file (`opencode.jsonc`,
despite the `.json`-sounding name) and materializes the package — one command
for both.

### Manual alternative

Add the package to the `plugin` array in `opencode.jsonc` yourself:

```json
{
  "plugin": ["@telemai/opencode-plugin"]
}
```

## Configuration

Set your Telem API key via the `TELEM_API_KEY` environment variable:

```bash
export TELEM_API_KEY="your-api-key-here"
```

The plugin will use this key to authenticate with the Telem service for all search and fetch operations.

See [docs.telem.ai](https://docs.telem.ai) for more information.

## License

Copyright (c) 2026 Telem AI. Licensed under the [Apache License, Version 2.0](LICENSE).
