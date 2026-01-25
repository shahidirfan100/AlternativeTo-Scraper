import { Actor, log } from 'apify';
import { PlaywrightCrawler } from 'crawlee';
import { firefox } from 'playwright';
import { load as cheerioLoad } from 'cheerio';

const BASE_URL = 'https://alternativeto.net/';
const PLATFORM_REGEX = /(windows|mac|macos|linux|android|ios|ipad|online|web|self-hosted|saas|chrome|firefox|edge|safari)/i;
const LICENSE_REGEX = /(free|open\s*source|opensource|paid|freemium|proprietary|commercial|trial|subscription|one[-\s]?time)/i;
const USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:147.0) Gecko/20100101 Firefox/147.0',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 15.7; rv:147.0) Gecko/20100101 Firefox/147.0',
    'Mozilla/5.0 (X11; Linux x86_64; rv:147.0) Gecko/20100101 Firefox/147.0',
];
const DEFAULT_START_URLS = [
    'https://alternativeto.net/category/ai-tools/ai-image-generator/',
];

const toAbsoluteUrl = (href, base = BASE_URL) => {
    try {
        return new URL(href, base).href;
    } catch {
        return null;
    }
};

const normalizeText = (text) => (text ? String(text).replace(/\s+/g, ' ').trim() : '');
const uniqueStrings = (values = []) => [...new Set(values.map(normalizeText).filter(Boolean))];

const htmlToText = (html) => {
    if (!html) return '';
    const $ = cheerioLoad(html);
    $('script, style, noscript, iframe').remove();
    return normalizeText($.root().text());
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

// Helper to extract tags based on section header
const evaluateText = (text) => (text ? String(text).replace(/\s+/g, ' ').trim() : '');

const extractTagsByHeader = ($container, headerText) => {
    const HEADER_REGEX = new RegExp(headerText, 'i');
    const $header = $container.find('h4').filter((_, el) => HEADER_REGEX.test(evaluateText($(el).text())));
    if (!$header.length) return [];

    // The list is usually the next sibling UL or inside a div following the header
    const $list = $header.next('ul, div').find('li, span, a');
    const tags = [];
    $list.each((_, el) => {
        const txt = normalizeText($(el).text());
        if (txt) tags.push(txt);
    });
    return [...new Set(tags)]; // Unique
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
        // Normalize: remove /about/ or /reviews/ to get the main list page
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

const randomDelay = (min = 100, max = 300) =>
    new Promise((r) => setTimeout(r, min + Math.random() * (max - min)));

const getRandomUA = () => USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];

const buildLaunchContext = (ua) => ({
    launcher: firefox,
    launchOptions: {
        headless: true,
        serviceWorkers: 'block', // Block service workers for performance
        reduceMotion: 'reduce',
    },
    userAgent: ua,
});

await Actor.main(async () => {
    const rawInput = (await Actor.getInput()) ?? {};
    const { keyword, resultsWanted, maxPages, startUrls, proxyConfiguration } = normalizeInput(rawInput);

    log.info('Starting AlternativeTo Playwright-only scraper', {
        keyword: keyword || null,
        resultsWanted,
        maxPages,
    });

    const proxyConfig = await Actor.createProxyConfiguration(proxyConfiguration || {
        useApifyProxy: true,
        apifyProxyGroups: ['RESIDENTIAL'],
    });

    const runUserAgent = getRandomUA();
    let saved = 0;
    const seenDetails = new Set();
    const seenPages = new Set();

    const listCrawler = new PlaywrightCrawler({
        proxyConfiguration: proxyConfig,
        maxRequestRetries: 3,
        useSessionPool: true,
        sessionPoolOptions: {
            maxPoolSize: 8,
            sessionOptions: { maxUsageCount: 4 },
        },
        minConcurrency: 1,
        maxConcurrency: 2,
        requestHandlerTimeoutSecs: 90,
        navigationTimeoutSecs: 45,
        launchContext: buildLaunchContext(runUserAgent),
        browserPoolOptions: {
            useFingerprints: true,
            fingerprintOptions: {
                fingerprintGeneratorOptions: {
                    browsers: ['firefox'],
                    operatingSystems: ['windows', 'macos'],
                    devices: ['desktop'],
                },
            },
            retireInstanceAfterRequestCount: 10,
        },
        preNavigationHooks: [
            async ({ page }) => {
                await page.context().setExtraHTTPHeaders({
                    'user-agent': runUserAgent,
                    'accept-language': 'en-US,en;q=0.9',
                    'upgrade-insecure-requests': '1',
                    referer: BASE_URL,
                });
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

                await page.addInitScript(({ ua }) => {
                    Object.defineProperty(navigator, 'webdriver', { get: () => false });
                    window.chrome = { runtime: {} };
                    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
                    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
                    Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 });
                    Object.defineProperty(navigator, 'userAgent', { get: () => ua });
                }, { ua: runUserAgent });
            },
        ],
        async requestHandler({ page, request, crawler: crawlerInstance }) {
            const { pageNo = 1 } = request.userData;
            const currentUrl = request.url;
            seenPages.add(currentUrl);

            log.info(`Processing LIST via Playwright: ${currentUrl} (Page ${pageNo})`);
            await page.goto(currentUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
            await randomDelay(250, 600);

            if (await page.title().then((t) => t.includes('Just a moment'))) {
                log.info('Cloudflare challenge on list, waiting briefly...');
                await page.waitForTimeout(3000);
            }

            const content = await page.content();
            const $ = cheerioLoad(content);

            const tools = [];

            // Container Strategy: Find items with the specific structure (H2 + content)
            // The browser check suggested: div[data-testid="app-listing-item"] OR divs with h2.Heading-module...
            const $cards = $('div[data-testid="app-listing-item"], h2.Heading-module-scss-module__br2CUG__h2').closest('div[class*="rounded"]');
            const $finalCards = $cards.length ? $cards : $('div.flex.flex-col.gap-3 > div');

            $finalCards.each((_, el) => {
                const $card = $(el);

                // 1. Title
                const $titleLink = $card.find('h2[class*="Heading-module"], h2 a, h2').first();
                const title = normalizeText($titleLink.text());
                const href = $titleLink.find('a').attr('href') || $titleLink.attr('href') || $card.find('a[href*="/software/"]').first().attr('href');
                const toolUrl = href ? toAbsoluteUrl(href, currentUrl) : null;

                if (!toolUrl || !toolUrl.includes('/software/')) return;

                // 2. Description
                const description = normalizeText(
                    $card.find('div.md_Compact p').first().text()
                    || $card.find('#app-description p').first().text()
                    || $card.find('p[class*="Description"], p').first().text()
                );

                // 3. Logo
                const logoUrl = toAbsoluteUrl(
                    $card.find('img[data-testid^="icon-"]').attr('src') || $card.find('img').first().attr('src'),
                    currentUrl,
                );

                // 4. Likes
                const likesRaw = $card.find('[aria-label^="Like"] span, [class*="heart"] span').text();
                const likesParsed = parseInt(likesRaw.replace(/[^0-9]/g, ''), 10);

                // 5. Cost & License (from "Cost / License" header)
                const costLicenseTags = extractTagsByHeader($card, 'Cost / License') || [];
                const cost = costLicenseTags[0] || null;
                const license = costLicenseTags[1] || costLicenseTags.find(t => LICENSE_REGEX.test(t)) || null;
                const pricing = cost || null;

                // 6. Application Types
                const appTypes = extractTagsByHeader($card, 'Application Types');

                // 7. Platforms
                const platforms = extractTagsByHeader($card, 'Platforms');

                // 8. Origins
                const origins = extractTagsByHeader($card, 'Made in');

                // 9. Best Alternative (text check)
                const bestAlternativeText = normalizeText($card.find('.text-meta').first().text());

                // 10. Images (screen capture thumbs)
                const images = [];
                $card.find('div[aria-label="Open image in lightbox"] img').each((_, img) => {
                    images.push(toAbsoluteUrl($(img).attr('src'), currentUrl));
                });

                // 11. Rating (Often not present in list, check fallback)
                const ratingRaw = $card.find('div.relative.flex-shrink-0').text();
                const ratingParsed = parseFloat(normalizeText(ratingRaw));

                tools.push({
                    title,
                    url: toolUrl.split('#')[0],
                    description,
                    logoUrl,
                    likes: Number.isFinite(likesParsed) ? likesParsed : null,
                    rating: Number.isFinite(ratingParsed) ? ratingParsed : null,
                    cost,
                    license,
                    pricing,
                    applicationTypes: appTypes.length ? appTypes : null,
                    platforms: platforms.length ? platforms : null,
                    origins: origins.length ? origins : null,
                    bestAlternative: bestAlternativeText || null,
                    images: images.length ? images : null,
                    _source: 'alternativeto',
                });
            });

            log.info(`Found ${tools.length} tool cards on list page`);

            for (const tool of tools) {
                if (saved >= resultsWanted) break;
                if (!seenDetails.has(tool.url)) {
                    seenDetails.add(tool.url);
                    await Actor.pushData(tool);
                    saved++;
                }
            }

            if (saved < resultsWanted && pageNo < maxPages) {
                const nextHref = $('a[rel="next"]').attr('href') || $('a:contains("Next")').attr('href');
                const nextUrl = nextHref ? toAbsoluteUrl(nextHref, currentUrl) : null;
                if (nextUrl && !seenPages.has(nextUrl)) {
                    seenPages.add(nextUrl);
                    await crawlerInstance.addRequests([{
                        url: nextUrl,
                        userData: { pageNo: pageNo + 1 },
                    }]);
                }
            }
        },
        failedRequestHandler({ request, error }) {
            log.error(`List request ${request.url} failed: ${error.message}`);
        },
    });

    const startRequests = startUrls.map((url) => ({
        url,
        userData: { pageNo: 1 },
    }));

    await listCrawler.run(startRequests);
    log.info(`Scraping finished. Total items saved: ${saved}`);
});
