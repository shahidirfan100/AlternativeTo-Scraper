import { Actor, log } from 'apify';
import { PlaywrightCrawler } from 'crawlee';
import { load as cheerioLoad } from 'cheerio';

const BASE_URL = 'https://alternativeto.net/';

const toAbsoluteUrl = (href, base = BASE_URL) => {
    try {
        return new URL(href, base).href;
    } catch {
        return null;
    }
};

const normalizeText = (text) => (text ? String(text).replace(/\s+/g, ' ').trim() : '');

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
    const collectDetails = rawInput.collectDetails !== false;
    const resultsWanted = parsePositiveInteger(rawInput.results_wanted, 50, 'results_wanted');
    const maxPages = parsePositiveInteger(rawInput.max_pages, 5, 'max_pages');

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

    addSource(rawInput.startUrl);
    addSource(rawInput.url);
    if (Array.isArray(rawInput.startUrls)) rawInput.startUrls.forEach(addSource);

    const normalizedStartUrls = [...new Set(sources.map((href) => toAbsoluteUrl(href)).filter(Boolean))];
    if (!normalizedStartUrls.length) {
        const fallbackUrl = buildSearchUrl(keyword);
        normalizedStartUrls.push(fallbackUrl);
        if (!keyword) log.warning('No startUrl/startUrls/url provided. Falling back to AlternativeTo homepage.');
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

const extractRating = ($) => {
    const ratingCandidate = $('[itemprop="ratingValue"]').attr('content')
        || $('[data-rating]').attr('data-rating')
        || $('[class*="rating"], [class*="stars"]').first().text();
    const parsed = parseFloat(normalizeText(ratingCandidate));
    return Number.isFinite(parsed) ? parsed : null;
};

const extractDetailItem = ($, requestUrl) => {
    const title = normalizeText(
        $('h1[itemprop="name"], h1.text-2xl, h1.title, .software-title, h1')
            .first()
            .text()
        || $('meta[property="og:title"]').attr('content')
        || $('title').text(),
    ) || null;

    const descriptionHtml = $('.description, .software-description, [class*="description"]').first().html()
        || $('meta[name="description"]').attr('content')
        || $('[itemprop="description"]').html()
        || '';
    const description = normalizeText(htmlToText(descriptionHtml)) || null;

    const category = normalizeText(
        $('a[href*="/category/"]').first().text()
        || $('[class*="breadcrumb"] a').eq(1).text()
        || $('.category').first().text(),
    ) || null;

    const pricing = normalizeText(
        $('[class*="license"], [class*="pricing"], .license-type, .price').first().text(),
    ) || null;

    const rating = extractRating($);

    return {
        title,
        description,
        category,
        rating,
        pricing,
        url: requestUrl,
    };
};

const randomDelay = (min = 1000, max = 3000) =>
    new Promise(r => setTimeout(r, min + Math.random() * (max - min)));

await Actor.main(async () => {
    const rawInput = (await Actor.getInput()) ?? {};
    const { keyword, collectDetails, resultsWanted, maxPages, startUrls, proxyConfiguration } = normalizeInput(rawInput);

    log.info('Starting AlternativeTo Playwright scraper', {
        keyword: keyword || null,
        collectDetails,
        resultsWanted,
        maxPages,
    });

    const proxyConfig = await Actor.createProxyConfiguration(proxyConfiguration || {
        useApifyProxy: true,
        apifyProxyGroups: ['RESIDENTIAL'],
    });

    let saved = 0;
    let scheduledDetails = 0;
    const seenDetails = new Set();
    const seenPages = new Set();

    const crawler = new PlaywrightCrawler({
        proxyConfiguration: proxyConfig,
        maxRequestRetries: 5,
        useSessionPool: true,
        sessionPoolOptions: {
            maxPoolSize: 10,
            sessionOptions: { maxUsageCount: 5 },
        },
        maxConcurrency: 2,
        requestHandlerTimeoutSecs: 180,
        navigationTimeoutSecs: 60,
        browserPoolOptions: {
            useFingerprints: true,
            fingerprintOptions: {
                fingerprintGeneratorOptions: {
                    browsers: ['chrome'],
                    operatingSystems: ['windows', 'macos'],
                    devices: ['desktop'],
                },
            },
        },
        preNavigationHooks: [
            async ({ page }) => {
                await page.route('**/*', (route) => {
                    const type = route.request().resourceType();
                    const url = route.request().url();
                    if (['image', 'font', 'media'].includes(type) ||
                        /googletagmanager|google-analytics|facebook|doubleclick|pinterest|adsense/.test(url)) {
                        return route.abort();
                    }
                    return route.continue();
                });

                await page.addInitScript(() => {
                    Object.defineProperty(navigator, 'webdriver', { get: () => false });
                    window.chrome = { runtime: {} };
                });
            },
        ],
        async requestHandler({ page, request, crawler: crawlerInstance }) {
            const { label = 'LIST', pageNo = 1 } = request.userData;
            const currentUrl = request.url;

            log.info(`Processing ${label}: ${currentUrl} (Page ${pageNo})`);

            await page.waitForLoadState('domcontentloaded');
            await randomDelay(1000, 2000);

            // Wait for potential Cloudflare challenge to clear
            if (await page.title().then(t => t.includes('Just a moment'))) {
                log.info('Cloudflare challenge detected, waiting...');
                await page.waitForNavigation({ timeout: 30000 }).catch(() => { });
            }

            const content = await page.content();
            const $ = cheerioLoad(content);

            if (label === 'LIST') {
                const links = [];
                $('a[href]').each((_, el) => {
                    const href = $(el).attr('href');
                    if (href && (/\/software\//i.test(href) || /alternativeto\.net\/software\//i.test(href))) {
                        const absolute = toAbsoluteUrl(href, currentUrl);
                        if (absolute) links.push(absolute.split('#')[0]);
                    }
                });

                const uniqueLinks = [...new Set(links)];
                log.info(`Found ${uniqueLinks.length} tools on list page`);

                if (collectDetails) {
                    for (const link of uniqueLinks) {
                        if (saved + scheduledDetails < resultsWanted && !seenDetails.has(link)) {
                            seenDetails.add(link);
                            scheduledDetails++;
                            await crawlerInstance.addRequests([{
                                url: link,
                                userData: { label: 'DETAIL' }
                            }]);
                        }
                    }
                } else {
                    const toPush = uniqueLinks.slice(0, resultsWanted - saved).map(url => ({ url, _source: 'alternativeto' }));
                    if (toPush.length) {
                        await Actor.pushData(toPush);
                        saved += toPush.length;
                    }
                }

                // Pagination
                if (saved + scheduledDetails < resultsWanted && pageNo < maxPages) {
                    const nextHref = $('a[rel="next"]').attr('href') || $('a:contains("Next")').attr('href');
                    const nextUrl = nextHref ? toAbsoluteUrl(nextHref, currentUrl) : null;

                    if (nextUrl && !seenPages.has(nextUrl)) {
                        seenPages.add(nextUrl);
                        await crawlerInstance.addRequests([{
                            url: nextUrl,
                            userData: { label: 'LIST', pageNo: pageNo + 1 }
                        }]);
                    }
                }
            } else if (label === 'DETAIL') {
                if (saved >= resultsWanted) return;

                try {
                    const item = extractDetailItem($, currentUrl);
                    await Actor.pushData(item);
                    saved++;
                    log.info(`Saved item ${saved}/${resultsWanted}: ${item.title}`);

                    if (saved >= resultsWanted) {
                        log.info('Results limit reached, stopping...');
                        await crawlerInstance.autoscaledPool?.abort();
                    }
                } catch (error) {
                    log.error(`Failed to extract detail: ${error.message}`);
                } finally {
                    scheduledDetails--;
                }
            }
        },
        failedRequestHandler({ request, error }) {
            log.error(`Request ${request.url} failed: ${error.message}`);
        },
    });

    const startRequests = startUrls.map(url => ({
        url,
        userData: { label: 'LIST', pageNo: 1 }
    }));

    await crawler.run(startRequests);
    log.info(`Scraping finished. Total items saved: ${saved}`);
});
