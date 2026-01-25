import { Actor, log } from 'apify';
import { PlaywrightCrawler } from 'crawlee';
import { load as cheerioLoad } from 'cheerio';

const BASE_URL = 'https://alternativeto.net/';
const PLATFORM_REGEX = /(windows|mac|macos|linux|android|ios|ipad|online|web|self-hosted|saas|chrome|firefox|edge|safari)/i;
const LICENSE_REGEX = /(free|open\s*source|opensource|paid|freemium|proprietary|commercial|trial|subscription|one[-\s]?time)/i;

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
        || softwareLd.offers?.priceCurrency,
    ) || null;

    const rating = extractRating($);

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
    ]);

    const license = normalizeText(
        tagTexts.find((text) => LICENSE_REGEX.test(text))
        || softwareLd.license
        || softwareLd.offers?.license
        || $('[class*="license"]').first().text(),
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
                const tools = [];
                // Target the app cards
                $('div.flex.flex-col.w-full.gap-3, div[data-testid="app-card"]').each((_, el) => {
                    const $card = $(el);
                    const $titleLink = $card.find('h2 a, a.no-link-color').first();
                    const title = normalizeText($titleLink.text());
                    const href = $titleLink.attr('href');
                    const url = href ? toAbsoluteUrl(href, currentUrl) : null;

                    if (!url || !url.includes('/software/')) return;

                    const description = normalizeText($card.find('p, .Description-module-scss-module__text').first().text());
                    const logoUrl = toAbsoluteUrl(
                        $card.find('img[data-testid^="icon-"]').attr('src') || $card.find('img').first().attr('src'),
                        currentUrl,
                    );
                    const likesRaw = $card.find('[class*="heart"] span, .ModernLikeButton-module-scss-module__xuujAq__heart span').text();
                    const likesParsed = parseInt(likesRaw.replace(/[^0-9]/g, ''), 10);

                    const tags = [];
                    $card.find('.flex.flex-wrap.gap-2 span, .flex.flex-wrap.gap-2 a').each((i, tag) => {
                        tags.push(normalizeText($(tag).text()));
                    });

                    // Platforms are usually links or tags with specific names
                    const platforms = uniqueStrings(tags.filter((t) => PLATFORM_REGEX.test(t)));
                    const license = tags.find((t) => LICENSE_REGEX.test(t)) || null;
                    const pricing = license || null;

                    tools.push({
                        title,
                        url: url.split('#')[0],
                        description,
                        logoUrl,
                        likes: Number.isFinite(likesParsed) ? likesParsed : null,
                        platforms,
                        license,
                        pricing,
                        _source: 'alternativeto',
                    });
                });

                log.info(`Found ${tools.length} tool cards on list page`);

                for (const tool of tools) {
                    if (saved >= resultsWanted) break;

                    if (collectDetails) {
                        if (!seenDetails.has(tool.url)) {
                            seenDetails.add(tool.url);
                            scheduledDetails++;
                            await crawlerInstance.addRequests([{
                                url: tool.url,
                                userData: { label: 'DETAIL', toolPreview: tool }
                            }]);
                        }
                    } else if (!seenDetails.has(tool.url)) {
                        seenDetails.add(tool.url);
                        await Actor.pushData(tool);
                        saved++;
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

                const toolPreview = request.userData.toolPreview || {};

                try {
                    const item = extractDetailItem($, currentUrl);
                    // Merge preview data with detail data (detail wins if available)
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
                        log.info('Results limit reached, stopping...');
                        await crawlerInstance.autoscaledPool?.abort();
                    }
                } catch (error) {
                    log.error(`Failed to extract detail for ${currentUrl}: ${error.message}`);
                    // Push at least the preview data if detail fails
                    if (toolPreview.title) {
                        await Actor.pushData(toolPreview);
                        saved++;
                    }
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
