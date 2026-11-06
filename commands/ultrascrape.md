---
description: Targeted article discovery and download (markdown-only)
---

# UltraScrape command

Runs discovery then selective download for specific articles/posts. Default is HTTP/RSS; markdown output only. JS-only pages are not rendered in this version.

## Instructions

When the user runs `/ultrascrape:ultrascrape $ARGUMENTS`, use their arguments
as inputs and ask for missing information. Use the session's available question
tool or ordinary conversation; no tool named `askquestions` is required.

1) Gather inputs (use supplied arguments where possible):
   - `Target URL (required, http/https)`
   - `Output directory? (default: ./output)`
   - `How many items max? (default: 20)`
   - `Delay between requests in ms? (default: 1000)`
   - `Download media? (yes/no, default: yes)`
   - `Filter by exact tags? (comma-separated, case-insensitive, optional)`
   - `Published after date? (optional, ISO or YYYY-MM-DD)`
   - `Published before date? (optional, ISO or YYYY-MM-DD)`
   Confirm the plan (URL, limit, delay, output, media flag, filters) before running.
   Resolve a relative output directory against the user's working directory
   before changing into the plugin root. Use that absolute path as `OUTPUT`.
   Use positive integers for `LIMIT` and `DELAY`; CLI zero values use defaults.

2) Run discovery (HTTP/RSS-first):
   ```bash
   cd "${CLAUDE_PLUGIN_ROOT}"
   WORK_DIR=$(mktemp -d)
   node scripts/discovery-engine.js "$URL" --limit 50 > "$WORK_DIR/discovery.json"
   ```

3) Summarize results (count, date range, sample titles). If nothing found, ask for a more specific URL. Otherwise, apply the user filters and confirm the final selection.
   Results stay in feed order, not newest-first. The download CLI independently
   rediscovers at most 50 entries; higher download limits do not expand that set.
   There is no title/full-text/author search. For a keyword request, inspect
   discovery metadata and pass an explicit `urls` allowlist in the filters.

4) Build the filters JSON from answers, e.g.:
   ```json
   {
     "limit": 20,
     "dateRange": { "start": "2024-01-01T00:00:00Z", "end": "2024-12-31T23:59:59.999Z" },
     "tags": ["ai","ml"]
   }
   ```
   Bounds are inclusive; undated posts remain eligible. The `tags` filter
   matches any exact tag, case-insensitively. Serialize the object into the
   shell variable `FILTERS_JSON` as one string, preserving quotes and user text.

5) Run download (markdown-only):
   ```bash
   cd "${CLAUDE_PLUGIN_ROOT}"
   node scripts/download-engine.js "$URL" --filters "$FILTERS_JSON" --output "$OUTPUT" --format markdown --limit "$LIMIT" --delay "$DELAY" > "$WORK_DIR/download.json"
   ```
   Append `--no-media` when the user declines images. Double quotes around
   `"$FILTERS_JSON"` expand the variable while keeping it one argument; single
   quotes would send the literal variable name and fail JSON parsing.

6) Read progress/errors from stderr and inspect `download.json`. Report
   `summary.attempted`, `summary.succeeded`, failed result entries, and saved
   absolute paths. Individual failures do not make the process exit nonzero.
   Archives contain Markdown, metadata, extracted HTML (despite its
   `original.html` name), and optional images. Repeated runs overwrite matching
   date/title directories and append manifest entries. Retain the JSON results
   if useful; otherwise remove the temporary directory after reporting.

## Error handling
- Invalid URL: ask for a valid http/https URL.
- No content found: suggest providing specific article URLs; JS-only pages are not rendered in this version.
- Rate limit/429: suggest increasing `--delay`.
- Auth required: authenticated fetching is not implemented; use a public article/feed or explain that code changes are needed.
- Dependency import error: run `npm ci` in the same plugin checkout, then restart with `claude --plugin-dir` pointing to it.
- Blocked non-public destination: public HTTP(S) destinations are the default. For a private source the user explicitly trusts, both engines accept `--allow-private-network` for that exact source only. Feed entries, linked feeds, images, and redirect hops do not inherit it. Use a private article's own URL for a separate run; see the README's private-network section.
- Delays apply before article fetches, not discovery or image requests. No automatic retry/backoff or robots.txt enforcement is implemented.
