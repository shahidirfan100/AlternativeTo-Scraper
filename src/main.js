import { Actor } from 'apify';
import log from '@apify/log';
import { PlaywrightCrawler, createPlaywrightRouter } from 'crawlee';
import { load as cheerioLoad } from 'cheerio';
import { firefox } from 'playwright';
import vm from 'node:vm';

await Actor.init();

// ─── Constants ───────────────────────────────────────────────────────────────
const BASE_URL = 'https://alternativeto.net/';
const DEFAULT_START = 'https://alternativeto.net/category/ai-tools/ai-image-generator/';
const TOOL_URL_RE = /^https:\/\/(?:www\.)?alternativeto\.net\/software\/[^/?#]+\/?$/i;
const ALT_DOMAIN_RE = /(?:^|\.)alternativeto\.net$/i;
const PAGE_KIND = Object.freeze({ SEARCH: 'search', CATEGORY: 'category', SOFTWARE: 'software', OTHER: 'other' });
const PRICING_RE = /(free|paid|freemium|subscription|trial|one[-\s]?time|lifetime)/i;
const LICENSE_TYPE_RE = /(open\s*source|opensource|proprietary|commercial|apache|mit|gpl|bsd|mozilla|agpl|lgpl|mpl|cc0)/i;
const BLOCKED_TITLES = [/access denied/i, /captcha/i, /forbidden/i, /verify/i];
const BLOCKED_RESOURCE_TYPES = new Set(['image', 'font', 'media', 'stylesheet']);
const TRACKER_PATTERNS = ['google-analytics', 'googletagmanager', 'doubleclick', 'facebook.net', 'ads', 'pinterest', 'hotjar', 'segment'];

// Stealth user agents — recent real Firefox ESR on common OSes
const USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 14.7; rv:133.0) Gecko/20100101 Firefox/133.0',
    'Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 14.6; rv:132.0) Gecko/20100101 Firefox/132.0',
];
const VIEWPORTS = [
    { width: 1920, height: 1080 },
    { width: 1366, height: 768 },
    { width: 1536, height: 864 },
    { width: 1440, height: 900 },
];
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const randDelay = (min, max) => new Promise((r) => setTimeout(r, min + Math.random() * (max - min)));

const REGION_DISPLAY = new Intl.DisplayNames(['en'], { type: 'region' });

// ─── Utility helpers ─────────────────────────────────────────────────────────
const txt = (v) => (v ? String(v).replace(/\s+/g, ' ').trim() : '');
const uniq = (value) => {
    if (value == null) return [];
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
    if (!href || typeof href === 'object') return null;
    const clean = txt(href);
    if (!clean) return null;
    try { return new URL(clean, base).href; } catch { return null; }
};

const toolUrl = (href, base = BASE_URL) => {
    const url = absUrl(href, base);
    if (!url) return null;
    const clean = url.split('#')[0].replace(/\/about\/?$/i, '/').replace(/\/reviews\/?$/i, '/');
    return TOOL_URL_RE.test(clean) ? clean : null;
};

const intVal = (v) => { const m = txt(v).match(/(\d[\d,]*)/); if (!m) return null; const n = parseInt(m[1].replaceAll(',', ''), 10); return Number.isFinite(n) ? n : null; };
const floatVal = (v) => { const m = txt(v).match(/(\d+(?:\.\d+)?)/); if (!m) return null; const n = parseFloat(m[1]); return Number.isFinite(n) ? n : null; };
const hasPricingToken = (v) => PRICING_RE.test(txt(v));
const hasLicenseToken = (v) => LICENSE_TYPE_RE.test(txt(v));
const parseJson = (s) => { try { return JSON.parse(s); } catch { return null; } };

const countryFromCode = (code) => {
    const clean = txt(code).toUpperCase();
    if (!/^[A-Z]{2}$/.test(clean)) return null;
    try { return REGION_DISPLAY.of(clean) || clean; } catch { return clean; }
};

const isNoiseFieldValue = (v) => {
    const c = txt(v).toLowerCase();
    return !c || c === 'application type' || c === 'cost / license' || c === 'origin' || c === 'platforms';
};

// ─── URL helpers ─────────────────────────────────────────────────────────────
const classifyPageKind = (urlValue) => {
    try {
        const path = new URL(urlValue).pathname.toLowerCase();
        if (path.startsWith('/browse/search/')) return PAGE_KIND.SEARCH;
        if (path.startsWith('/category/')) return PAGE_KIND.CATEGORY;
        if (/^\/software\/[^/]+\/?$/.test(path)) return PAGE_KIND.SOFTWARE;
        return PAGE_KIND.OTHER;
    } catch { return PAGE_KIND.OTHER; }
};

const normalizeStartUrl = (candidate) => {
    const absolute = absUrl(candidate);
    if (!absolute) return null;
    try {
        const u = new URL(absolute);
        if (!ALT_DOMAIN_RE.test(u.hostname)) return null;
        u.hash = ''; u.protocol = 'https:'; u.hostname = 'alternativeto.net';
        const path = u.pathname.replace(/\/+/g, '/').replace(/\/$/, '') || '/';
        if (path === '/software' && txt(u.searchParams.get('q'))) u.pathname = '/browse/search/';
        else if (/^\/software\/[^/]+\/(?:about|reviews|alternatives)$/i.test(path)) u.pathname = `${path.split('/').slice(0, 3).join('/')}/`;
        else if (/^\/software\/[^/]+$/i.test(path)) u.pathname = `${path}/`;
        else if (/^\/category\/.+/i.test(path) && !path.endsWith('/')) u.pathname = `${path}/`;
        else if (/^\/browse\/search$/i.test(path)) u.pathname = '/browse/search/';
        return u.href;
    } catch { return absolute; }
};

const blockedStartFallbacks = (blockedUrl) => {
    const candidates = [];
    const add = (url) => { const n = normalizeStartUrl(url); if (n) candidates.push(n); };
    try {
        const u = new URL(blockedUrl);
        const path = u.pathname.toLowerCase();
        const alt = new URL(u.href);
        alt.hostname = u.hostname === 'www.alternativeto.net' ? 'alternativeto.net' : 'www.alternativeto.net';
        add(alt.href);
        if (path.startsWith('/category/')) {
            const segments = path.split('/').filter(Boolean);
            if (segments.length >= 2) add(`https://alternativeto.net/${segments[0]}/${segments[1]}/`);
        } else if (path.startsWith('/browse/search/')) {
            const q = txt(u.searchParams.get('q'));
            if (q) add(`https://alternativeto.net/browse/search/?q=${encodeURIComponent(q)}&p=2`);
            add(DEFAULT_START);
        }
    } catch { /* malformed URL */ }
    return [...new Set(candidates.filter((c) => c !== blockedUrl))];
};

const searchUrl = (keyword) => {
    const u = new URL('browse/search/', BASE_URL);
    u.searchParams.set('q', keyword);
    return u.href;
};

// ─── Data cleaning ───────────────────────────────────────────────────────────
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

    const catVals = new Set([txt(category).toLowerCase(), ...applicationTypes.map((v) => txt(v).toLowerCase())].filter(Boolean));
    if (catVals.has(pricing.toLowerCase())) pricing = '';
    if (catVals.has(cost.toLowerCase())) cost = '';
    if (catVals.has(license.toLowerCase())) license = '';

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
        platforms: uniq(raw.platforms || []).length > 0 ? uniq(raw.platforms || []) : null,
        applicationTypes: applicationTypes.length ? applicationTypes : null,
        images: images.length ? images : null,
        origins: uniq(raw.origins || []).length > 0 ? uniq(raw.origins || []) : null,
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
    const p = (c, i) => (txt(c) ? c : (txt(i) ? i : null));
    const mergeArr = (a1, a2) => { const m = uniq([...(a1 || []), ...(a2 || [])]); return m.length > 0 ? m : null; };
    return {
        ...a,
        title: p(a.title, b.title),
        description: txt(b.description).length > txt(a.description).length ? b.description : a.description,
        category: p(a.category, b.category),
        pricing: p(a.pricing, b.pricing),
        cost: p(a.cost, b.cost),
        license: p(a.license, b.license),
        bestAlternative: p(a.bestAlternative, b.bestAlternative),
        developer: p(a.developer, b.developer),
        logoUrl: p(a.logoUrl, b.logoUrl),
        rating: Number.isFinite(a.rating) ? a.rating : (Number.isFinite(b.rating) ? b.rating : null),
        likes: Number.isFinite(a.likes) ? a.likes : (Number.isFinite(b.likes) ? b.likes : null),
        platforms: mergeArr(a.platforms, b.platforms),
        applicationTypes: mergeArr(a.applicationTypes, b.applicationTypes),
        images: mergeArr(a.images, b.images),
        origins: mergeArr(a.origins, b.origins),
    };
};

const listingSignalScore = (item) => {
    const signals = [
        txt(item?.description).length >= 20,
        Number.isFinite(item?.rating),
        Number.isFinite(item?.likes),
        Boolean(txt(item?.pricing) || txt(item?.cost) || txt(item?.license)),
        Boolean(txt(item?.logoUrl)),
        Array.isArray(item?.platforms) && item.platforms.length > 0,
        Array.isArray(item?.applicationTypes) && item.applicationTypes.length > 0,
        Array.isArray(item?.origins) && item.origins.length > 0,
        Array.isArray(item?.images) && item.images.length > 0,
        Boolean(txt(item?.category)),
        Boolean(txt(item?.developer)),
    ];
    return signals.filter(Boolean).length;
};

const isSparseListingItem = (item) => listingSignalScore(item) < 3;

// ─── Next.js Flight data extraction ─────────────────────────────────────────
const collectNextFlightEntries = ($) => {
    const scripts = $('script').toArray().map((el) => $(el).text()).filter((t) => t && t.includes('self.__next_f.push('));
    const collected = [];
    for (const script of scripts) {
        try {
            vm.runInNewContext(script, { self: { __next_f: { push: (e) => collected.push(e) } } }, { timeout: 200 });
        } catch { /* malformed chunk */ }
    }
    return collected;
};

const parseNextFlightRecordMap = (entries) => {
    const records = new Map();
    for (const entry of entries) {
        if (!Array.isArray(entry) || typeof entry[1] !== 'string') continue;
        for (const line of entry[1].split('\n')) {
            const m = line.match(/^([A-Za-z0-9]+):(.*)$/);
            if (!m) continue;
            const parsed = parseJson(m[2]);
            if (parsed !== null) records.set(m[1], parsed);
        }
    }
    return records;
};

const collectAppsFromTree = (root) => {
    const apps = [];
    const seen = new WeakSet();
    const walk = (node) => {
        if (!node || typeof node !== 'object' || seen.has(node)) return;
        seen.add(node);
        if (Array.isArray(node)) { for (const c of node) walk(c); return; }
        if (Array.isArray(node.items)) for (const it of node.items) if (it && typeof it === 'object') apps.push(it);
        if (node.urlName && (node.icon || node.screenshots || node.platforms || node.appTypes || node.licenseCost)) apps.push(node);
        for (const v of Object.values(node)) walk(v);
    };
    walk(root);
    return apps;
};

const mapFlightAppToItem = (app) => {
    const url = app?.urlName ? `https://alternativeto.net/software/${app.urlName}/` : null;
    if (!url) return null;

    const appTypes = uniq((app.appTypes || []).map((t) => t?.name || t?.appType || t));
    const platforms = uniq((app.platforms || []).map((p) => p?.name || p?.platform || p));
    const images = uniq((app.screenshots || []).map((s) => s?.url309x197 || s?.url618x394 || s?.url1200x1200 || s?.url || s));
    const country = countryFromCode(app.company?.countryCode || app.countryCode);

    return cleanItem({
        title: app.name ?? app.title ?? app.displayName,
        description: app.shortDescriptionOrTagLine ?? app.shortDescription ?? app.description ?? app.tagline ?? app.summary,
        url,
        rating: app.rating?.rating ?? app.rating?.value ?? app.ratingValue ?? (typeof app.rating === 'number' ? app.rating : null) ?? app.score,
        likes: app.likes ?? app.likeCount ?? app.votes ?? app.voteCount ?? app.upvotes,
        pricing: app.licenseCost ?? app.cost ?? app.pricing ?? app.price,
        cost: uniq([app.licenseCost, app.licenseModel]).join(' | '),
        license: app.licenseModel ?? app.license ?? app.licenseType,
        platforms: platforms.length ? platforms : null,
        applicationTypes: appTypes.length ? appTypes : null,
        images: images.length ? images : null,
        origins: country ? [country] : null,
        bestAlternative: app.topAlternatives?.[0]?.name ?? app.topAlternative?.name,
        developer: app.company?.name ?? app.companyName ?? app.developer ?? app.creator ?? app.author?.name,
        logoUrl: app.icon?.url140 ?? app.icon?.url70 ?? app.icon?.url280 ?? app.icon?.url40 ?? app.iconUrl ?? (typeof app.icon === 'string' ? app.icon : null) ?? app.logo,
        _source: 'next-flight',
    });
};

const extractFromNextFlight = ($) => {
    const entries = collectNextFlightEntries($);
    if (!entries.length) return [];
    const records = parseNextFlightRecordMap(entries);
    if (!records.size) return [];
    const byUrl = new Map();
    for (const val of records.values()) {
        for (const app of collectAppsFromTree(val)) {
            const item = mapFlightAppToItem(app);
            if (item?.url) byUrl.set(item.url, mergeItem(byUrl.get(item.url), item));
        }
    }
    return [...byUrl.values()];
};

// ─── Generic object-tree extraction (JSON-LD, __NEXT_DATA__, API payloads) ──
const fromObjectTree = (root, pageUrl, source) => {
    const out = new Map();
    if (!root || typeof root !== 'object') return [];
    const stack = [root];
    const seen = new WeakSet();
    while (stack.length) {
        const node = stack.pop();
        if (!node || typeof node !== 'object' || seen.has(node)) continue;
        seen.add(node);
        if (Array.isArray(node)) { for (const c of node) if (c && typeof c === 'object') stack.push(c); continue; }

        const urlNameUrl = node.urlName ? `https://alternativeto.net/software/${node.urlName}/` : null;
        const url = toolUrl(node.url ?? node.href ?? node.link ?? node.canonicalUrl ?? urlNameUrl, pageUrl);
        if (url) {
            const appTypes = uniq((node.appTypes || []).map((e) => e?.name || e?.appType || e));
            const shots = uniq((node.screenshots || []).map((s) => s?.url309x197 || s?.url618x394 || s?.url1200x1200 || s));
            const plats = (node.platforms || []).length ? (node.platforms || []).map((p) => p?.name || p) : (node.operatingSystem ?? node.supportedPlatforms);
            const country = countryFromCode(node.company?.countryCode || node.countryCode);
            const item = cleanItem({
                title: node.name ?? node.title ?? node.alternateName ?? node.displayName,
                description: node.description ?? node.summary ?? node.abstract ?? node.tagline ?? node.shortDescription ?? node.shortDescriptionOrTagLine,
                url,
                rating: node.aggregateRating?.ratingValue ?? node.ratingValue ?? node.rating?.rating ?? (typeof node.rating === 'number' ? node.rating : null) ?? node.score,
                likes: node.likes ?? node.votes ?? node.voteCount ?? node.upvotes ?? node.likeCount,
                pricing: node.licenseCost ?? node.pricing ?? node.cost ?? node.price,
                cost: uniq([node.licenseCost, node.licenseModel, node.cost, node.pricing, node.price]).join(' | '),
                license: node.licenseModel ?? node.license ?? node.priceModel ?? node.licenseType,
                platforms: plats,
                applicationTypes: appTypes.length ? appTypes : uniq([node.applicationCategory, node.category, ...(node.categories || []), ...(node.tags || [])]),
                images: shots,
                origins: uniq([node.origin, node.country, node.madeIn, country, node.location]),
                bestAlternative: node.topAlternatives?.[0]?.name ?? node.topAlternative?.name,
                developer: node.company?.name ?? node.companyName ?? node.author?.name ?? node.provider?.name ?? node.publisher?.name ?? node.developer?.name ?? node.organization?.name ?? node.creator?.name,
                logoUrl: node.icon?.url140 ?? node.icon?.url70 ?? node.icon?.url280 ?? node.icon?.url40 ?? node.iconUrl ?? node.image?.url ?? (typeof node.image === 'string' ? node.image : null) ?? node.logo?.url ?? (typeof node.logo === 'string' ? node.logo : null) ?? node.thumbnailUrl ?? node.thumbnail,
                _source: source,
            });
            if (item) out.set(item.url, mergeItem(out.get(item.url), item));
        }
        for (const v of Object.values(node)) if (v && typeof v === 'object') stack.push(v);
    }
    return [...out.values()];
};

// ─── HTML card extraction helpers ────────────────────────────────────────────
const valuesFromHeading = ($, $root, re) => {
    const h = $root.find('h2, h3, h4, dt, strong').filter((_, el) => re.test(txt($(el).text()))).first();
    if (!h.length) return [];
    const parent = h.parent();
    const listItems = parent.find('ul li, ol li');
    const values = listItems.length
        ? listItems.toArray().map((el) => txt($(el).text()))
        : parent.find('a, span, p, div').toArray().map((el) => txt($(el).text()));
    const headingText = txt(h.text());
    return uniq(values.filter((v) => !isNoiseFieldValue(v) && txt(v) !== headingText));
};

const tagsFromHeader = ($, $root, re) => { const v = valuesFromHeading($, $root, re); return v.length ? v : null; };

const labeledValue = ($, $root, re) => {
    const vals = valuesFromHeading($, $root, re);
    if (vals.length) return vals[0];
    let found = null;
    $root.find('dt, th, strong, span, div, p').each((_, el) => {
        if (found) return;
        const t = txt($(el).text());
        if (!t || !re.test(t)) return;
        found = txt($(el).find('a').first().text()) || txt($(el).next('dd, td, span, div, p').first().text()) || txt(t.split(':').slice(1).join(':'));
    });
    return found || null;
};

const parseCostLicense = (values) => {
    const clean = uniq(values);
    if (!clean.length) return { pricing: null, cost: null, license: null };
    return {
        pricing: clean.find((v) => hasPricingToken(v)) || null,
        cost: clean.join(' | '),
        license: clean.find((v) => hasLicenseToken(v)) || null,
    };
};

const extractCards = ($, pageUrl) => {
    const out = new Map();
    $('article.app-item-container, li[data-testid^="item-"], div[data-testid="app-listing-item"], article[class*="app"], li[class*="item"]').each((_, el) => {
        const $card = $(el);
        const $a = $card.find('h2 a[href*="/software/"], h3 a[href*="/software/"], a.no-link-color[href*="/software/"], a[href*="/software/"]').first();
        const url = toolUrl($a.attr('href'), pageUrl);
        if (!url) return;

        const cardText = txt($card.text());
        const costValues = valuesFromHeading($, $card, /cost\s*\/\s*license|pricing|license|price/i);
        const { pricing, cost, license } = parseCostLicense(costValues);
        const likes = intVal((cardText.match(/(\d[\d,]*)\s*likes?/i) || [])[1]) || intVal($card.find('[class*="like"], [data-testid*="like"]').text());
        const ratingText = $card.find('[aria-label*="rating" i], [class*="rating"], [class*="score"], [data-testid*="rating"]').first().text();
        const rating = floatVal(ratingText) || floatVal(cardText.match(/rating[:\s]*(\d+\.?\d*)/i)?.[1]);
        const description = txt($card.find('[id*="description"] p, p[class*="description"], [class*="description"], p[class*="tagline"], [class*="summary"]').first().text())
            || txt($card.find('p').first().text())
            || txt($card.find('[class*="summary"], [class*="excerpt"], .app-description').first().text());
        const category = txt($card.find('[class*="category"], [data-testid*="category"]').first().text());
        const developer = txt($card.find('[class*="company"], [class*="developer"], [data-testid*="company"], [class*="author"]').first().text());
        let logoSrc = $card.find('img').first().attr('src') || $card.find('img').first().attr('data-src');
        if (logoSrc && typeof logoSrc === 'object') logoSrc = null;

        const item = cleanItem({
            title: txt($a.text()) || txt($card.find('h2, h3, h4, [class*="title"]').first().text()),
            description, url, logoUrl: logoSrc ? absUrl(logoSrc, pageUrl) : null,
            likes, rating, pricing, cost, license,
            category: category || null, developer: developer || null,
            platforms: tagsFromHeader($, $card, /platforms?|operating system/i),
            applicationTypes: tagsFromHeader($, $card, /(application\s*types?|categories?|tags?)/i),
            origins: tagsFromHeader($, $card, /(origin|made in|country|location)/i),
            bestAlternative: labeledValue($, $card, /best\s*alternative|top\s*alternative/i),
            _source: 'html',
        });
        if (item) out.set(item.url, mergeItem(out.get(item.url), item));
    });
    return [...out.values()];
};

const extractPrimaryListingUrls = ($, pageUrl) => {
    const urls = new Set();
    const addUrl = (href) => {
        const normalized = toolUrl(href, pageUrl);
        if (normalized) urls.add(normalized);
    };
    const cardSelector = 'article.app-item-container, li[data-testid^="item-"], div[data-testid="app-listing-item"], div.flex.flex-col.gap-3 > div, article[class*="app"], li[class*="item"]';
    $(cardSelector).each((_, el) => {
        const $card = $(el);
        const primary = $card
            .find('h2 a.no-link-color[href*="/software/"], h3 a.no-link-color[href*="/software/"], a.no-link-color[href*="/software/"]')
            .filter((__, a) => !/\balternatives?\b/i.test(txt($(a).text())))
            .first();
        if (primary.length) {
            addUrl(primary.attr('href'));
            return;
        }
        const fallback = $card
            .find('h2 a[href*="/software/"], h3 a[href*="/software/"], a[href*="/software/"]')
            .filter((__, a) => {
                const text = txt($(a).text());
                return text && !/\balternatives?\b/i.test(text) && !$(a).hasClass('text-meta');
            })
            .first();
        if (fallback.length) addUrl(fallback.attr('href'));
    });
    if (!urls.size) {
        $('a.no-link-color[href*="/software/"]').each((_, el) => addUrl($(el).attr('href')));
    }
    return urls;
};

// ─── Live DOM card extraction (reads from rendered page via Playwright) ──────
const extractCardsFromDOM = async (page, pageUrl, onlyUrls = null) => {
    try {
        const only = onlyUrls ? new Set([...onlyUrls].filter(Boolean)) : null;
        const rawCards = await page.evaluate(() => {
            const cards = [];
            const cardSelector = 'article.app-item-container, li[data-testid^="item-"], div[data-testid="app-listing-item"], div.flex.flex-col.gap-3 > div, article[class*="app"], li[class*="item"]';
            const cardNodes = document.querySelectorAll(cardSelector);
            const seen = new Set();

            for (const card of cardNodes) {
                const anchors = Array.from(card.querySelectorAll('h2 a[href*="/software/"], h3 a[href*="/software/"], a.no-link-color[href*="/software/"], a[href*="/software/"]'));
                const primary = anchors.find((a) => {
                    const text = (a.textContent || '').trim();
                    return text && !/\balternatives?\b/i.test(text) && !a.classList.contains('text-meta');
                }) || anchors.find((a) => a.classList.contains('no-link-color')) || anchors[0];
                if (!primary) continue;

                const href = primary.getAttribute('href');
                if (!href || !href.includes('/software/') || seen.has(href)) continue;
                seen.add(href);

                const heading = card.querySelector('h2, h3, h4');
                const title = (primary.textContent || '').trim() || (heading?.textContent || '').trim();
                if (!title || title.length < 2 || title.length > 200) continue;

                const texts = [];
                for (const el of card.querySelectorAll('p, [class*="description"], [class*="tagline"], [class*="summary"]')) {
                    const t = el.textContent?.trim();
                    if (t && t.length > 20 && t !== title) texts.push(t);
                }

                const tags = [];
                for (const el of card.querySelectorAll('[class*="tag"], [class*="badge"], [class*="category"], [class*="label"], [class*="chip"]')) {
                    const t = el.textContent?.trim();
                    if (t && t.length > 1 && t.length < 50) tags.push(t);
                }

                const costTexts = [];
                for (const el of card.querySelectorAll('[class*="price"], [class*="cost"], [class*="license"], [class*="free"], [class*="paid"]')) {
                    const t = el.textContent?.trim();
                    if (t && t.length > 1 && t.length < 50) costTexts.push(t);
                }

                const icon = card.querySelector('img[data-testid^="icon-"], img');
                const logoUrl = icon?.getAttribute('src') || icon?.getAttribute('data-src') || null;

                let likesText = null;
                for (const el of card.querySelectorAll('[class*="like"], [class*="vote"], [class*="upvote"], button')) {
                    const t = el.textContent?.trim();
                    if (t && /^\d+$/.test(t.replace(/,/g, ''))) { likesText = t; break; }
                }

                const ratingTexts = [];
                for (const el of card.querySelectorAll('[aria-label*="rating" i], [class*="rating"], [class*="score"], [data-testid*="rating"]')) {
                    const t = (el.getAttribute('aria-label') || el.textContent || '').trim();
                    if (t) ratingTexts.push(t);
                }

                cards.push({ href, title, description: texts[0] || null, tags, costTexts, likesText, ratingTexts, logoUrl });
            }
            return cards;
        });
        const out = new Map();
        for (const raw of rawCards) {
            const url = toolUrl(raw.href, pageUrl);
            if (!url) continue;
            if (only && !only.has(url)) continue;
            const pricingToken = raw.costTexts.find((v) => PRICING_RE.test(v));
            const licenseToken = raw.costTexts.find((v) => LICENSE_TYPE_RE.test(v));
            const category = raw.tags.find((t) => !PRICING_RE.test(t) && !LICENSE_TYPE_RE.test(t)) || null;
            const item = cleanItem({
                title: raw.title,
                description: raw.description,
                url,
                likes: raw.likesText ? intVal(raw.likesText) : null,
                rating: (raw.ratingTexts || []).map(floatVal).find((v) => Number.isFinite(v)) ?? null,
                pricing: pricingToken || null,
                cost: raw.costTexts.join(' | ') || null,
                license: licenseToken || null,
                logoUrl: raw.logoUrl || null,
                category,
                _source: 'dom',
            });
            if (item) out.set(item.url, mergeItem(out.get(item.url), item));
        }
        return [...out.values()];
    } catch { return []; }
};

// ─── Unified extraction from all page sources ───────────────────────────────
const extractFromPage = ($, pageUrl, apiPayloads = []) => {
    const out = new Map();
    const merge = (items) => { for (const it of items) if (it?.url) out.set(it.url, mergeItem(out.get(it.url), it)); };

    // 1. Intercepted API JSON payloads (highest quality)
    for (const payload of apiPayloads) merge(fromObjectTree(payload, pageUrl, 'internal-api'));

    // 2. Next.js Flight data (RSC payload in scripts — most items come from here)
    merge(extractFromNextFlight($));

    // 3. __NEXT_DATA__ script tag
    const nextData = parseJson($('script#__NEXT_DATA__').first().text());
    if (nextData) merge(fromObjectTree(nextData, pageUrl, '__NEXT_DATA__'));

    // 4. JSON-LD structured data
    $('script[type="application/ld+json"]').each((_, el) => {
        const json = parseJson($(el).text());
        if (json) merge(fromObjectTree(json, pageUrl, 'json-ld'));
    });

    // 5. HTML card parsing (fallback)
    merge(extractCards($, pageUrl));

    return [...out.values()];
};

const mergeItemSets = (...sets) => {
    const out = new Map();
    for (const s of sets) if (Array.isArray(s)) for (const it of s) if (it?.url) out.set(it.url, mergeItem(out.get(it.url), it));
    return [...out.values()];
};

// ─── Input normalization ─────────────────────────────────────────────────────
const numInput = (v, fallback, name, max = Number.MAX_SAFE_INTEGER) => {
    if (v == null || v === '') return fallback;
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`Input "${name}" must be a positive integer.`);
    return Math.min(Math.floor(n), max);
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
    if (startList.length > 0) startList.forEach(add);
    else if (keyword) list.push(searchUrl(keyword));
    else list.push(DEFAULT_START);
    const startUrls = [...new Set(list.map(normalizeStartUrl).filter(Boolean))];
    if (!startUrls.length) throw new Error('No valid start URLs resolved from input.');
    return { keyword, startUrls, resultsWanted, maxPages, proxyConfiguration: raw.proxyConfiguration };
};

const input = normalizeInput((await Actor.getInput()) || {});

// ─── Proxy: platform uses user selection / local = disabled ──────────────────
const isOnPlatform = Actor.isAtHome();
let proxyInput;
if (isOnPlatform) {
    proxyInput = input.proxyConfiguration || { useApifyProxy: true, apifyProxyGroups: ['RESIDENTIAL'] };
    log.info('Running on Apify platform', { proxy: proxyInput });
} else {
    proxyInput = { useApifyProxy: false };
    log.info('Running locally — proxy disabled');
}
const proxyConfiguration = await Actor.createProxyConfiguration(proxyInput);
const proxyEnabled = Boolean(proxyInput.useApifyProxy || (Array.isArray(proxyInput.proxyUrls) && proxyInput.proxyUrls.length));

log.info('Starting AlternativeTo scraper', {
    startUrls: input.startUrls.length,
    resultsWanted: input.resultsWanted,
    maxPages: input.maxPages,
    proxyEnabled,
});

// ─── Runtime state ───────────────────────────────────────────────────────────
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

// ─── Pagination helper ───────────────────────────────────────────────────────
const nextPage = ($, currentUrl, pageKind) => {
    const direct = $('a[rel="next"], a[aria-label*="next" i]').first().attr('href');
    if (direct) return absUrl(direct, currentUrl);
    const byText = $('a').filter((_, el) => /^next$/i.test(txt($(el).text()))).first().attr('href');
    if (byText) return absUrl(byText, currentUrl);
    const canFallback = pageKind === PAGE_KIND.SEARCH || pageKind === PAGE_KIND.CATEGORY || pageKind === PAGE_KIND.SOFTWARE;
    if (!canFallback) return null;
    try {
        const u = new URL(currentUrl);
        const curr = parseInt(u.searchParams.get('p') || '1', 10);
        if (!Number.isFinite(curr)) return null;
        u.searchParams.set('p', String(curr + 1));
        return u.href !== currentUrl ? u.href : null;
    } catch { return null; }
};

// ─── Block-detection helpers ─────────────────────────────────────────────────
const blocked = ($, html) => {
    const title = txt($('title').first().text());
    if (BLOCKED_TITLES.some((re) => re.test(title))) return true;
    const lower = String(html || '').toLowerCase();
    return lower.includes('cf-chl') || lower.includes('cf-challenge') || lower.includes('datadome') || lower.includes('perimeterx');
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
        throw new Error('Request blocked - received 403 status code.');
    }
    return { html, $ };
};

// ─── Scrolling to trigger lazy-loaded items ──────────────────────────────────
const scrollPage = async (page) => {
    try {
        await page.evaluate(async () => {
            const delay = (ms) => new Promise((r) => setTimeout(r, ms));
            const height = () => document.body.scrollHeight;
            let prev = 0;
            // Scroll incrementally to bottom — triggers RSC chunk loading
            for (let i = 0; i < 15; i++) {
                window.scrollBy(0, window.innerHeight * 0.6);
                await delay(300 + Math.random() * 400);
                const h = height();
                if (h === prev && i > 2) break;
                prev = h;
            }
            // Scroll back to top (natural behavior)
            window.scrollTo(0, 0);
        });
        // Wait for any RSC/API fetches triggered by scrolling
        await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
    } catch { /* scroll errors are non-fatal */ }
};

const hydrateTopCards = async (page) => {
    try {
        await page.evaluate(async () => {
            const delay = (ms) => new Promise((r) => setTimeout(r, ms));
            window.scrollTo(0, 0);
            await delay(250);
            for (let i = 0; i < 4; i++) {
                window.scrollBy(0, window.innerHeight * 0.35);
                await delay(350 + Math.random() * 250);
            }
            window.scrollTo(0, 0);
        });
        await page.waitForLoadState('networkidle', { timeout: 4000 }).catch(() => {});
        await page.waitForTimeout(300);
    } catch { /* non-fatal */ }
};

// ─── Router: single LIST handler — listing pages only, no detail pages ───────
const router = createPlaywrightRouter();

router.addDefaultHandler(async ({ page, request }) => {
    const currentUrl = request.loadedUrl || request.url;
    const pageKind = classifyPageKind(currentUrl);
    const pageNo = Number(request.userData.pageNo) || 1;
    seenPages.add(currentUrl);

    // Wait for DOM + initial RSC hydration
    await page.waitForLoadState('domcontentloaded', { timeout: 15000 });
    await page.waitForSelector('body', { timeout: 10000 });

    // Wait for the first batch of app cards to render
    await page.waitForSelector('a[href*="/software/"]', { timeout: 8000 }).catch(() => {});

    // Human-like interaction: move mouse
    try {
        await page.mouse.move(300 + Math.random() * 500, 200 + Math.random() * 300);
    } catch { /* non-fatal */ }

    // Thorough scroll to bottom — triggers RSC streaming of all items
    await scrollPage(page);

    // Grab page content and run extraction
    let { html, $ } = await getStablePageContent(page, currentUrl);
    const apiPayloads = pageApiPayloads.get(page) || [];
    let extracted = extractFromPage($, currentUrl, apiPayloads);
    let listingUrls = extractPrimaryListingUrls($, currentUrl);
    if (listingUrls.size) extracted = extracted.filter((it) => listingUrls.has(it.url));

    // If many items lack description, do a second pass after waiting for late RSC chunks
    let sparseCount = extracted.filter((it) => !it.description).length;
    if (sparseCount > 3 && sparseCount > extracted.length * 0.1) {
        // Scroll again slowly — some RSC chunks only load after full page interaction
        await page.evaluate(async () => {
            const delay = (ms) => new Promise((r) => setTimeout(r, ms));
            for (let i = 0; i < 5; i++) {
                window.scrollTo(0, document.body.scrollHeight * (i + 1) / 5);
                await delay(400 + Math.random() * 300);
            }
            window.scrollTo(0, 0);
        });
        await page.waitForLoadState('networkidle', { timeout: 6000 }).catch(() => {});
        await page.waitForTimeout(600);
        ({ html, $ } = await getStablePageContent(page, currentUrl));
        const retryPayloads = pageApiPayloads.get(page) || [];
        extracted = mergeItemSets(extracted, extractFromPage($, currentUrl, retryPayloads));
        listingUrls = extractPrimaryListingUrls($, currentUrl);
        if (listingUrls.size) extracted = extracted.filter((it) => listingUrls.has(it.url));
    }

    // Final fallback: DOM-based extraction for sparse/missing listing-card items
    let extractedUrls = new Set(extracted.map((it) => it.url).filter(Boolean));
    let missingListingUrls = listingUrls.size ? [...listingUrls].filter((url) => !extractedUrls.has(url)) : [];
    let sparseUrls = extracted.filter((it) => isSparseListingItem(it)).map((it) => it.url);
    sparseCount = sparseUrls.length;
    if (missingListingUrls.length || sparseUrls.length) {
        const domScope = new Set([...(listingUrls.size ? [...listingUrls] : []), ...missingListingUrls, ...sparseUrls]);
        const domCards = await extractCardsFromDOM(page, currentUrl, domScope.size ? domScope : null);
        extracted = mergeItemSets(extracted, domCards);
        if (listingUrls.size) extracted = extracted.filter((it) => listingUrls.has(it.url));
    }

    // One more top-area hydration pass for page 2+ where first cards can hydrate late
    extractedUrls = new Set(extracted.map((it) => it.url).filter(Boolean));
    missingListingUrls = listingUrls.size ? [...listingUrls].filter((url) => !extractedUrls.has(url)) : [];
    sparseUrls = extracted.filter((it) => isSparseListingItem(it)).map((it) => it.url);
    if (pageNo > 1 && (missingListingUrls.length || sparseUrls.length)) {
        await hydrateTopCards(page);
        ({ html, $ } = await getStablePageContent(page, currentUrl));
        listingUrls = extractPrimaryListingUrls($, currentUrl);
        const retryPayloads = pageApiPayloads.get(page) || [];
        const domRetryScope = new Set([...(listingUrls.size ? [...listingUrls] : []), ...missingListingUrls, ...sparseUrls]);
        const domRetry = await extractCardsFromDOM(page, currentUrl, domRetryScope.size ? domRetryScope : null);
        extracted = mergeItemSets(extracted, extractFromPage($, currentUrl, retryPayloads), domRetry);
        if (listingUrls.size) extracted = extracted.filter((it) => listingUrls.has(it.url));
    }

    // Sort by completeness: items WITH description first, then sparse items last
    const complete = [];
    const sparse = [];
    for (const it of extracted) {
        if (!it?.url || discovered.has(it.url)) continue;
        if (it.description || it.category || it.pricing) complete.push(it);
        else sparse.push(it);
    }
    const fresh = [...complete, ...sparse];

    log.info('Page parsed', {
        url: currentUrl, pageNo,
        expectedListings: listingUrls.size || null,
        total: extracted.length, complete: complete.length, sparse: sparse.length,
        fresh: fresh.length, pushed,
    });

    // Push all items — complete ones first for better data quality
    for (const item of fresh) {
        if (pushed >= input.resultsWanted) break;
        discovered.add(item.url);
        await push(item);
    }

    // Pagination
    if (pushed >= input.resultsWanted || pageNo >= input.maxPages) return;
    const n = nextPage($, currentUrl, pageKind);
    if (!n || seenPages.has(n)) return;

    // Small human-like delay before next page
    await randDelay(1500, 3000);

    log.info('Queueing next page', { next: n, nextPageNo: pageNo + 1 });
    await crawler.addRequests([{
        url: n,
        uniqueKey: `list:${n}`,
        userData: { label: 'LIST', pageNo: pageNo + 1, seedStart: false },
    }]);
});

// ─── Crawler configuration ───────────────────────────────────────────────────
const maxRequestsPerCrawl = Math.min((input.startUrls.length * input.maxPages) + 50, 20000);

const crawler = new PlaywrightCrawler({
    requestHandler: router,
    proxyConfiguration,
    maxRequestsPerCrawl,
    launchContext: {
        launcher: firefox,
        launchOptions: {
            headless: true,
            firefoxUserPrefs: {
                'dom.webdriver.enabled': false,
                'useAutomationExtension': false,
                'general.platform.override': '',
                'privacy.resistFingerprinting': false,
                'network.http.sendRefererHeader': 2,
            },
        },
        userAgent: pick(USER_AGENTS),
    },
    browserPoolOptions: {
        useFingerprints: false,
        preLaunchHooks: [
            async (_pageId, launchContext) => {
                if (!launchContext.launchOptions) launchContext.launchOptions = {};
                launchContext.launchOptions.viewport = pick(VIEWPORTS);
                launchContext.userAgent = pick(USER_AGENTS);
            },
        ],
    },
    useSessionPool: true,
    persistCookiesPerSession: true,
    sessionPoolOptions: {
        maxPoolSize: 10,
        sessionOptions: { maxUsageCount: 25, maxErrorScore: 3 },
    },
    maxConcurrency: 3,
    maxRequestRetries: 2,
    navigationTimeoutSecs: 20,
    requestHandlerTimeoutSecs: 40,
    sameDomainDelaySecs: 2,
    preNavigationHooks: [
        async ({ page, request }, gotoOptions) => {
            // Small random pre-navigation delay
            await randDelay(300, 800);

            // Block heavy resources and trackers
            if (!routedPages.has(page)) {
                await page.route('**/*', async (route) => {
                    const req = route.request();
                    const reqUrl = req.url().toLowerCase();
                    if (BLOCKED_RESOURCE_TYPES.has(req.resourceType()) || TRACKER_PATTERNS.some((t) => reqUrl.includes(t))) {
                        await route.abort();
                        return;
                    }
                    await route.continue();
                });
                routedPages.add(page);
            }

            // Capture API/JSON responses for data extraction
            if (!pageApiPayloads.has(page)) {
                const payloads = [];
                pageApiPayloads.set(page, payloads);
                page.on('response', async (response) => {
                    try {
                        if (payloads.length >= 50 || response.status() >= 400) return;
                        const ct = (response.headers()['content-type'] || '').toLowerCase();
                        const rUrl = response.url();
                        if (!(ct.includes('application/json') || rUrl.includes('/api/') || rUrl.includes('/_next/data/') || rUrl.includes('graphql'))) return;
                        const json = parseJson(await response.text());
                        if (json && typeof json === 'object') payloads.push(json);
                    } catch { /* ignore */ }
                });
            }

            // Stealth headers
            await page.setExtraHTTPHeaders({
                'Accept-Language': 'en-US,en;q=0.9',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
                'Accept-Encoding': 'gzip, deflate, br',
                'DNT': '1',
                'Connection': 'keep-alive',
                'Upgrade-Insecure-Requests': '1',
                'Sec-Fetch-Dest': 'document',
                'Sec-Fetch-Mode': 'navigate',
                'Sec-Fetch-Site': 'none',
                'Cache-Control': 'max-age=0',
            });

            gotoOptions.waitUntil = 'domcontentloaded';
        },
    ],
    failedRequestHandler: async ({ request }, error) => {
        const errorMsg = error?.message || 'Unknown error';
        const failedUrl = request.loadedUrl || request.url;
        const isBlocked = /403|429|forbidden|blocked/i.test(errorMsg);

        if (isBlocked) {
            blockedPages.add(failedUrl);
            log.warning(`Blocked: ${failedUrl}`);
        }

        // If the very first seed page was blocked, try fallbacks
        const isSeed = request.userData?.seedStart === true && Number(request.userData?.pageNo || 1) === 1;
        if (isBlocked && isSeed && pushed === 0 && !hasQueuedBlockedFallback && !blockedFallbackQueued.has(failedUrl)) {
            blockedFallbackQueued.add(failedUrl);
            hasQueuedBlockedFallback = true;
            const fallbacks = blockedStartFallbacks(failedUrl)
                .filter((u) => !seenPages.has(u))
                .map((u) => ({ url: u, uniqueKey: `list:${u}`, userData: { label: 'LIST', pageNo: 1, seedStart: false } }));
            if (fallbacks.length) {
                await crawler.addRequests(fallbacks, { forefront: true });
                log.warning('Queued fallback URLs', { blockedUrl: failedUrl, fallbacks: fallbacks.length });
            }
        }

        if (!isBlocked) {
            log.error('Request failed', { url: failedUrl, retries: request.retryCount, error: errorMsg });
        }
    },
});

// ─── Run ─────────────────────────────────────────────────────────────────────
await crawler.run(input.startUrls.map((url) => ({
    url,
    uniqueKey: `list:${url}`,
    userData: { label: 'LIST', pageNo: 1, seedStart: true },
})));

log.info('Run finished', { pushed, discovered: discovered.size, blockedPages: blockedPages.size });

if (pushed === 0 && blockedPages.size > 0 && !proxyEnabled) {
    log.error('All requests were blocked. Enable Apify Proxy (RESIDENTIAL) on the platform to avoid blocks.');
}

await Actor.exit();
