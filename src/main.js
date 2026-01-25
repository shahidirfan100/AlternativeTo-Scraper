import { Actor, log } from 'apify';
import { PlaywrightCrawler } from 'crawlee';
import { firefox } from 'playwright';
import { load as cheerioLoad } from 'cheerio';

await Actor.init();

// CONFIGURATION
const BASE_URL = 'https://alternativeto.net/';
const LICENSE_REGEX = /(free|open\s*source|opensource|paid|freemium|proprietary|commercial|trial|subscription|one[-\s]?time)/i;
const USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:147.0) Gecko/20100101 Firefox/147.0',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 15.7; rv:147.0) Gecko/20100101 Firefox/147.0',
    'Mozilla/5.0 (X11; Linux x86_64; rv:147.0) Gecko/20100101 Firefox/147.0',
];
const getRandomUserAgent = () => USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];

const DEFAULT_START_URLS = [
    'https://alternativeto.net/category/ai-tools/ai-image-generator/',
];

// HELPERS
const toAbsoluteUrl = (href, base = BASE_URL) => {
    try {
        return new URL(href, base).href;
    } catch {
        return null;
    }
};

const normalizeText = (text) => (text ? String(text).replace(/\s+/g, ' ').trim() : '');

const parseFirstFloat = (value) => {
    if (!value) return null;
    const match = String(value).match(/(\d+(?:\.\d+)?)/);
    return match ? parseFloat(match[1]) : null;
};

const extractLabeledValue = ($container, labelRegex) => {
    let value = null;
    $container.find('*').each((_, el) => {
        if (value) return;
        const text = normalizeText($(el).text());
        if (!labelRegex.test(text)) return;

        const linkText = normalizeText($(el).find('a').first().text());
        if (linkText) {
            value = linkText;
            return;
        }

        const afterColon = text.split(':').slice(1).join(':').trim();
        if (afterColon) {
            value = afterColon;
        }
    });
    return value;
};

const buildSearchUrl = (keyword) => {
    const url = new URL(BASE_URL);
    if (keyword) url.searchParams.set('q', keyword);
    return url.href;
};

const parsePositiveInteger = (value, fallback, fieldName) => {
    const num = Number(value);
    if (Number.isFinite(num) && num > 0) return Math.floor(num);
    if (fallback !== undefined) return fallback;
    throw new Error(`Invalid ${fieldName} supplied. Provide a positive number.`);
};

const normalizeInput = (rawInput) => {
    const keyword = normalizeText(rawInput.keyword);
    const resultsWanted = parsePositiveInteger(rawInput.results_wanted, 50, 'results_wanted');
    const maxPages = parsePositiveInteger(rawInput.max_pages, 5, 'max_pages');

    const isDefaultStartUrls = Array.isArray(rawInput.startUrls)
        && rawInput.startUrls.length === DEFAULT_START_URLS.length
        && rawInput.startUrls.every((entry, idx) => {
            const url = typeof entry === 'string' ? entry : entry?.url;
            return normalizeText(url) === DEFAULT_START_URLS[idx];
        });
    const hasExplicitSingle = Boolean(normalizeText(rawInput.startUrl) || normalizeText(rawInput.url));
    const hasExplicitList = Array.isArray(rawInput.startUrls) && rawInput.startUrls.length > 0 && !isDefaultStartUrls;
    const shouldUseStartUrls = hasExplicitSingle || hasExplicitList;

    const sources = [];
    const addSource = (val) => {
        if (!val) return;
        if (typeof val === 'string') {
            if (val.trim()) sources.push(val.trim());
            return;
        }
        if (typeof val === 'object' && typeof val.url === 'string' && val.url.trim()) {
            sources.push(val.url.trim());
        }
    };

    if (shouldUseStartUrls) {
        addSource(rawInput.startUrl);
        addSource(rawInput.url);
        if (Array.isArray(rawInput.startUrls)) rawInput.startUrls.forEach(addSource);
    } else if (!keyword) {
        DEFAULT_START_URLS.forEach(addSource);
    }

    const normalizedStartUrls = [...new Set(sources.map((href) => {
        const abs = toAbsoluteUrl(href);
        if (!abs) return null;
        return abs.replace(/\/about\/?$/, '/').replace(/\/reviews\/?$/, '/');
    }).filter(Boolean))];
    if (!normalizedStartUrls.length) {
        const fallbackUrl = keyword ? buildSearchUrl(keyword) : DEFAULT_START_URLS[0];
        normalizedStartUrls.push(fallbackUrl);
        if (!keyword) log.warning('No startUrl/startUrls/url provided. Falling back to default category URL.');
    }

    return {
        keyword,
        resultsWanted,
        maxPages,
        startUrls: normalizedStartUrls,
        proxyConfiguration: rawInput.proxyConfiguration,
    };
};

const rawInput = (await Actor.getInput()) ?? {};
const { keyword, resultsWanted, maxPages, startUrls, proxyConfiguration } = normalizeInput(rawInput);

log.info('Starting AlternativeTo Playwright Firefox scraper', {
    keyword: keyword || null,
    resultsWanted,
    maxPages,
});

const proxyConfig = await Actor.createProxyConfiguration(proxyConfiguration || {
    useApifyProxy: true,
    apifyProxyGroups: ['RESIDENTIAL'],
});

let saved = 0;
const seenDetails = new Set();
const seenPages = new Set();

const crawler = new PlaywrightCrawler({
    launchContext: {
        launcher: firefox,
        launchOptions: {
            headless: true,
        },
        userAgent: getRandomUserAgent(),
    },
    proxyConfiguration: proxyConfig,
    maxConcurrency: 5,
    maxRequestRetries: 1,
    navigationTimeoutSecs: 30,
    requestHandlerTimeoutSecs: 45,

    // Block heavy resources and trackers
    preNavigationHooks: [
        async ({ page }) => {
            await page.route('**/*', (route) => {
                const type = route.request().resourceType();
                const url = route.request().url();

                // Block images, fonts, media, stylesheets, and common trackers
                if (['image', 'font', 'media', 'stylesheet'].includes(type) ||
                    url.includes('google-analytics') ||
                    url.includes('googletagmanager') ||
                    url.includes('facebook') ||
                    url.includes('doubleclick') ||
                    url.includes('adsense') ||
                    url.includes('pinterest')) {
                    return route.abort();
                }
                return route.continue();
            });
        },
    ],

    requestHandler: async ({ page, request, crawler: crawlerInstance }) => {
        const { pageNo = 1 } = request.userData;
        const currentUrl = request.url;
        seenPages.add(currentUrl);

        log.info(`Processing: ${currentUrl} (Page ${pageNo})`);

        // Wait for key content
        try {
            await page.waitForSelector('body', { timeout: 10000 });
        } catch {
            log.warning(`Content load failed: ${currentUrl}`);
            return;
        }

        // Fast scroll to trigger lazy loading
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));

        const content = await page.content();
        const $ = cheerioLoad(content);

        const extractTagsByHeader = ($container, headerText) => {
            const HEADER_REGEX = new RegExp(headerText, 'i');
            const $header = $container.find('h4').filter((_, el) => HEADER_REGEX.test(normalizeText($(el).text())));
            if (!$header.length) return [];

            const $list = $header.next('ul, div').find('li, span, a');
            const tags = [];
            $list.each((_, el) => {
                const txt = normalizeText($(el).text());
                if (txt) tags.push(txt);
            });
            return [...new Set(tags)];
        };

        const tools = [];
        const $cards = $('div[data-testid="app-listing-item"], h2.Heading-module-scss-module__br2CUG__h2').closest('div[class*="rounded"]');
        const $finalCards = $cards.length ? $cards : $('div.flex.flex-col.gap-3 > div');

        $finalCards.each((_, el) => {
            const $card = $(el);
            const $titleLink = $card.find('h2[class*="Heading-module"], h2 a, h2').first();
            const title = normalizeText($titleLink.text());
            const href = $titleLink.find('a').attr('href') || $titleLink.attr('href') || $card.find('a[href*="/software/"]').first().attr('href');
            const toolUrl = href ? toAbsoluteUrl(href, currentUrl) : null;

            if (!toolUrl || !toolUrl.includes('/software/')) return;

            const description = normalizeText(
                $card.find('div.md_Compact p').first().text()
                || $card.find('#app-description p').first().text()
                || $card.find('p[class*="Description"], p').first().text()
            );

            const logoUrl = toAbsoluteUrl(
                $card.find('img[data-testid^="icon-"]').attr('src') || $card.find('img').first().attr('src'),
                currentUrl,
            );

            const likesRaw = $card.find('[aria-label^="Like"] span, [class*="heart"] span').text();
            const likesParsed = parseInt(likesRaw.replace(/[^0-9]/g, ''), 10);

            const costLicenseTags = extractTagsByHeader($card, 'Cost / License') || [];
            const cost = costLicenseTags[0] || null;
            const license = costLicenseTags[1] || costLicenseTags.find(t => LICENSE_REGEX.test(t)) || null;

            const appTypes = extractTagsByHeader($card, 'Application Types');
            const platforms = extractTagsByHeader($card, 'Platforms');
            const origins = extractTagsByHeader($card, 'Made in');
            const originLabelValue = extractLabeledValue($card, /(origin|made in)/i);

            const bestAlternativeText = extractLabeledValue($card, /best\\s*alternative/i)
                || normalizeText($card.find('.text-meta, .text-secondary, [class*="text-slate"]').filter((_, el) => /alternative/i.test(normalizeText($(el).text()))).first().text());

            const images = [];
            $card.find('div[aria-label="Open image in lightbox"] img').each((_, img) => {
                images.push(toAbsoluteUrl($(img).attr('src'), currentUrl));
            });

            const ratingContainer = $card.find('div.relative.flex-shrink-0, [data-testid*="rating"]').first();
            const ratingCandidates = [];
            if (ratingContainer.length) {
                const ariaLabel = ratingContainer.attr('aria-label');
                if (ariaLabel) ratingCandidates.push(ariaLabel);

                ratingContainer.find('span, div').each((_, span) => {
                    const txt = normalizeText($(span).text());
                    if (txt) ratingCandidates.push(txt);
                });

                const directText = normalizeText(ratingContainer.text());
                if (directText) ratingCandidates.push(directText);
            }
            $card.find('span.text-lime-600, span[class*="text-lime"], span[class*="text-success"]').each((_, span) => {
                const txt = normalizeText($(span).text());
                if (txt) ratingCandidates.push(txt);
            });
            const ratingParsed = ratingCandidates.map(parseFirstFloat).find((val) => Number.isFinite(val)) ?? null;

            tools.push({
                title,
                url: toolUrl.split('#')[0],
                description,
                logoUrl,
                likes: Number.isFinite(likesParsed) ? likesParsed : null,
                rating: Number.isFinite(ratingParsed) ? ratingParsed : null,
                cost,
                license,
                pricing: cost || null,
                applicationTypes: appTypes.length ? appTypes : null,
                platforms: platforms.length ? platforms : null,
                origins: origins.length ? origins : (originLabelValue ? [originLabelValue] : null),
                bestAlternative: bestAlternativeText || null,
                images: images.length ? images : null,
                _source: 'alternativeto',
            });
        });

        log.info(`Found ${tools.length} tool cards on page`);

        for (const tool of tools) {
            if (saved >= resultsWanted) break;
            if (!seenDetails.has(tool.url)) {
                seenDetails.add(tool.url);
                await Actor.pushData(tool);
                saved++;
            }
        }

        if (saved < resultsWanted && pageNo < maxPages) {
            const nextHref = (() => {
                const selectors = [
                    'a[rel="next"]',
                    'nav[aria-label*="pagination" i] a[aria-label*="next" i]',
                    'nav[aria-label*="pagination" i] a:contains("Next")',
                    'a[aria-label*="next" i]',
                    'a.inline-block.px-2.py-2.font-medium.leading-none.text-blue-600.dark\\:text-blue-400.cursor-pointer.text-\\[1\\.1em\\].ml-4',
                ];
                for (const selector of selectors) {
                    const href = $(selector).first().attr('href');
                    if (href) return href;
                }

                const textMatch = $('a').filter((_, el) => /next/i.test(normalizeText($(el).text()))).first();
                if (textMatch.length) return textMatch.attr('href');

                const $paginationItems = $('nav[aria-label*="pagination" i] li');
                const currentIdx = $paginationItems.toArray().findIndex((li) => $(li).attr('aria-current') === 'page');
                if (currentIdx >= 0) {
                    const href = $paginationItems.eq(currentIdx + 1).find('a').attr('href');
                    if (href) return href;
                }

                // Fallback: build ?p=<n+1> URL when no link is present
                try {
                    const urlObj = new URL(currentUrl);
                    const currentPageParam = parseInt(urlObj.searchParams.get('p') || '1', 10);
                    urlObj.searchParams.set('p', String(currentPageParam + 1));
                    return urlObj.href;
                } catch {
                    return null;
                }
            })();

            const nextUrl = nextHref ? toAbsoluteUrl(nextHref, currentUrl) : null;
            if (nextUrl && !seenPages.has(nextUrl)) {
                await crawlerInstance.addRequests([{
                    url: nextUrl,
                    userData: { pageNo: pageNo + 1 },
                }]);
            }
        }
    },

    failedRequestHandler: async ({ request }, error) => {
        if (error.message?.includes('403')) {
            log.warning(`Blocked (403): ${request.url} - skipping`);
        } else {
            log.error(`Failed: ${request.url}`, { error: error.message });
        }
    },
});

const startRequests = startUrls.map((url) => ({
    url,
    userData: { pageNo: 1 },
}));

await crawler.run(startRequests);
log.info(`Scraping finished. Total items saved: ${saved}`);
await Actor.exit();
