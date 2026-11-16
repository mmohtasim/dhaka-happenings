# Dhaka Happening

What's on in Dhaka today and tomorrow, aggregated from newspaper RSS feeds. Static Astro site, deploys to GitHub Pages.

## Deploy (GitHub Pages)

1. Push this repo to GitHub, branch `main`.
2. Repo Settings → Pages → Source: **GitHub Actions**.
3. `.github/workflows/deploy.yml` builds and publishes on every push. The base path is derived from the repo name automatically — project pages (`/<repo>/`) and `*.github.io` root sites both work.

## Refresh the data (manual, every 6 h)

```
npm install            # once
npm run crawl          # crawls for 6 h, refreshes every 10 min, writes public/events.json
# or a single pass:    npm run crawl:once
git add public/events.json && git commit -m "refresh events" && git push
```

The push triggers the Pages deploy with the fresh data. Nothing runs on a schedule by itself — the crawler only runs when you start it.

## Local preview

```
npm run dev                        # live at http://localhost:4321
npm run build && npm run preview   # check the production build
```

## How it works

`scripts/crawl.mjs` fetches each feed, dedupes, and buckets items by date cues in the headline ("today", "tomorrow", weekday, "16 November") plus event keywords (concert, exhibition, match, …). Items with a date cue and event flavour land in Today/Tomorrow; event-ish items without one land in "Possibly relevant".

- Feeds live in `FEEDS` in `scripts/crawl.mjs` — add one line per source.
- Classification is keyword/date heuristics, not NLP; expect some noise.
- `node scripts/crawl.mjs --selftest` checks the date-cue logic.

Feeds: The Daily Star, Dhaka Tribune, Prothom Alo (EN), The Business Standard, plus Google News RSS searches scoped to Dhaka. bdnews24 and New Age expose no RSS.
