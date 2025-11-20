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
2. Use `askquestions` to gather: URL, output dir (default `./output`), limit (default 20), delay ms (default 1000), download media yes/no (default yes), optional tags/keywords, optional start/end dates.
3. Invoke the plugin slash command (namespaced): `/ultrascrape:ultrascrape` with the collected values; no flags need to be remembered. Build `--filters` JSON from the answers.
4. Summarize discovery results (counts/date range), confirm what to download, then run with the confirmed filters and be polite (increase delay on 429/403).
5. Report saved paths, successes/failures, and remind that JS-only sites may need direct article URLs.
