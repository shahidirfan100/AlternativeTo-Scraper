import { Actor } from 'apify';
import log from '@apify/log';
import { PlaywrightCrawler, createPlaywrightRouter } from 'crawlee';
import { load as cheerioLoad } from 'cheerio';
import { firefox } from 'playwright';
import vm from 'node:vm';

await Actor.init();

const BASE_URL = 'https://alternativeto.net/';
const DEFAULT_START = 'https://alternativeto.net/category/ai-tools/ai-image-generator/';
const TOOL_URL_RE = /^https:\/\/(?:www\.)?alternativeto\.net\/software\/[^/?#]+\/?$/i;
const ALT_DOMAIN_RE = /(?:^|\.)alternativeto\.net$/i;
const PAGE_KIND = Object.freeze({
    SEARCH: 'search',
    CATEGORY: 'category',
    SOFTWARE: 'software',
    OTHER: 'other',
});
const LICENSE_RE = /(free|open\s*source|opensource|paid|freemium|proprietary|commercial|trial|subscription|one[-\s]?time)/i;
const PRICING_RE = /(free|paid|freemium|subscription|trial|one[-\s]?time|lifetime)/i;
const LICENSE_TYPE_RE = /(open\s*source|opensource|proprietary|commercial|apache|mit|gpl|bsd|mozilla|agpl|lgpl|mpl|cc0)/i;
const BLOCKED_TITLES = [/access denied/i, /captcha/i, /forbidden/i, /verify/i];
const BLOCKED_TYPES = new Set(['image', 'font', 'media', 'stylesheet']);
const TRACKERS = ['google-analytics', 'googletagmanager', 'doubleclick', 'facebook', 'ads', 'pinterest'];
const FAST_SCRAPE_CONFIG = Object.freeze({
    fastListingMode: true,
    requestDelaySecs: 0,
    maxConcurrency: 5,
});

const REGION_DISPLAY = new Intl.DisplayNames(['en'], { type: 'region' });

const txt = (v) => (v ? String(v).replace(/\s+/g, ' ').trim() : '');
const uniq = (value) => {
    if (value === null || value === undefined) return [];
    const list = Array.isArray(value)
        ? value
        : typeof value === 'string'
            ? value.split(/[|,;/]+/)
            : typeof value === 'object'
                ? Object.values(value)
                : [value];
    return [...new Set(list.map((v) => txt(typeof v === 'object' ? v?.name ?? v?.title ?? '' : v)).filter(Boolean))];
};

const absUrl = (href, base = BASE_URL) => {
    const clean = txt(href);
    if (!clean) return null;
    try {
        return new URL(clean, base).href;
    } catch {
        return null;
    }
};

const classifyPageKind = (urlValue) => {
    try {
        const u = new URL(urlValue);
        const path = u.pathname.toLowerCase();
        if (path.startsWith('/browse/search/')) return PAGE_KIND.SEARCH;
        if (path.startsWith('/category/')) return PAGE_KIND.CATEGORY;
        if (/^\/software\/[^/]+\/?$/.test(path)) return PAGE_KIND.SOFTWARE;
        return PAGE_KIND.OTHER;
    } catch {
        return PAGE_KIND.OTHER;
    }
};

const normalizeStartUrl = (candidate) => {
    const absolute = absUrl(candidate);
    if (!absolute) return null;

    try {
        const u = new URL(absolute);
        if (!ALT_DOMAIN_RE.test(u.hostname)) return null;

        u.hash = '';
        u.protocol = 'https:';
        u.hostname = 'alternativeto.net';

        const path = u.pathname.replace(/\/+/g, '/').replace(/\/$/, '') || '/';

        if (path === '/software' && txt(u.searchParams.get('q'))) {
            u.pathname = '/browse/search/';
        } else if (/^\/software\/[^/]+\/(?:about|reviews|alternatives)$/i.test(path)) {
            u.pathname = `${path.split('/').slice(0, 3).join('/')}/`;
        } else if (/^\/software\/[^/]+$/i.test(path)) {
            u.pathname = `${path}/`;
        } else if (/^\/category\/.+/i.test(path) && !path.endsWith('/')) {
            u.pathname = `${path}/`;
        } else if (/^\/browse\/search$/i.test(path)) {
            u.pathname = '/browse/search/';
        }

        return u.href;
    } catch {
        return absolute;
    }
};

const blockedStartFallbacks = (blockedUrl) => {
    const candidates = [];
    const pushCandidate = (url) => {
        const normalized = normalizeStartUrl(url);
        if (normalized) candidates.push(normalized);
    };

    try {
        const u = new URL(blockedUrl);
        const path = u.pathname.toLowerCase();
        const withAltHost = new URL(u.href);
        withAltHost.hostname = u.hostname === 'www.alternativeto.net' ? 'alternativeto.net' : 'www.alternativeto.net';
        pushCandidate(withAltHost.href);

        if (path === '/category/ai-tools/' || path === '/category/ai-tools') {
            pushCandidate('https://alternativeto.net/category/ai-tools/ai-image-generator/');
            pushCandidate('https://alternativeto.net/browse/search/?q=AI%20tools');
            pushCandidate('https://alternativeto.net/browse/search/?q=AI%20image%20generator');
        } else if (path.startsWith('/category/')) {
            const segments = path.split('/').filter(Boolean);
            if (segments.length >= 2) {
                pushCandidate(`https://alternativeto.net/${segments[0]}/${segments[1]}/`);
            }
        } else if (path.startsWith('/browse/search/')) {
            const q = txt(u.searchParams.get('q'));
            if (q) {
                pushCandidate(`https://alternativeto.net/browse/search/?q=${encodeURIComponent(q)}&p=2`);
            }
            pushCandidate(DEFAULT_START);
        }
    } catch {
        // Ignore malformed input URL and return empty fallback list.
    }

    return [...new Set(candidates.filter((candidate) => candidate !== blockedUrl))];
};

const toolUrl = (href, base = BASE_URL) => {
    const url = absUrl(href, base);
    if (!url) return null;
    const clean = url.split('#')[0].replace(/\/about\/?$/i, '/').replace(/\/reviews\/?$/i, '/');
    return TOOL_URL_RE.test(clean) ? clean : null;
};

const hasPricingToken = (value) => PRICING_RE.test(txt(value));
const hasLicenseToken = (value) => LICENSE_TYPE_RE.test(txt(value));

const isNoiseFieldValue = (value) => {
    const clean = txt(value).toLowerCase();
    if (!clean) return true;
    if (clean === 'application type' || clean === 'cost / license' || clean === 'origin' || clean === 'platforms') return true;
    return false;
};

const intVal = (v) => {
    const m = txt(v).match(/(\d[\d,]*)/);
    if (!m) return null;
    const n = Number.parseInt(m[1].replaceAll(',', ''), 10);
    return Number.isFinite(n) ? n : null;
};

const floatVal = (v) => {
    const m = txt(v).match(/(\d+(?:\.\d+)?)/);
    if (!m) return null;
    const n = Number.parseFloat(m[1]);
    return Number.isFinite(n) ? n : null;
};

const numInput = (v, fallback, name, max = Number.MAX_SAFE_INTEGER) => {
    if (v === undefined || v === null || v === '') return fallback;
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`Input "${name}" must be a positive integer.`);
    return Math.min(Math.floor(n), max);
};

const cleanItem = (raw) => {
    if (!raw || typeof raw !== 'object') return null;
    const url = toolUrl(raw.url);
    if (!url) return null;
    const rating = Number.isFinite(raw.rating) ? raw.rating : floatVal(raw.rating);
    const likes = Number.isFinite(raw.likes) ? Math.floor(raw.likes) : intVal(raw.likes);
    const applicationTypes = uniq(raw.applicationTypes || []);
    const category = txt(raw.category) || applicationTypes[0] || null;
    const images = uniq((raw.images || []).map((img) => absUrl(img, url)).filter(Boolean));

    let pricing = txt(raw.pricing);
    let cost = txt(raw.cost);
    let license = txt(raw.license);

    const categoryValues = new Set([txt(category).toLowerCase(), ...applicationTypes.map((v) => txt(v).toLowerCase())].filter(Boolean));
    if (categoryValues.has(pricing.toLowerCase())) pricing = '';
    if (categoryValues.has(cost.toLowerCase())) cost = '';
    if (categoryValues.has(license.toLowerCase())) license = '';

    if (!pricing && hasPricingToken(cost)) pricing = cost;
    if (!license && hasLicenseToken(cost)) license = cost;
    if (!cost && (pricing || license)) cost = uniq([pricing, license]).join(' | ');

    return {
        title: txt(raw.title) || null,
        description: txt(raw.description) || null,
        category,
        rating: Number.isFinite(rating) ? rating : null,
        pricing: pricing || null,
        cost: cost || null,
        license: license || null,
        likes: Number.isFinite(likes) ? likes : null,
        platforms: uniq(raw.platforms || []) || null,
        applicationTypes: applicationTypes.length ? applicationTypes : null,
        images: images.length ? images : null,
        origins: uniq(raw.origins || []) || null,
        bestAlternative: txt(raw.bestAlternative) || null,
        developer: txt(raw.developer) || null,
        logoUrl: absUrl(raw.logoUrl, url),
        url,
        _source: 'alternativeto',
    };
};

const mergeItem = (a, b) => {
    if (!a) return b;
    if (!b) return a;
    const pick = (current, incoming) => (txt(current) ? current : (txt(incoming) ? incoming : null));

    return {
        ...a,
        title: pick(a.title, b.title),
        description: txt(b.description).length > txt(a.description).length ? b.description : a.description,
        category: pick(a.category, b.category),
        pricing: pick(a.pricing, b.pricing),
        cost: pick(a.cost, b.cost),
        license: pick(a.license, b.license),
        bestAlternative: pick(a.bestAlternative, b.bestAlternative),
        developer: pick(a.developer, b.developer),
        logoUrl: pick(a.logoUrl, b.logoUrl),
        rating: Number.isFinite(a.rating) ? a.rating : (Number.isFinite(b.rating) ? b.rating : null),
        likes: Number.isFinite(a.likes) ? a.likes : (Number.isFinite(b.likes) ? b.likes : null),
        platforms: uniq([...(a.platforms || []), ...(b.platforms || [])]) || null,
        applicationTypes: uniq([...(a.applicationTypes || []), ...(b.applicationTypes || [])]) || null,
        images: uniq([...(a.images || []), ...(b.images || [])]) || null,
        origins: uniq([...(a.origins || []), ...(b.origins || [])]) || null,
    };
};

const parseJson = (s) => {
    try {
        return JSON.parse(s);
    } catch {
        return null;
    }
};

const countryFromCode = (code) => {
    const clean = txt(code).toUpperCase();
    if (!/^[A-Z]{2}$/.test(clean)) return null;
    try {
        return REGION_DISPLAY.of(clean) || clean;
    } catch {
        return clean;
    }
};

const collectNextFlightEntries = ($) => {
    const scripts = $('script')
        .toArray()
        .map((el) => $(el).text())
        .filter((text) => text && text.includes('self.__next_f.push('));

    const collected = [];
    for (const script of scripts) {
        try {
            const context = {
                self: { __next_f: { push: (entry) => collected.push(entry) } },
            };
            vm.runInNewContext(script, context, { timeout: 120 });
        } catch {
            // Ignore malformed chunks and keep parsing the rest.
        }
    }
    return collected;
};

const parseNextFlightRecordMap = (entries) => {
    const records = new Map();
    const stringEntries = entries
        .filter((entry) => Array.isArray(entry) && typeof entry[1] === 'string')
        .map((entry) => entry[1]);

    for (const chunk of stringEntries) {
        const lines = chunk.split('\n');
        for (const line of lines) {
            const m = line.match(/^([A-Za-z0-9]+):(.*)$/);
            if (!m) continue;
            const [, key, jsonValue] = m;
            const parsed = parseJson(jsonValue);
            if (parsed !== null) records.set(key, parsed);
        }
    }

    return records;
};

const collectAppsFromUnknownTree = (root) => {
    const apps = [];
    const seenObjects = new WeakSet();

    const walk = (node) => {
        if (!node || typeof node !== 'object') return;
        if (seenObjects.has(node)) return;
        seenObjects.add(node);

        if (Array.isArray(node)) {
            for (const child of node) walk(child);
            return;
        }

        if (Array.isArray(node.items)) {
            for (const item of node.items) {
                if (item && typeof item === 'object') apps.push(item);
            }
        }

        if (node.urlName && (node.icon || node.screenshots || node.platforms || node.appTypes || node.licenseCost)) {
            apps.push(node);
        }

        for (const val of Object.values(node)) walk(val);
    };

    walk(root);
    return apps;
};

const mapNextFlightAppToItem = (app) => {
    const url = app?.urlName ? `https://alternativeto.net/software/${app.urlName}/` : null;
    if (!url) return null;

    const appTypes = uniq((app.appTypes || []).map((t) => t?.name || t?.appType));
    const platforms = uniq((app.platforms || []).map((p) => p?.name));
    const images = uniq((app.screenshots || []).map((s) => s?.url309x197 || s?.url618x394 || s?.url1200x1200));
    const country = countryFromCode(app.company?.countryCode);
    const bestAlternative = app.topAlternatives?.[0]?.name || null;

    return cleanItem({
        title: app.name,
        description: app.shortDescriptionOrTagLine,
        url,
        rating: app.rating?.rating,
        likes: app.likes,
        pricing: app.licenseCost,
        cost: uniq([app.licenseCost, app.licenseModel]).join(' | '),
        license: app.licenseModel,
        platforms,
        applicationTypes: appTypes,
        images,
        origins: uniq([country]),
        bestAlternative,
        developer: app.company?.name,
        logoUrl: app.icon?.url140 || app.icon?.url70 || app.icon?.url280 || app.icon?.url40,
        _source: 'next-flight',
    });
};

const extractFromNextFlight = ($) => {
    const entries = collectNextFlightEntries($);
    if (!entries.length) return [];

    const records = parseNextFlightRecordMap(entries);
    if (!records.size) return [];

    const uniqueByUrl = new Map();
    for (const recordValue of records.values()) {
        const apps = collectAppsFromUnknownTree(recordValue);
        for (const app of apps) {
            const item = mapNextFlightAppToItem(app);
            if (!item?.url) continue;
            uniqueByUrl.set(item.url, mergeItem(uniqueByUrl.get(item.url), item));
        }
    }

    return [...uniqueByUrl.values()];
};

const fromObjectTree = (root, pageUrl, source) => {
    const out = new Map();
    if (!root || typeof root !== 'object') return [];
    const stack = [root];
    const seen = new WeakSet();

    while (stack.length) {
        const node = stack.pop();
        if (!node || typeof node !== 'object') continue;
        if (seen.has(node)) continue;
        seen.add(node);

        if (Array.isArray(node)) {
            for (const c of node) if (c && typeof c === 'object') stack.push(c);
            continue;
        }

        const urlNameUrl = node.urlName ? `https://alternativeto.net/software/${node.urlName}/` : null;
        const url = toolUrl(node.url ?? node.href ?? node.link ?? node.canonicalUrl ?? urlNameUrl, pageUrl);
        if (url) {
            const appTypes = uniq((node.appTypes || []).map((entry) => entry?.name || entry?.appType));
            const screenshots = uniq((node.screenshots || []).map((shot) => shot?.url309x197 || shot?.url618x394 || shot?.url1200x1200));
            const companyCountry = countryFromCode(node.company?.countryCode);
            const item = cleanItem({
                title: node.name ?? node.title ?? node.alternateName,
                description: node.description ?? node.summary ?? node.abstract ?? node.tagline,
                url,
                rating: node.aggregateRating?.ratingValue ?? node.ratingValue ?? node.rating ?? node.score,
                likes: node.likes ?? node.votes ?? node.voteCount ?? node.upvotes,
                pricing: node.licenseCost ?? node.pricing ?? node.cost,
                cost: uniq([node.licenseCost, node.licenseModel, node.cost, node.pricing]).join(' | '),
                license: node.licenseModel ?? node.license ?? node.priceModel,
                platforms: (node.platforms || []).length ? (node.platforms || []).map((p) => p?.name || p) : (node.operatingSystem ?? node.supportedPlatforms),
                applicationTypes: appTypes.length ? appTypes : (node.applicationCategory ?? node.categories ?? node.tags),
                images: screenshots,
                origins: uniq([node.origin, node.country, node.madeIn, companyCountry]),
                bestAlternative: node.topAlternatives?.[0]?.name,
                developer: node.company?.name ?? node.author?.name ?? node.provider?.name ?? node.publisher?.name ?? node.developer?.name ?? node.organization?.name,
                logoUrl: node.icon?.url140 ?? node.icon?.url70 ?? node.icon?.url280 ?? node.icon?.url40 ?? node.image?.url ?? node.image ?? node.logo?.url ?? node.logo ?? node.thumbnailUrl,
                _source: source,
            });
            if (item) out.set(item.url, mergeItem(out.get(item.url), item));
        }

        for (const v of Object.values(node)) if (v && typeof v === 'object') stack.push(v);
    }

    return [...out.values()];
};

const labeledValue = ($, $root, re) => {
    const values = valuesFromHeading($, $root, re);
    if (values.length) return values[0];

    let found = null;
    $root.find('dt, th, strong, span, div, p').each((_, el) => {
        if (found) return;
        const t = txt($(el).text());
        if (!t || !re.test(t)) return;
        found = txt($(el).find('a').first().text())
            || txt($(el).next('dd, td, span, div, p').first().text())
            || txt(t.split(':').slice(1).join(':'));
    });
    return found || null;
};

const valuesFromHeading = ($, $root, headingRegex) => {
    const h = $root.find('h2, h3, h4, dt, strong').filter((_, el) => headingRegex.test(txt($(el).text()))).first();
    if (!h.length) return [];

    const parent = h.parent();
    let values = [];

    const listItems = parent.find('ul li, ol li');
    if (listItems.length) {
        values = listItems.toArray().map((el) => txt($(el).text()));
    } else {
        values = parent.find('a, span, p, div').toArray().map((el) => txt($(el).text()));
    }

    const headingText = txt(h.text());
    return uniq(values.filter((v) => !isNoiseFieldValue(v) && txt(v) !== headingText));
};

const tagsFromHeader = ($, $root, re) => {
    const values = valuesFromHeading($, $root, re);
    return values.length ? values : null;
};

const parseCostLicense = (values) => {
    const cleanValues = uniq(values);
    if (!cleanValues.length) return { pricing: null, cost: null, license: null };

    const pricing = cleanValues.find((v) => hasPricingToken(v)) || null;
    const license = cleanValues.find((v) => hasLicenseToken(v)) || null;
    const cost = cleanValues.length ? cleanValues.join(' | ') : null;

    return { pricing, cost, license };
};

const extractCards = ($, pageUrl) => {
    const out = new Map();
    const cards = $('article.app-item-container, li[data-testid^="item-"], div[data-testid="app-listing-item"]');

    cards.each((_, el) => {
        const $card = $(el);
        const $a = $card.find('h2 a[href*="/software/"], h3 a[href*="/software/"], a.no-link-color[href*="/software/"]').first();
        const url = toolUrl($a.attr('href'), pageUrl);
        if (!url) return;

        const cardText = txt($card.text());
        const costValues = valuesFromHeading($, $card, /cost\s*\/\s*license|pricing|license/i);
        const { pricing, cost, license } = parseCostLicense(costValues);
        const likes = intVal((cardText.match(/(\d[\d,]*)\s*likes?/i) || [])[1]);

        const item = cleanItem({
            title: txt($a.text()) || txt($card.find('h2, h3').first().text()),
            description: txt($card.find('[id*="description"] p, p[class*="description"], p').first().text()),
            url,
            logoUrl: absUrl($card.find('img').first().attr('src'), pageUrl),
            likes,
            rating: floatVal($card.find('[aria-label*="rating" i], [class*="rating"], [class*="score"]').first().text()),
            pricing,
            cost,
            license,
            platforms: tagsFromHeader($, $card, /platforms?/i),
            applicationTypes: tagsFromHeader($, $card, /(application\s*types?|application\s*type|categories?)/i),
            origins: tagsFromHeader($, $card, /(origin|made in|country)/i),
            bestAlternative: labeledValue($, $card, /best\s*alternative/i),
            _source: 'html',
        });
        if (item) out.set(item.url, mergeItem(out.get(item.url), item));
    });

    return [...out.values()];
};

const extractFromCapturedApiPayloads = (payloads, pageUrl) => {
    if (!Array.isArray(payloads) || !payloads.length) return [];
    const byUrl = new Map();
    for (const payload of payloads) {
        const items = fromObjectTree(payload, pageUrl, 'internal-api');
        for (const item of items) {
            if (!item?.url) continue;
            byUrl.set(item.url, mergeItem(byUrl.get(item.url), item));
        }
    }
    return [...byUrl.values()];
};

const extractFromPage = ({ $, pageUrl, includeCards, apiPayloads = [] }) => {
    const out = new Map();
    const mergeMany = (items) => {
        for (const item of items) if (item?.url) out.set(item.url, mergeItem(out.get(item.url), item));
    };

    mergeMany(extractFromNextFlight($));
    mergeMany(extractFromCapturedApiPayloads(apiPayloads, pageUrl));

    const nextData = parseJson($('script#__NEXT_DATA__').first().text());
    if (nextData) mergeMany(fromObjectTree(nextData, pageUrl, '__NEXT_DATA__'));

    $('script[type="application/ld+json"]').each((_, el) => {
        const json = parseJson($(el).text());
        if (json) mergeMany(fromObjectTree(json, pageUrl, 'json-ld'));
    });

    if (includeCards) mergeMany(extractCards($, pageUrl));
    return [...out.values()];
};

const mergeItemSets = (...itemSets) => {
    const out = new Map();
    for (const set of itemSets) {
        if (!Array.isArray(set)) continue;
        for (const item of set) {
            if (!item?.url) continue;
            out.set(item.url, mergeItem(out.get(item.url), item));
        }
    }
    return [...out.values()];
};

const isSparseItem = (item) => {
    if (!item?.url) return true;
    const noDescription = !txt(item.description);
    const noCategory = !txt(item.category);
    const noDeveloper = !txt(item.developer);
    const noLogo = !txt(item.logoUrl);
    const noPricing = !txt(item.pricing);
    const noPlatforms = !Array.isArray(item.platforms) || item.platforms.length === 0;
    const noAppTypes = !Array.isArray(item.applicationTypes) || item.applicationTypes.length === 0;
    return noDescription && noCategory && noDeveloper && noLogo && noPricing && noPlatforms && noAppTypes;
};

const needsEnrichmentRetry = (items) => {
    if (!Array.isArray(items) || !items.length) return true;
    const sparseCount = items.filter(isSparseItem).length;
    return sparseCount >= Math.ceil(items.length * 0.2);
};

const blocked = ($, html) => {
    const title = txt($('title').first().text());
    if (BLOCKED_TITLES.some((re) => re.test(title))) return true;
    const lower = String(html || '').toLowerCase();
    return lower.includes('cf-chl')
        || lower.includes('cf-challenge')
        || lower.includes('datadome')
        || lower.includes('perimeterx');
};

const getStablePageContent = async (page, currentUrl) => {
    let html = await page.content();
    let $ = cheerioLoad(html);
    if (!blocked($, html)) return { html, $ };

    await page.waitForLoadState('networkidle', { timeout: 6000 }).catch(() => {});
    await page.waitForTimeout(2500);
    html = await page.content();
    $ = cheerioLoad(html);

    if (blocked($, html)) {
        blockedPages.add(currentUrl);
        throw new Error('Blocked page detected after retry window.');
    }

    return { html, $ };
};

const searchUrl = (keyword) => {
    const u = new URL('browse/search/', BASE_URL);
    u.searchParams.set('q', keyword);
    return u.href;
};

const normalizeInput = (raw = {}) => {
    const keyword = txt(raw.keyword);
    const resultsWanted = numInput(raw.results_wanted, 100, 'results_wanted', 5000);
    const maxPages = numInput(raw.max_pages, 20, 'max_pages', 500);

    const list = [];
    const add = (s) => {
        if (!s) return;
        if (typeof s === 'string' && txt(s)) list.push(txt(s));
        if (typeof s === 'object' && txt(s.url)) list.push(txt(s.url));
    };

    const startList = Array.isArray(raw.startUrls) ? raw.startUrls : [];
    if (startList.length > 0) {
        startList.forEach(add);
    } else if (keyword) {
        list.push(searchUrl(keyword));
    } else {
        list.push(DEFAULT_START);
    }

    const startUrls = [...new Set(list.map((u) => normalizeStartUrl(u)).filter(Boolean))];
    if (!startUrls.length) throw new Error('No valid start URLs resolved from input.');

    return {
        keyword,
        startUrls,
        resultsWanted,
        maxPages,
        maxConcurrency: FAST_SCRAPE_CONFIG.maxConcurrency,
        proxyConfiguration: raw.proxyConfiguration,
    };
};

const input = normalizeInput((await Actor.getInput()) || {});
const selectedProxyInput = input.proxyConfiguration || { useApifyProxy: false };
const proxyConfiguration = await Actor.createProxyConfiguration(selectedProxyInput);
const proxyEnabled = Boolean(
    selectedProxyInput.useApifyProxy
    || (Array.isArray(selectedProxyInput.proxyUrls) && selectedProxyInput.proxyUrls.length > 0),
);

log.info('Starting AlternativeTo Playwright actor', {
    startUrls: input.startUrls.length,
    resultsWanted: input.resultsWanted,
    maxPages: input.maxPages,
    proxyEnabled,
    fastListingMode: FAST_SCRAPE_CONFIG.fastListingMode,
    requestDelaySecs: FAST_SCRAPE_CONFIG.requestDelaySecs,
    maxConcurrency: input.maxConcurrency,
});

let pushed = 0;
const discovered = new Set();
const pushedUrls = new Set();
const seenPages = new Set();
const routedPages = new WeakSet();
const pageApiPayloads = new WeakMap();
const blockedPages = new Set();
const blockedFallbackQueued = new Set();
let hasQueuedBlockedFallback = false;

const push = async (item) => {
    const clean = cleanItem(item);
    if (!clean?.url || pushedUrls.has(clean.url) || pushed >= input.resultsWanted) return false;
    pushedUrls.add(clean.url);
    await Actor.pushData(clean);
    pushed += 1;
    return true;
};

const maxRequestsPerCrawl = Math.min((input.startUrls.length * input.maxPages) + input.resultsWanted + 50, 20000);

const nextPage = ($, currentUrl, pageKind, extractedCount) => {
    const direct = $('a[rel="next"], a[aria-label*="next" i]').first().attr('href');
    if (direct) return absUrl(direct, currentUrl);
    const byText = $('a').filter((_, el) => /^next$/i.test(txt($(el).text()))).first().attr('href');
    if (byText) return absUrl(byText, currentUrl);

    const allowFallback = pageKind === PAGE_KIND.SEARCH || pageKind === PAGE_KIND.CATEGORY || pageKind === PAGE_KIND.SOFTWARE;
    if (!allowFallback || extractedCount <= 0) return null;

    try {
        const u = new URL(currentUrl);
        const currP = Number.parseInt(u.searchParams.get('p') || '1', 10);
        if (!Number.isFinite(currP)) return null;
        const p = currP + 1;
        if (p <= currP) return null;
        if (!Number.isFinite(p)) return null;
        u.searchParams.set('p', String(p));
        const next = u.href;
        return next === currentUrl ? null : next;
    } catch {
        return null;
    }
};

const router = createPlaywrightRouter();

router.addDefaultHandler(async ({ page, request }) => {
    const currentUrl = request.loadedUrl || request.url;
    const pageKind = classifyPageKind(currentUrl);
    const pageNo = Number(request.userData.pageNo) || 1;
    seenPages.add(currentUrl);

    await page.waitForLoadState('domcontentloaded', { timeout: 10000 });
    await page.waitForSelector('body', { timeout: 10000 });
    let { html, $ } = await getStablePageContent(page, currentUrl);

    const apiPayloads = pageApiPayloads.get(page) || [];
    let extracted = extractFromPage({ $, pageUrl: currentUrl, includeCards: true, apiPayloads });
    if (needsEnrichmentRetry(extracted)) {
        await page.waitForLoadState('networkidle', { timeout: 4500 }).catch(() => {});
        await page.waitForTimeout(900);
        ({ html, $ } = await getStablePageContent(page, currentUrl));
        const retryPayloads = pageApiPayloads.get(page) || [];
        const enriched = extractFromPage({ $, pageUrl: currentUrl, includeCards: true, apiPayloads: retryPayloads });
        extracted = mergeItemSets(extracted, enriched);
    }
    const fresh = extracted.filter((it) => it?.url && !discovered.has(it.url));
    log.info('List page parsed', {
        url: currentUrl,
        pageNo,
        extracted: extracted.length,
        fresh: fresh.length,
        pushed,
    });

    for (const item of fresh) {
        if (pushed >= input.resultsWanted) break;
        discovered.add(item.url);
        await push(item);
        if (discovered.size >= input.resultsWanted) break;
    }

    const done = pushed >= input.resultsWanted;
    if (done || pageNo >= input.maxPages) return;

    const n = nextPage($, currentUrl, pageKind, fresh.length);
    if (!n || seenPages.has(n)) return;
    log.info('Queueing next page', { from: currentUrl, next: n, nextPageNo: pageNo + 1 });
    await crawler.addRequests([{ url: n, uniqueKey: `list:${n}`, userData: { label: 'LIST', pageNo: pageNo + 1, seedStart: false } }]);
});

const crawler = new PlaywrightCrawler({
    requestHandler: router,
    proxyConfiguration,
    maxRequestsPerCrawl,
    launchContext: { launcher: firefox, launchOptions: { headless: true } },
    browserPoolOptions: { useFingerprints: false },
    useSessionPool: true,
    persistCookiesPerSession: true,
    sessionPoolOptions: {
        maxPoolSize: Math.max(input.maxConcurrency * 4, 20),
    },
    maxConcurrency: input.maxConcurrency,
    maxRequestRetries: 2,
    navigationTimeoutSecs: 30,
    requestHandlerTimeoutSecs: 60,
    sameDomainDelaySecs: FAST_SCRAPE_CONFIG.requestDelaySecs,
    preNavigationHooks: [
        async ({ page }, gotoOptions) => {
            if (!routedPages.has(page)) {
                await page.route('**/*', async (route) => {
                    const req = route.request();
                    const reqUrl = req.url().toLowerCase();
                    if (BLOCKED_TYPES.has(req.resourceType()) || TRACKERS.some((x) => reqUrl.includes(x))) {
                        await route.abort();
                        return;
                    }
                    await route.continue();
                });
                routedPages.add(page);
            }
            if (!pageApiPayloads.has(page)) {
                const payloads = [];
                pageApiPayloads.set(page, payloads);
                page.on('response', async (response) => {
                    try {
                        if (payloads.length >= 40) return;
                        if (response.status() >= 400) return;
                        const reqUrl = response.url();
                        const contentType = (response.headers()['content-type'] || '').toLowerCase();
                        const likelyJson = contentType.includes('application/json')
                            || reqUrl.includes('/api/')
                            || reqUrl.includes('/_next/data/')
                            || reqUrl.includes('graphql');
                        if (!likelyJson) return;
                        const bodyText = await response.text();
                        const json = parseJson(bodyText);
                        if (json && typeof json === 'object') payloads.push(json);
                    } catch {
                        // Ignore response parsing issues.
                    }
                });
            }
            await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
            gotoOptions.waitUntil = 'domcontentloaded';
        },
    ],
    failedRequestHandler: async ({ request }, error) => {
        const errorMsg = error?.message || 'Unknown error';
        const failedUrl = request.loadedUrl || request.url;
        const isBlockedStatus = /403|429|forbidden|blocked/i.test(errorMsg);
        
        if (isBlockedStatus) {
            blockedPages.add(failedUrl);
            log.warning(`Request blocked - skipping: ${failedUrl}`);
        }

        const isTopSeedListRequest = request.userData?.label === 'LIST'
            && Number(request.userData?.pageNo || 1) === 1
            && request.userData?.seedStart === true;
        if (isBlockedStatus && isTopSeedListRequest && pushed === 0 && proxyEnabled && !hasQueuedBlockedFallback && !blockedFallbackQueued.has(failedUrl)) {
            blockedFallbackQueued.add(failedUrl);
            hasQueuedBlockedFallback = true;
            const fallbacks = blockedStartFallbacks(failedUrl)
                .filter((url) => !seenPages.has(url))
                .map((url) => ({ url, uniqueKey: `list:${url}`, userData: { label: 'LIST', pageNo: 1, seedStart: false } }));
            if (fallbacks.length > 0) {
                await crawler.addRequests(fallbacks, { forefront: true });
                log.warning('Queued fallback start URLs after blocked first page', {
                    blockedUrl: failedUrl,
                    fallbackCount: fallbacks.length,
                });
            }
        }
        
        if (!isBlockedStatus) {
            log.error('Request failed', {
                url: failedUrl,
                retries: request.retryCount,
                error: errorMsg,
            });
        }
    },
});

await crawler.run(input.startUrls.map((url) => ({
    url,
    uniqueKey: `list:${url}`,
    userData: { label: 'LIST', pageNo: 1, seedStart: true },
})));

log.info('Run finished', {
    pushed,
    discovered: discovered.size,
    blockedPages: blockedPages.size,
});

if (pushed === 0 && blockedPages.size > 0 && !proxyEnabled) {
    log.error('All requests were blocked and no data was scraped. Enable Apify Proxy (prefer RESIDENTIAL) to avoid 403 blocks on AlternativeTo.');
}

await Actor.exit();
