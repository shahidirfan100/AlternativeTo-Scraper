import { Actor, log } from 'apify';
import { CheerioCrawler } from 'crawlee';
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
    const resultsWanted = parsePositiveInteger(rawInput.results_wanted, 100, 'results_wanted');
    const maxPages = parsePositiveInteger(rawInput.max_pages, 20, 'max_pages');

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
        if (!keyword) log.warning('No startUrl/startUrls/url provided. Falling back to AlternativeTo homepage; consider passing a keyword for focused results.');
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

const findToolLinks = ($, baseUrl) => {
    const urls = new Set();
    $('a[href]').each((_, element) => {
        const href = $(element).attr('href');
        if (!href) return;
        if (/\/software\//i.test(href) || /alternativeto\.net\/software\//i.test(href)) {
            const absolute = toAbsoluteUrl(href, baseUrl);
            if (absolute) urls.add(absolute.split('#')[0]);
        }
    });
    return [...urls];
};

const findNextPage = ($, baseUrl) => {
    const relNext = $('a[rel="next"]').attr('href') || $('link[rel="next"]').attr('href');
    if (relNext) return toAbsoluteUrl(relNext, baseUrl);

    const pagerCandidates = $('a').filter((_, el) => /(^|\s)(next|›|»|>)(\s|$)/i.test($(el).text()));
    const fallback = pagerCandidates.first().attr('href');
    return fallback ? toAbsoluteUrl(fallback, baseUrl) : null;
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

await Actor.main(async () => {
    const rawInput = (await Actor.getInput()) ?? {};
    const { keyword, collectDetails, resultsWanted, maxPages, startUrls, proxyConfiguration } = normalizeInput(rawInput);

    log.info('Starting AlternativeTo scraper', {
        keyword: keyword || null,
        collectDetails,
        resultsWanted,
        maxPages,
        startUrlCount: startUrls.length,
    });

    const proxyConfig = await Actor.createProxyConfiguration(proxyConfiguration || { useApifyProxy: false });

    const startRequests = startUrls.map((url) => ({ url, userData: { label: 'LIST', pageNo: 1 } }));
    const seenLists = new Set(startUrls);
    const seenDetails = new Set();
    let saved = 0;
    let scheduledDetails = 0;

    const crawler = new CheerioCrawler({
        proxyConfiguration: proxyConfig,
        maxRequestRetries: 3,
        maxConcurrency: 10,
        requestHandlerTimeoutSecs: 60,
        useSessionPool: true,
        maxRequestsPerCrawl: Math.max(resultsWanted * (collectDetails ? 2 : 1) + maxPages + startRequests.length, 50),
        async requestHandler({ request, $, enqueueLinks, log: crawlerLog }) {
            const label = request.userData?.label ?? 'LIST';
            const pageNo = request.userData?.pageNo ?? 1;
            const currentUrl = request.loadedUrl ?? request.url;

            if (label === 'LIST') {
                const links = findToolLinks($, currentUrl);
                crawlerLog.info(`LIST page ${pageNo}: ${links.length} candidate tools found`);

                if (collectDetails) {
                    const remaining = Math.max(0, resultsWanted - saved - scheduledDetails);
                    if (remaining > 0) {
                        const uniqueLinks = links.filter((link) => !seenDetails.has(link)).slice(0, remaining);
                        uniqueLinks.forEach((link) => seenDetails.add(link));
                        scheduledDetails += uniqueLinks.length;

                        if (uniqueLinks.length) {
                            await enqueueLinks({ urls: uniqueLinks, userData: { label: 'DETAIL' } });
                            crawlerLog.debug(`Enqueued ${uniqueLinks.length} detail pages (remaining target: ${resultsWanted - saved})`);
                        }
                    }
                } else {
                    const remaining = Math.max(0, resultsWanted - saved);
                    const toPush = links.slice(0, remaining).map((link) => ({
                        title: null,
                        description: null,
                        category: null,
                        rating: null,
                        pricing: null,
                        url: link,
                        _source: 'alternativeto.net',
                    }));
                    if (toPush.length) {
                        await Actor.pushData(toPush);
                        saved += toPush.length;
                        crawlerLog.info(`Saved ${toPush.length} URLs from list (total ${saved}/${resultsWanted})`);
                    }
                }

                if (saved + scheduledDetails < resultsWanted && pageNo < maxPages) {
                    const nextPage = findNextPage($, currentUrl);
                    if (nextPage && !seenLists.has(nextPage)) {
                        seenLists.add(nextPage);
                        await enqueueLinks({ urls: [{ url: nextPage, userData: { label: 'LIST', pageNo: pageNo + 1 } }] });
                        crawlerLog.debug(`Queued next page: ${nextPage}`);
                    }
                }

                return;
            }

            if (label === 'DETAIL') {
                if (saved >= resultsWanted) return;

                try {
                    const item = extractDetailItem($, currentUrl);
                    await Actor.pushData(item);
                    saved += 1;
                    crawlerLog.info(`Saved detail ${saved}/${resultsWanted}: ${item.title || item.url}`);
                    if (saved >= resultsWanted) {
                        crawlerLog.info('Target reached, stopping crawler');
                        await crawler.autoscaledPool?.abort();
                    }
                } catch (error) {
                    crawlerLog.exception(error, `Failed to process detail page: ${currentUrl}`);
                } finally {
                    if (collectDetails && scheduledDetails > 0) scheduledDetails -= 1;
                }
            }
        },
        failedRequestHandler({ request, error, log: crawlerLog }) {
            crawlerLog.error(`Request ${request.url} failed after ${request.retryCount} retries: ${error.message}`);
        },
    });

    await crawler.run(startRequests);

    log.info(`Run finished. Saved ${saved} items${collectDetails ? ' with details' : ''}.`);
});
