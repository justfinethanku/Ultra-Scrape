---
name: ultrascrape-targeted-archiver
description: Discover and download targeted web articles to Markdown via the UltraScrape plugin; use when the user asks to fetch posts or feeds politely with limits and optional filters.
---

# UltraScrape Targeted Archiver

## When to use
- User asks to discover or download articles/posts from an http(s) feed or page into Markdown for offline use.
- They mention limits (count, date range, tags/topics), output directories, politeness/delays, or skipping media.
- Avoid authenticated/paywalled/JS-rendered pages; prefer RSS/Atom or static HTML.

## How to run
1. Require a valid http(s) URL.
2. Ask only for missing inputs using available tools or conversation: URL, output dir (default `./output`), limit (default 20), delay ms (default 1000), download media yes/no (default yes), optional exact tags and start/end dates. Resolve output against the user's working directory before changing directories.
3. Follow [the command procedure](../../commands/ultrascrape.md) for `/ultrascrape:ultrascrape`. Build `--filters` JSON from the answers. Use a double-quoted shell variable for that JSON; do not pass a literal `$FILTERS_JSON`.
4. Summarize discovery results (counts/date range), confirm what to download, then run with the confirmed filters and be polite (increase delay on 429/403).
5. Report saved paths, successes/failures, and remind that JS-only sites may need direct article URLs.

Downloads consider at most the first 50 discovered feed entries and preserve
feed order. Tags are exact case-insensitive matches; keyword/title search is
not implemented. Use an explicit URL filter after inspecting discovery when
needed. Delays apply before article requests, not every network request.
Check result JSON for failures even on exit 0. See the
[README](../../README.md) for setup, CLI options, and archive limitations.
Private sources need explicit source-only `--allow-private-network`; extracted
links, media, and redirect hops stay subject to public-destination validation.
