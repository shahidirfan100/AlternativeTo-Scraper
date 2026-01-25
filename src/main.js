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

const normalizeInput = (rawInput) => {
    const keyword = normalizeText(rawInput.keyword);
    const collectDetails = rawInput.collectDetails === true; // Default to false to avoid Cloudflare on details
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
        collectDetails,
        resultsWanted,
        maxPages,
        startUrls: normalizedStartUrls,
        proxyConfiguration: rawInput.proxyConfiguration,
    };
};

const extractRating = ($, softwareLd = {}) => {
    const ratingCandidate = $('[itemprop="ratingValue"]').attr('content')
        || $('[data-rating]').attr('data-rating')
        || $('[class*="rating"], [class*="stars"]').first().text();
    const parsed = parseFloat(normalizeText(ratingCandidate));
    if (Number.isFinite(parsed)) return parsed;
    const ldRating = parseFloat(
        softwareLd.aggregateRating?.ratingValue
        || softwareLd.aggregateRating?.rating
        || softwareLd.ratingValue
        || softwareLd.rating,
    );
    return Number.isFinite(ldRating) ? ldRating : null;
};

const parseJsonLd = ($) => {
    const blocks = [];
    $('script[type="application/ld+json"]').each((_, el) => {
        try {
            const content = $(el).contents().text();
            if (!content) return;
            const parsed = JSON.parse(content);
            if (Array.isArray(parsed)) blocks.push(...parsed);
            else blocks.push(parsed);
        } catch {
            // ignore malformed JSON-LD
        }
    });
    return blocks;
};

const extractFieldByLabel = ($, label) => {
    const matcher = (i, el) => normalizeText($(el).text()).toLowerCase().startsWith(label.toLowerCase());
    const $labelEl = $('div, span, p, li, dt').filter(matcher).first();
    if ($labelEl.length) {
        const candidate = $labelEl.next().text() || $labelEl.parent().text();
        return normalizeText(candidate);
    }
    return null;
};

const extractDetailItem = ($, requestUrl) => {
    const jsonLdBlocks = parseJsonLd($);
    const softwareLd = jsonLdBlocks.find(
        (obj) => obj && (obj['@type'] === 'SoftwareApplication' || obj['@type'] === 'Product'),
    ) || {};

    const title = normalizeText(
        $('h1[itemprop="name"], h1.text-2xl, h1.title, .software-title, h1')
            .first()
            .text()
        || $('meta[property="og:title"]').attr('content')
        || softwareLd.name
        || $('title').text(),
    ) || null;

    const descriptionHtml = $('.description, .software-description, [class*="description"]').first().html()
        || $('meta[name="description"]').attr('content')
        || $('[itemprop="description"]').html()
        || softwareLd.description
        || '';
    const description = normalizeText(htmlToText(descriptionHtml)) || null;

    const category = normalizeText(
        $('a[href*="/category/"]').first().text()
        || $('[class*="breadcrumb"] a').eq(1).text()
        || $('.category').first().text()
        || softwareLd.applicationCategory,
    ) || null;

    const pricing = normalizeText(
        $('[class*="license"], [class*="pricing"], .license-type, .price').first().text()
        || softwareLd.offers?.price
        || softwareLd.offers?.priceCurrency
        || extractFieldByLabel($, 'pricing')
        || extractFieldByLabel($, 'price'),
    ) || null;

    const rating = extractRating($, softwareLd);

    const developer = normalizeText(
        $('[itemprop="publisher"] [itemprop="name"]').text()
        || $('[data-testid="developer-link"]').text()
        || $('a[href*="/developer/"]').first().text()
        || softwareLd.publisher?.name
        || softwareLd.manufacturer?.name,
    ) || null;

    const logoUrl = toAbsoluteUrl(
        $('meta[property="og:image"]').attr('content')
        || $('.software-icon img, img[data-testid^="icon-"]').first().attr('src')
        || softwareLd.image,
        requestUrl,
    );

    const tagTexts = [];
    $('a[href*="/license/"], a[href*="/platform/"], .flex.flex-wrap.gap-2 a, .flex.flex-wrap.gap-2 span, [class*="badge"], [class*="tag"]').each((_, el) => {
        tagTexts.push(normalizeText($(el).text()));
    });

    const platforms = uniqueStrings([
        ...$('a[href*="/platform/"]').map((_, el) => normalizeText($(el).text())).get(),
        ...(Array.isArray(softwareLd.operatingSystem) ? softwareLd.operatingSystem : [softwareLd.operatingSystem]),
        ...tagTexts.filter((text) => PLATFORM_REGEX.test(text)),
        extractFieldByLabel($, 'platforms'),
    ]);

    const license = normalizeText(
        tagTexts.find((text) => LICENSE_REGEX.test(text))
        || softwareLd.license
        || softwareLd.offers?.license
        || $('[class*="license"]').first().text()
        || extractFieldByLabel($, 'license'),
    ) || null;

    const likesText = $('[data-testid*="heart"] span, [class*="heart"] span, [class*="likes"] span').first().text();
    const likes = Number.parseInt(likesText.replace(/\D+/g, ''), 10);

    return {
        title,
        description,
        category,
        rating,
        pricing,
        developer,
        license,
        platforms,
        logoUrl,
        likes: Number.isFinite(likes) ? likes : null,
        url: requestUrl,
    };
};

const randomDelay = (min = 150, max = 450) =>
    new Promise((r) => setTimeout(r, min + Math.random() * (max - min)));

const getRandomUA = () => USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];

const buildLaunchContext = (ua) => ({
    launcher: firefox,
    launchOptions: {
        headless: true,
    },
    userAgent: ua,
});

await Actor.main(async () => {
    const rawInput = (await Actor.getInput()) ?? {};
    const { keyword, collectDetails, resultsWanted, maxPages, startUrls, proxyConfiguration } = normalizeInput(rawInput);

    log.info('Starting AlternativeTo Playwright-only scraper', {
        keyword: keyword || null,
        collectDetails,
        resultsWanted,
        maxPages,
    });

    const proxyConfig = await Actor.createProxyConfiguration(proxyConfiguration || {
        useApifyProxy: true,
        apifyProxyGroups: ['RESIDENTIAL'],
    });

    const DETAIL_CONCURRENCY = 5;
    const runUserAgent = getRandomUA();
    let saved = 0;
    const detailRequests = [];
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
            // Broadened selector to catch cards on Category pages AND Product Alternative pages
            // Product pages often list alternatives in a section, but the cards usually have data-testid="app-card"
            // or are within a specific grid.
            const $cards = $('div[data-testid="app-card"], li div[data-testid="app-card"], div.flex.flex-col.gap-3 > div');

            $cards.each((_, el) => {
                const $card = $(el);
                const $titleLink = $card.find('h2 a, a.no-link-color').first();
                const title = normalizeText($titleLink.text());
                const href = $titleLink.attr('href');
                const toolUrl = href ? toAbsoluteUrl(href, currentUrl) : null;

                if (!toolUrl || !toolUrl.includes('/software/')) return;

                const description = normalizeText(
                    $card.find('p').first().text()
                    || $card.find('[class*="description"], [class*="Description"]').first().text()
                    || $card.find('.text-gray-500, .text-base').first().text()
                );
                const logoUrl = toAbsoluteUrl(
                    $card.find('img[data-testid^="icon-"]').attr('src') || $card.find('img').first().attr('src'),
                    currentUrl,
                );
                const tags = [];
                $card.find('.flex.flex-wrap[class*="gap-"] span, .flex.flex-wrap[class*="gap-"] a, [class*="badge"], li').each((i, tag) => {
                    tags.push(normalizeText($(tag).text()));
                });

                const likesRaw = $card.find('[class*="heart"] span, .ModernLikeButton-module-scss-module__xuujAq__heart span').text();
                const likesParsed = parseInt(likesRaw.replace(/[^0-9]/g, ''), 10);

                // Ratings are often in a specific div on list view now
                // Robust Rating extraction
                const ratingRaw = $card.find('div.relative.flex-shrink-0').text()
                    || $card.find('[itemprop="ratingValue"], [data-rating], [class*="rating"], [class*="Score"]').first().text();
                const ratingParsed = parseFloat(normalizeText(ratingRaw));

                const platforms = uniqueStrings(tags.filter((t) => PLATFORM_REGEX.test(t)));
                const license = tags.find((t) => LICENSE_REGEX.test(t)) || null;
                const pricing = license || null;

                tools.push({
                    title,
                    url: toolUrl.split('#')[0],
                    description,
                    logoUrl,
                    likes: Number.isFinite(likesParsed) ? likesParsed : null,
                    rating: Number.isFinite(ratingParsed) ? ratingParsed : null,
                    platforms,
                    license,
                    pricing,
                    _source: 'alternativeto',
                });
            });

            log.info(`Found ${tools.length} tool cards on list page`);

            for (const tool of tools) {
                if (saved + detailRequests.length >= resultsWanted) break;

                if (collectDetails) {
                    if (!seenDetails.has(tool.url)) {
                        seenDetails.add(tool.url);
                        detailRequests.push({
                            url: tool.url,
                            userData: { toolPreview: tool },
                        });
                    }
                } else if (!seenDetails.has(tool.url)) {
                    seenDetails.add(tool.url);
                    await Actor.pushData(tool);
                    saved++;
                }
            }

            if (saved + detailRequests.length < resultsWanted && pageNo < maxPages) {
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

    if (collectDetails && detailRequests.length && saved < resultsWanted) {
        log.info(`Processing detail pages via Playwright. Pending: ${detailRequests.length}`);
        const detailCrawler = new PlaywrightCrawler({
            proxyConfiguration: proxyConfig,
            maxRequestRetries: 3,
            useSessionPool: true,
            sessionPoolOptions: {
                maxPoolSize: 8,
                sessionOptions: { maxUsageCount: 4 },
            },
            maxConcurrency: DETAIL_CONCURRENCY,
            requestHandlerTimeoutSecs: 120,
            navigationTimeoutSecs: 60,
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
                if (saved >= resultsWanted) return;
                const currentUrl = request.url;
                const toolPreview = request.userData.toolPreview || {};

                log.info(`Processing DETAIL via Playwright: ${currentUrl}`);
                await page.goto(currentUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
                await randomDelay(250, 600);

                if (await page.title().then((t) => t.includes('Just a moment'))) {
                    log.info('Cloudflare challenge on detail, waiting briefly...');
                    await page.waitForTimeout(3000);
                }

                const content = await page.content();
                const $ = cheerioLoad(content);

                try {
                    const item = extractDetailItem($, currentUrl);
                    const mergedPlatforms = uniqueStrings([
                        ...(Array.isArray(item.platforms) ? item.platforms : []),
                        ...(Array.isArray(toolPreview.platforms) ? toolPreview.platforms : []),
                    ]);

                    const finalItem = {
                        _source: 'alternativeto',
                        title: item.title || toolPreview.title || null,
                        description: item.description || toolPreview.description || null,
                        category: item.category || toolPreview.category || null,
                        rating: item.rating ?? toolPreview.rating ?? null,
                        pricing: item.pricing || toolPreview.pricing || toolPreview.license || null,
                        license: item.license || toolPreview.license || item.pricing || null,
                        likes: item.likes ?? toolPreview.likes ?? null,
                        logoUrl: item.logoUrl || toolPreview.logoUrl || null,
                        platforms: mergedPlatforms.length ? mergedPlatforms : null,
                        developer: item.developer || toolPreview.developer || null,
                        url: currentUrl.split('#')[0],
                    };

                    await Actor.pushData(finalItem);
                    saved++;
                    log.info(`Saved item ${saved}/${resultsWanted}: ${finalItem.title}`);

                    if (saved >= resultsWanted) {
                        await crawlerInstance.autoscaledPool?.abort();
                    }
                } catch (error) {
                    log.error(`Failed to extract detail for ${currentUrl}: ${error.message}`);
                    if (toolPreview.title) {
                        await Actor.pushData({ ...toolPreview, _source: 'alternativeto' });
                        saved++;
                    }
                }
            },
            failedRequestHandler({ request, error }) {
                log.error(`Detail request ${request.url} failed: ${error.message}`);
            },
        });

        await detailCrawler.run(detailRequests);
    }

    log.info(`Scraping finished. Total items saved: ${saved}`);
});
