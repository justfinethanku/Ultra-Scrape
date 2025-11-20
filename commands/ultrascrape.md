---
description: Targeted article discovery and download (markdown-only)
---

# UltraScrape Command (Targeted)

Runs discovery then selective download for specific articles/posts. Default is HTTP/RSS; markdown output only. JS-only pages are not rendered in this version.

## Instructions

When the user runs `/ultrascrape $ARGUMENTS`, do not expect flags. Collect what you need with `askquestions`, then run discovery + download.

1) Gather inputs with `askquestions` (use any $ARGUMENTS as defaults only):
   - `Target URL (required, http/https)`
   - `Output directory? (default: ./output)`
   - `How many items max? (default: 20)`
   - `Delay between requests in ms? (default: 1000)`
   - `Download media? (yes/no, default: yes)`
   - `Filter by tags/keywords? (comma-separated, optional)`
   - `Published after date? (optional, ISO or YYYY-MM-DD)`
   - `Published before date? (optional, ISO or YYYY-MM-DD)`
   Confirm the plan (URL, limit, delay, output, media flag, filters) before running.

2) Run discovery (HTTP/RSS-first):
   ```bash
   cd ${CLAUDE_PLUGIN_ROOT}
   node scripts/discovery-engine.js "$URL" --limit ${LIMIT:-50} > /tmp/ultrascrape-discovery.json
   ```

3) Summarize results (count, date range, sample titles). If nothing found, ask for a more specific URL. Otherwise, apply the user filters and confirm the final selection.

4) Build the filters JSON from answers, e.g.:
   ```json
   {
     "limit": 20,
     "dateRange": { "start": "2024-01-01", "end": "2024-12-31" },
     "tags": ["ai","ml"]
   }
   ```

5) Run download (markdown-only):
   ```bash
   cd ${CLAUDE_PLUGIN_ROOT}
   node scripts/download-engine.js "$URL" --filters '$FILTERS_JSON' --output "$OUTPUT" --format markdown --limit "$LIMIT" ${NO_MEDIA:+--no-media} --delay "$DELAY"
   ```

6) Stream progress from stderr (prefixed `PROGRESS:`). On completion, report total downloaded, output path, any failures, and remind the user the content is Markdown + media (unless skipped).

## Error handling
- Invalid URL: ask for a valid http/https URL.
- No content found: suggest providing specific article URLs; JS-only pages are not rendered in this version.
- Rate limit/429: suggest increasing `--delay`.
- Auth required: tell user to provide cookies/session config.
