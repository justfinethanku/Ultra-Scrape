---
description: Targeted article discovery and download (markdown-only)
---

# UltraScrape Command (Targeted)

Runs discovery then selective download for specific articles/posts. Default is HTTP/RSS; markdown output only. JS-only pages are not rendered in this version.

## Instructions

When the user runs `/ultrascrape $ARGUMENTS`:

1. Parse URL and flags from `$ARGUMENTS`. URL is required. Optional flags:
   - `--format <markdown>` (default: markdown; markdown is the only supported output)
   - `--output <dir>` (default: ./output)
   - `--delay <ms>` (default: 1000)
   - `--limit <n>` (cap items downloaded; default 20)
   - `--no-media` (skip media downloads)

2. Run discovery (HTTP/RSS-first):
   ```bash
   cd ${CLAUDE_PLUGIN_ROOT}
   node scripts/discovery-engine.js "$URL" --limit ${LIMIT:-50} > /tmp/ultrascrape-discovery.json
   ```

3. Summarize results to the user (counts/date range) and ask what to download. Respect the target/limit intent; do not propose bulk.

4. When the user confirms filters (e.g., date range, tags, most recent N, or specific URLs), build a JSON filter object and pass it to download:
   ```bash
   cd ${CLAUDE_PLUGIN_ROOT}
   node scripts/download-engine.js "$URL" --filters '$FILTERS_JSON' --output "$OUTPUT" --format "$FORMAT" ${NO_MEDIA:+--no-media}
   ```

5. Stream progress from stderr (prefixed `PROGRESS:`). On completion, report total downloaded, output path, any failures.

## Error handling
- Invalid URL: ask for a valid http/https URL.
- No content found: suggest providing specific article URLs; JS-only pages are not rendered in this version.
- Rate limit/429: suggest increasing `--delay`.
- Auth required: tell user to provide cookies/session config.
