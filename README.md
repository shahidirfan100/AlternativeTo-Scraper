# AlternativeTo Scraper

Apify Actor that scrapes tools and software alternatives from AlternativeTo.net using Crawlee’s `CheerioCrawler` (no browser).

## What it does

- Crawls AlternativeTo search/category pages, handling pagination until the requested number of results is reached.
- Optionally opens each tool detail page to extract descriptions, category, rating, and pricing.
- Stops early once targets are met; deduplicates list/detail requests.
- Saves structured items to the default Apify dataset with an overview view.

## How it works

- Uses `CheerioCrawler` with gotScraping headers (no Playwright).
- Input is normalized: accepts `startUrl`, `startUrls`, or `url`; otherwise builds a search URL from `keyword`.
- Validates numeric limits (`results_wanted`, `max_pages`) and enforces a crawl cap.
- Uses `apify/log` for logging and respects provided proxy configuration.

## Input

All fields are optional unless noted.

- `startUrl` (string): A single AlternativeTo URL to start from. Example: `https://alternativeto.net/category/ai-tools/ai-image-generator/`.
- `startUrls` (array): List of AlternativeTo URLs to seed multiple searches/categories.
- `keyword` (string): Search keyword used when no start URL is given. Examples: `DALL-E`, `Midjourney`, `AI image generator`.
- `results_wanted` (integer): Maximum number of tools to collect. Default: 100.
- `max_pages` (integer): Safety cap on number of list pages to visit. Default: 20.
- `collectDetails` (boolean): Visit tool detail pages for full info. Default: true.
- `proxyConfiguration` (object): Proxy settings; use Apify Proxy (residential) for best results.

Example `INPUT.json`:

```json
{
  "startUrls": [{ "url": "https://alternativeto.net/category/ai-tools/ai-image-generator/" }],
  "results_wanted": 50,
  "max_pages": 10,
  "collectDetails": true,
  "proxyConfiguration": { "useApifyProxy": true, "apifyProxyGroups": ["RESIDENTIAL"] }
}
```

## Output

Items are stored in the default dataset (view `overview`):

- `title` (string|null) — Tool name.
- `description` (string|null) — Cleaned description from detail page or metadata.
- `category` (string|null) — First detected category/breadcrumb.
- `rating` (number|null) — Parsed rating when available.
- `pricing` (string|null) — License/pricing text when available.
- `url` (string) — Absolute AlternativeTo URL.
- `_source` (string|null) — Present for list-only mode items.

Example item:

```json
{
  "title": "Midjourney",
  "description": "AI-powered image generation service...",
  "category": "AI Image Generator",
  "rating": 4.5,
  "pricing": "Freemium",
  "url": "https://alternativeto.net/software/midjourney/"
}
```

## Running locally

```bash
npm install
apify run -p INPUT.json
```

## Deployment

- Login once: `apify login`
- Push to Apify: `apify push`

## Notes

- When no `keyword` or start URL is provided, the actor falls back to the AlternativeTo homepage and logs a warning.
- If AlternativeTo.net markup changes, adjust selectors in `src/main.js`.
- For reliable runs, prefer Apify residential proxies and keep `results_wanted`/`max_pages` reasonable to avoid rate limits.
