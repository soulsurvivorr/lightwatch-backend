// ============================================================
//  NEWS.JS — Event Detection System for LightWatch
//
//  UPGRADED from a flat "list of articles" feed into an EVENT layer:
//  every RSS/scrape item is still stored as a raw NewsArticle (same
//  as before — admin publish/delete routes are unchanged), but each
//  one is now also matched against recent NewsEvent documents and
//  either merged into an existing event (as a new corroborating
//  source, or as an update — e.g. a restoration notice closing out
//  an outage) or used to start a brand new event.
//
//  GET /events (new) returns the structured, deduplicated view:
//  one entry per real-world incident, with every source that's
//  reported on it, a confidence score, and a timeline of updates.
//  GET /news (existing) keeps its old response shape so the current
//  frontend keeps working untouched, but each row now represents an
//  EVENT (sourceCount/sources added, everything else same field
//  names as before) instead of one single article.
//
//  Wired into server.js exactly the same as before:
//      require('./news')(app, {
//          mongoose, PushSubscription, User,
//          sendPushToSubscribers, normalizeLocation,
//          titleCaseLocation, escapeRegex, verifyAdminToken
//      });
//
//  WHAT'S NEW vs. the previous version of this file
//   1. More sources: Google News search feeds (no official ECG RSS/
//      outlet covers everything — Google News fills the gap and
//      catches outlets we don't have a direct feed for) plus several
//      more Ghanaian outlets. See NEWS_SOURCES / GOOGLE_NEWS_QUERIES.
//   2. Fetch cadence dropped from 20 min to 7 min (env-overridable),
//      inside the requested 5–10 min window.
//   3. Event clustering (findOrCreateEvent / scoreEventMatch below):
//      near-duplicate articles from different outlets, or later
//      follow-ups (a restoration notice for an outage already on
//      file), now land on ONE NewsEvent instead of creating fresh
//      rows — see attachArticleToEvent().
//   4. Structured event fields: eventType, headline, summary,
//      affectedLocations, startTimeText/endTimeText (best-effort —
//      see extractTimeWindow()), firstPublishedAt/lastUpdatedAt,
//      sources[], confidenceScore, history[].
//   5. Broadcast-to-everyone notifications now also fire on the word
//      "dumsor" itself (Ghana's own shorthand for a power crisis),
//      not only on an explicit "nationwide"-style phrase — see
//      shouldBroadcastToAll(). Per-location notifications are
//      unchanged. Both are also now state-gated (see notifiedStates
//      below) so five outlets confirming the SAME outage sends one
//      notification, not five — but a later restoration update for
//      that same event still gets its own, separate notification.
//
//  DEPENDENCIES: same as before — rss-parser, cheerio. No new
//  packages needed; Google News is consumed as an RSS feed like any
//  other source.
// ============================================================

const Parser = require('rss-parser');
const cheerio = require('cheerio');

// Outbound request identity, shared by fetchRssSource() and
// scrapeEcgSite() below. Previously each fetch sent a plain
// 'LightWatchNewsBot/1.0' User-Agent with no Accept/Accept-Language —
// an honest bot signature that's exactly what a WAF/bot-detection rule
// keys on. ECG's blog, Citi News, and Ghana Business News are all now
// returning a flat HTTP 403 (confirmed via server logs) where they
// weren't before. Presenting as a normal desktop browser is the
// standard low-risk fix for this class of block; it won't help if a
// site has escalated to a full JS-executing challenge (Cloudflare
// "Under Attack" mode etc.) rather than simple UA/header sniffing —
// if a source still 403s after this change, that's the likely reason,
// and there's no header-only fix for it.
const OUTBOUND_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept': 'application/rss+xml, application/xml;q=0.9, text/xml;q=0.8, text/html;q=0.7, */*;q=0.5',
    'Accept-Language': 'en-US,en;q=0.9'
};

// How long raw articles/events stick around before MongoDB auto-deletes
// them (TTL indexes below). 12 days = a week and 5 days — once an
// article/event ages past that it's gone from the DB entirely, and
// since GET /news is read straight from the DB (no separate delete
// step needed), it disappears from every client's feed too, on their
// next fetch/cache expiry. Override with NEWS_RETENTION_DAYS on Render
// if needed.
const NEWS_RETENTION_DAYS = Number(process.env.NEWS_RETENTION_DAYS) || 12;
const NEWS_RETENTION_SECONDS = NEWS_RETENTION_DAYS * 24 * 60 * 60;

const rssParser = new Parser({
    timeout: 15000,
    headers: OUTBOUND_HEADERS,
    // Without this, rss-parser silently drops <media:content> and
    // <media:thumbnail> — the tags WordPress/Yoast-based outlets (Adom
    // Online, and most of what Google News surfaces) use to carry their
    // featured image instead of a plain <enclosure>. That silent drop is
    // why images that used to show up (from feeds/snippets that happened
    // to embed a raw <img> in the description) later stopped for sources
    // that only ever provided the image this way — extractImageFromRssItem
    // had nothing to find, with no error to point at.
    customFields: {
        item: [
            ['media:content', 'mediaContent', { keepArray: true }],
            ['media:thumbnail', 'mediaThumbnail', { keepArray: true }]
        ]
    }
});

// ---------------------------------------------------------------
//  XML repair helpers (unchanged from the previous version of this
//  file — several Ghanaian outlets ship feeds with HTML entities,
//  bare attributes, and crossed tags that a strict XML parser
//  rejects outright; these repair just enough to parse without
//  touching CDATA-wrapped bodies).
// ---------------------------------------------------------------
const VOID_ELEMENTS = /^(area|base|br|col|embed|hr|img|input|meta|param|track|wbr)$/i;
const HTML_ENTITY_MAP = {
    nbsp: '\u00A0', mdash: '\u2014', ndash: '\u2013', hellip: '\u2026',
    lsquo: '\u2018', rsquo: '\u2019', ldquo: '\u201C', rdquo: '\u201D',
    copy: '\u00A9', reg: '\u00AE', trade: '\u2122', deg: '\u00B0',
    eacute: '\u00E9', egrave: '\u00E8', agrave: '\u00E0', ccedil: '\u00E7'
};

function repairCrossedTags(xml) {
    const tagPattern = /<\/?([a-zA-Z][\w:-]*)\b[^>]*?(\/)?>/g;
    const stack = [];
    let result = '';
    let lastIndex = 0;
    let match;
    while ((match = tagPattern.exec(xml)) !== null) {
        const full = match[0];
        const name = match[1].toLowerCase();
        const selfClose = match[2];
        const isClosing = full[1] === '/';

        result += xml.slice(lastIndex, match.index);
        lastIndex = tagPattern.lastIndex;

        if (isClosing) {
            const stackIdx = stack.lastIndexOf(name);
            if (stackIdx === -1) continue;
            for (let i = stack.length - 1; i >= stackIdx; i--) {
                result += `</${stack[i]}>`;
            }
            stack.length = stackIdx;
        } else {
            result += full;
            if (!selfClose) stack.push(name);
        }
    }
    result += xml.slice(lastIndex);
    for (let i = stack.length - 1; i >= 0; i--) {
        result += `</${stack[i]}>`;
    }
    return result;
}

// Matches one open/self-closing tag, attribute value either double- or
// single-quoted, OR bare/unquoted (a plain HTML habit — width=150,
// target=_blank — that's invalid XML and was the actual cause behind
// Citi News's and 3News's "Invalid attribute name" parse failures:
// the old version of this pattern only recognized quoted values, so
// on an unquoted `width=150 height=100` it matched "width" as a
// value-less attribute and left "=150" dangling, which the XML parser
// then tried to read as if "150" were the start of a NEW attribute
// name — illegal, since attribute names can't start with a digit.
const TAG_PATTERN = /<([a-zA-Z][\w:-]*)((?:\s+[a-zA-Z_:][\w:.-]*(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*(\/?)\s*>/g;

// Normalizes one tag's attribute string: quoted values pass through
// (re-quoted with " for consistency, internal " escaped), unquoted
// bare values get wrapped in quotes, and a name with no value at all
// gets ="" — the same "Attribute without value" fix as before, just
// folded into one pass alongside the unquoted-value fix above.
function normalizeAttrs(attrs) {
    if (!attrs) return '';
    const fixed = attrs.replace(
        /([a-zA-Z_:][\w:.-]*)(\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g,
        (full, name, hasEq, dq, sq, bare) => {
            if (dq !== undefined) return `${name}="${dq}"`;
            if (sq !== undefined) return `${name}="${sq.replace(/"/g, '&quot;')}"`;
            if (bare !== undefined) return `${name}="${bare}"`;
            return `${name}=""`;
        }
    );
    return fixed.trim();
}

function repairTag(tagName, attrs, selfClose) {
    const fixedAttrs = normalizeAttrs(attrs);
    const needsSelfClose = selfClose || VOID_ELEMENTS.test(tagName);
    return `<${tagName}${fixedAttrs ? ' ' + fixedAttrs : ''}${needsSelfClose ? ' /' : ''}>`;
}

// Swaps every CDATA block out for a placeholder before `fn` runs, then
// restores them afterward — used by both document-wide repair passes
// below so neither one ever rewrites text inside a CDATA-wrapped
// article body.
function withCdataProtected(xml, fn) {
    const cdataBlocks = [];
    let out = xml.replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, (m) => {
        cdataBlocks.push(m);
        return `\u0000CDATA${cdataBlocks.length - 1}\u0000`;
    });

    out = fn(out);

    return out.replace(/\u0000CDATA(\d+)\u0000/g, (_, i) => cdataBlocks[Number(i)]);
}

// STAGE 2 repair — bare/unquoted-attribute normalization only, applied
// document-wide (CDATA-protected). This is what recovers Citi News's/
// 3News's old "Invalid attribute name" failures (unquoted
// `width=150`), wherever in the document they occur — including up in
// <channel> metadata, not just inside article-body fields. Pure
// attribute rewriting only; does NOT touch tag nesting, so it can't
// desync on a stray unescaped "<" in ordinary text the way the
// crossed-tag balancer below can.
function normalizeXmlAttributesDocumentWide(xml) {
    return withCdataProtected(xml, (out) =>
        out.replace(TAG_PATTERN, (match, tagName, attrs, selfClose) => repairTag(tagName, attrs, selfClose))
    );
}

// STAGE 3 repair — crossed/unclosed-tag balancer, applied document-wide
// (CDATA-protected). This is the risky pass: it treats ANY unescaped
// "<" in ordinary text content (a headline like "GH₵ price < last
// month", or any other stray less-than sign a source never escaped) as
// the start of a tag, which desyncs its open/close stack for
// everything downstream. That's fine for a feed that's genuinely
// broken this way (recovers ECG's/GhanaWeb's old "Unexpected close
// tag" failures), but it MUST NOT run against feeds that already parse
// cleanly — see fetchRssSource()'s staged retry below, which only
// reaches this function after both the raw XML and the attribute-only
// fix above have already failed to parse.
function balanceCrossedTagsDocumentWide(xml) {
    return withCdataProtected(xml, (out) => repairCrossedTags(out));
}

// Pure/safe entity fixes only — HTML entities rss-parser's underlying
// XML parser doesn't know (&nbsp; etc.) and bare "&" that isn't already
// part of a valid XML/numeric entity. Always safe to run unconditionally
// since it never touches tag structure, so it stays applied to every
// feed regardless of which (if any) repair stage below ends up needed.
//
// Also escapes a bare "<" that isn't the start of anything tag-shaped
// (next char isn't a letter/`/`/`!`/`?`) — e.g. a stray less-than sign
// or an emoticon like "<3" left unescaped in a headline. This is the
// actual cause behind Citi News's "Invalid character in tag name"
// failure: TAG_PATTERN and repairCrossedTags's own pattern both require
// a letter right after "<" to recognize something as a tag at all, so
// a "<" followed by anything else (digit, space, punctuation) sails
// straight through both of those repair stages untouched and only
// then trips the underlying XML parser. CDATA-protected like the other
// stages, and safe to always run since it can never touch a "<" that
// was already a real tag/comment/CDATA/processing-instruction opener.
function escapeStrayLessThan(xml) {
    return withCdataProtected(xml, (out) => out.replace(/<(?![a-zA-Z/!?])/g, '&lt;'));
}

function sanitizeFeedXml(xml) {
    let out = String(xml || '');
    out = out.replace(/&([a-zA-Z][a-zA-Z0-9]{1,10});/g, (m, name) => {
        const lower = name.toLowerCase();
        if (['amp', 'lt', 'gt', 'quot', 'apos'].includes(lower)) return m;
        return HTML_ENTITY_MAP[lower] !== undefined ? HTML_ENTITY_MAP[lower] : m;
    });
    out = out.replace(/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/g, '&amp;');
    out = escapeStrayLessThan(out);
    return out;
}

// ---- Sources ------------------------------------------------
// `official: true` is reserved for ECG's own site.
//
// Google News is added as a set of *search* feeds — it has no single
// "everything about ECG" feed, so each query below is its own source
// entry. This is what gives coverage of any outlet (Ghanaian or not)
// we don't have a direct RSS feed for, without hand-maintaining a
// feed URL for every single one.
//
// Google News RSS item titles come back as "Headline - Outlet Name"
// (Google's own convention) — parseGoogleNewsItem() below splits that
// back out so the real outlet still gets credited as the source
// instead of everything showing up as "Google News".
function googleNewsUrl(query) {
    return `https://news.google.com/rss/search?q=${encodeURIComponent(query)}+when:14d&hl=en-GH&gl=GH&ceid=GH:en`;
}

const GOOGLE_NEWS_QUERIES = [
    'ECG Ghana',
    'Electricity Company of Ghana',
    'ECG outage',
    'dumsor Ghana',
    'planned power outage Ghana',
    'power restoration Ghana',
    'GRIDCo Ghana',
    'load shedding Ghana'
];

// ECG's own official channel — deliberately kept OUT of NEWS_SOURCES
// (the third-party outlet list below) and fetched via its own isolated
// step in runNewsFetchCycleInner (see ECG_SOURCES loop). ECG's site is
// the one source in this file that's actively bot-gated (Incapsula
// captcha redirect) and the one most likely to need a fundamentally
// different fetch mechanism later (a headless-browser fetch, e.g.
// Playwright, to get past the JS challenge — see the per-source status
// notes this file was fixed against). Keeping it structurally separate
// means that whatever ECG's fetch step becomes, it can never affect
// whether the rest of NEWS_SOURCES gets fetched this cycle — today
// that's already true in practice (each source here has its own
// try/catch), but a headless-browser fetch is a much heavier, more
// failure-prone piece of machinery than a plain HTTP GET, so this scopes
// the blast radius of anything that goes wrong with it to ECG alone,
// both today and once that lands.
const ECG_SOURCES = [
    // ECG's own site sits behind bot-detection on its main domain
    // (confirmed: Render's requests get a captcha-redirect stub back).
    // Its WordPress blog carries the same press releases and isn't
    // behind that gate — though it too has recently started returning
    // "Feed not recognized as RSS 1 or 2" (a bot-challenge interstitial
    // instead of a 403), so this may end up needing the same
    // headless-browser treatment as the site scrape below.
    {
        name: 'ECG',
        icon: '⚡',
        official: true,
        type: 'rss',
        url: 'https://ecg.com.gh/blog/feed/'
    },
    {
        name: 'ECG (site scrape)',
        icon: '⚡',
        official: true,
        type: 'scrape-ecg',
        url: 'https://ecg.com.gh/index.php/en/media-centre/news-events'
    }
];

const NEWS_SOURCES = [
    // Both confirmed bot-gated (serving an HTML challenge page instead
    // of real XML to a plain fetch() — see fetchRssSource's "Response
    // was an HTML page, not an XML feed" error for these two specifically).
    // The desktop-browser headers in OUTBOUND_HEADERS weren't enough on
    // their own, so these route through the same headless-browser render
    // ECG's blog feed already uses (fetchRssViaHeadless) instead of the
    // plain fetch() path every other source below still uses.
    { name: 'Citi News',           icon: '📰', official: false, type: 'rss-headless', url: 'https://citinewsroom.com/feed/' },
    { name: 'MyJoyOnline',         icon: '📰', official: false, type: 'rss', url: 'https://www.myjoyonline.com/feed/' },
    { name: 'Graphic Online',      icon: '📰', official: false, type: 'rss', url: 'https://www.graphic.com.gh/news.feed?type=rss' },
    { name: 'GhanaWeb',            icon: '📰', official: false, type: 'rss-headless', url: 'https://www.ghanaweb.com/GhanaHomePage/NewsArchive/rss.xml' },
    { name: 'Modern Ghana',        icon: '📰', official: false, type: 'rss', url: 'https://rss.modernghana.com/news.xml' },
    { name: 'AdomOnline',          icon: '📰', official: false, type: 'rss', url: 'https://www.adomonline.com/feed' },
    { name: 'Ghana Business News', icon: '📰', official: false, type: 'rss', url: 'https://www.ghanabusinessnews.com/feed/' },
    // Newly added — same WordPress /feed/ convention as most of the
    // list above, but NOT individually confirmed live the way the
    // block above was. fetchRssSource() already fails one dead feed
    // silently without affecting the others, so it's safe to carry
    // these as best-effort; drop any that log a 404/parse error on
    // every run for a week.
    { name: '3News',        icon: '📰', official: false, type: 'rss', url: 'https://3news.com/feed/' },
    { name: 'Starr FM',     icon: '📰', official: false, type: 'rss', url: 'https://starrfm.com.gh/feed/' },
    // Confirmed live (application/rss+xml, WordPress /feed/) — added
    // specifically to get Ghanaian Times off the Google News path. Its
    // Google News-routed items were coming through with no image at all,
    // because Google's redirect link for that outlet's articles wasn't
    // resolving to the real page (see scrapeOgImage's domain guard above
    // for the related "resolves to news.google.com itself" case this
    // isn't — this is the redirect just not resolving, no logo). A
    // direct WordPress feed sidesteps the redirect problem entirely and
    // gets the media:content-based image extraction from earlier for
    // free.
    { name: 'Ghanaian Times', icon: '📰', official: false, type: 'rss', url: 'https://ghanaiantimes.com.gh/feed' },
    // Pulse Ghana (/rss) and Peace FM (/pages/rss/local.xml) both
    // confirmed 404ing on every real cycle — removed rather than left
    // to fail forever. If you find their actual current feed path,
    // just add a new entry above with the same shape.
    // Google News search feeds — see googleNewsUrl() above.
    ...GOOGLE_NEWS_QUERIES.map(q => ({
        name: 'Google News', icon: '🔎', official: false, type: 'google-news', url: googleNewsUrl(q), query: q
    }))
];

// ---- Relevance keyword allowlist -----------------------------
const NEWS_KEYWORDS = [
    'ecg', 'electricity company of ghana', 'gridco', 'ghana grid company',
    'power outage', 'power cut', 'blackout', 'load shedding', 'dumsor',
    'electricity tariff', 'tariff hike', 'transformer', 'feeder fault',
    'substation', 'power restoration', 'power supply',
    'electricity supply', 'planned maintenance', 'network maintenance',
    'prepaid meter', 'purc', 'national grid', 'power interruption',
    'electricity bill', 'energy commission', 'power crisis', 'electricity',
    'power rationing', 'load management', 'distribution network'
];
const NEWS_KEYWORD_REGEX = new RegExp(
    '\\b(' + NEWS_KEYWORDS.map(k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')\\b',
    'i'
);
function isRelevantArticle(text) {
    return NEWS_KEYWORD_REGEX.test(text);
}

// ---- Ghana-signal check (Google News items only) -----------------
// Google News search is NOT a strict AND-match — a query like
// "planned power outage Ghana" can still return an article that's
// really about somewhere like Oro-Medonte, Ontario, just because it
// happens to say "planned power outage" and Google's own ranking
// pulled it into the result set. Direct RSS feeds (Citi News,
// GhanaWeb, MyJoyOnline, etc.) don't need this extra check — every
// outlet in NEWS_SOURCES is a Ghanaian outlet by definition, so they
// only ever cover Ghana anyway.
//
// This deliberately does NOT lean on PushSubscription/User city data
// (mentionedLocations) as its main signal — on a fresh app with no
// subscribers yet, that list is empty, which would make this filter
// reject almost everything. Instead it checks against a static
// gazetteer of Ghanaian places, so it works from day one regardless
// of how many users have signed up.
//
// A Ghana-specific institutional term is treated as sufficient proof
// on its own — no foreign outage story is going to organically
// mention ECG, GRIDCo, or "dumsor". Otherwise, require an explicit
// "Ghana" mention, or a hit against a known Ghanaian region/city/town.
const GHANA_SPECIFIC_KEYWORDS = [
    'ecg', 'electricity company of ghana', 'gridco', 'ghana grid company',
    'dumsor', 'purc', 'energy commission'
];
const GHANA_SPECIFIC_REGEX = new RegExp(
    '\\b(' + GHANA_SPECIFIC_KEYWORDS.map(k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')\\b',
    'i'
);
const GHANA_MENTION_REGEX = /\bghana(ian)?\b/i;

// Regions (ambiguous single-word region names require a "region" suffix
// so "western outage" etc. can't match on its own) plus major cities/
// towns across all regions. Not exhaustive, but wide enough to catch
// the vast majority of real Ghanaian datelines.
const GHANA_REGION_KEYWORDS = [
    'greater accra', 'ashanti region', 'western region', 'western north',
    'central region', 'eastern region', 'volta region', 'oti region',
    'northern region', 'north east region', 'upper east', 'upper west',
    'bono region', 'bono east', 'ahafo region', 'savannah region'
];
const GHANA_CITY_KEYWORDS = [
    'accra', 'kumasi', 'tamale', 'takoradi', 'sekondi', 'sunyani',
    'koforidua', 'cape coast', 'bolgatanga', 'techiman', 'tema',
    'ashaiman', 'obuasi', 'kasoa', 'madina', 'adenta', 'achimota',
    'dansoman', 'nungua', 'teshie', 'dodowa', 'aburi', 'nkawkaw',
    'konongo', 'ejisu', 'mampong', 'berekum', 'dunkwa', 'axim', 'elmina',
    'winneba', 'swedru', 'nsawam', 'suhum', 'asamankese', 'tarkwa',
    'prestea', 'bogoso', 'wenchi', 'kintampo', 'yendi', 'savelugu',
    'bawku', 'navrongo', 'nalerigu', 'damongo', 'salaga', 'hohoe',
    'keta', 'anloga', 'akatsi', 'sogakope'
];
const GHANA_PLACE_REGEX = new RegExp(
    '\\b(' + [...GHANA_REGION_KEYWORDS, ...GHANA_CITY_KEYWORDS]
        .map(k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')\\b',
    'i'
);

function isGhanaRelevant(text, mentionedLocations) {
    return GHANA_SPECIFIC_REGEX.test(text)
        || GHANA_MENTION_REGEX.test(text)
        || GHANA_PLACE_REGEX.test(text)
        || mentionedLocations.length > 0;
}

// ---- Event type detection -------------------------------------
// Same categories as before, renamed at the API boundary to the
// requested event-type vocabulary (see EVENT_TYPE_LABELS below).
// 'restoration'/'maintenance' checked before the generic 'outage'
// match so a "power restored after fault" story doesn't get stuck
// as an outage.
function detectCategory(text) {
    const t = text.toLowerCase();
    if (/(restor|back on|resum|reconnect)/.test(t)) return 'restoration';
    if (/(maintenance|upgrade|scheduled|planned outage|planned works)/.test(t)) return 'maintenance';
    if (/(tariff|price hike|bill increase|surcharge)/.test(t)) return 'tariff';
    if (/(outage|fault|blackout|power cut|interruption|dumsor|load shedding)/.test(t)) return 'outage';
    return 'general';
}

// A "planned" vs "unplanned" outage split, used only to pick the
// display eventType label — everything else (clustering, storage)
// still runs off the coarser `category` above.
function detectOutageType(text) {
    return /(planned|scheduled|will (be )?(carried out|conducted)|notice of (a )?(planned )?outage)/i.test(text)
        ? 'Planned Outage'
        : 'Unplanned Outage';
}

const EVENT_TYPE_LABELS = {
    outage: null, // resolved to Planned/Unplanned via detectOutageType()
    restoration: 'Power Restoration',
    maintenance: 'Maintenance',
    tariff: 'General Announcement',
    general: 'General Announcement'
};

function eventTypeLabel(category, text) {
    if (category === 'outage') return detectOutageType(text);
    return EVENT_TYPE_LABELS[category] || 'General Announcement';
}

// `category` FAMILIES that are allowed to merge into one another as
// an event evolves over time (an outage that later gets a
// restoration notice is the SAME event; a tariff story never merges
// with an outage story just because they mention the same town).
const CATEGORY_FAMILY = { outage: 'incident', restoration: 'incident', maintenance: 'incident', tariff: 'policy', general: 'general' };

// ---- Nationwide-outage detection -----------------------------
const NATIONWIDE_KEYWORDS = [
    'nationwide', 'countrywide', 'country-wide', 'across the country',
    'national grid', 'all regions', 'entire country', 'all 16 regions',
    'across ghana', 'throughout the country'
];
const NATIONWIDE_REGEX = new RegExp(
    '\\b(' + NATIONWIDE_KEYWORDS.map(k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')\\b',
    'i'
);
function isNationwideArticle(text, category) {
    if (!['outage', 'restoration', 'maintenance'].includes(category)) return false;
    return NATIONWIDE_REGEX.test(text);
}

// "dumsor" is Ghana's own shorthand for a widespread power crisis —
// treated as broadcast-worthy in its own right, separately from the
// explicit nationwide-phrase check above (a headline can say "dumsor
// hits Kasoa" and still be worth an all-user heads-up even though
// it's phrased as one town).
const DUMSOR_REGEX = /\bdumsor\b/i;
// Was: only nationwide-phrased or "dumsor" articles ever reached every
// subscriber — a plain single-town outage story only ever reached
// people at that location. Per product decision, ANY article that
// resolved to the 'outage' category (see categorizeArticle() /
// detectCategory() above) is now broadcast-worthy on its own, in
// addition to the existing nationwide/dumsor triggers — someone in
// Kumasi may still want the heads-up that Accra just lost power, even
// with no location match. `category` is optional so the couple of
// other callers of this helper (if any get added later) that don't
// have a resolved category yet still fall back to the original
// nationwide/dumsor-only behavior.
function shouldBroadcastToAll(text, isNationwide, category) {
    return isNationwide || DUMSOR_REGEX.test(text) || category === 'outage';
}

// ---- Best-effort start/end time extraction ---------------------
// Deliberately returns free-text spans, not parsed Date objects —
// Ghanaian outage notices phrase timing too inconsistently ("from
// 7am to 6pm on Tuesday 29th", "for 24 hours starting Monday",
// "between 0800 and 1700hrs") to safely coerce into a single Date
// without silently misreading one of those formats. Downstream
// consumers get a readable string; startTime/endTime Date fields are
// only ever set when a full explicit date+time is unambiguous.
const TIME_WINDOW_REGEX = /\b(from|between)\s+([0-9]{1,2}(:[0-9]{2})?\s?(am|pm|hrs?)?)\s+(to|and|-|–)\s+([0-9]{1,2}(:[0-9]{2})?\s?(am|pm|hrs?)?)\b/i;
const DURATION_REGEX = /\bfor\s+(\d+)\s*(hour|hr|day)s?\b/i;
function extractTimeWindow(text) {
    const windowMatch = TIME_WINDOW_REGEX.exec(text);
    if (windowMatch) {
        return { startTimeText: windowMatch[2].trim(), endTimeText: windowMatch[6].trim() };
    }
    const durationMatch = DURATION_REGEX.exec(text);
    if (durationMatch) {
        return { startTimeText: null, endTimeText: `~${durationMatch[1]} ${durationMatch[2]}(s) after start` };
    }
    return { startTimeText: null, endTimeText: null };
}

// ---- Title similarity (event clustering) ------------------------
const TITLE_STOPWORDS = new Set([
    'the', 'a', 'an', 'in', 'on', 'at', 'to', 'for', 'of', 'and', 'or', 'is', 'are',
    'will', 'has', 'have', 'be', 'as', 'by', 'with', 'from', 'ecg', 'ghana', 'news',
    'says', 'over', 'after', 'amid', 'due'
]);
function titleTokens(title) {
    return title
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter(w => w.length > 2 && !TITLE_STOPWORDS.has(w));
}
function jaccardSimilarity(aTokens, bTokens) {
    if (!aTokens.length || !bTokens.length) return 0;
    const a = new Set(aTokens), b = new Set(bTokens);
    let intersection = 0;
    for (const w of a) if (b.has(w)) intersection++;
    const union = a.size + b.size - intersection;
    return union === 0 ? 0 : intersection / union;
}

// Cheap normalized-title key — kept for the raw-NewsArticle exact/
// near-duplicate check further down (unrelated to event clustering).
function titleDedupeKey(title) {
    return title
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .split(' ')
        .slice(0, 12)
        .join(' ');
}

// Catches the case where Google News' "Headline - Outlet" title format
// didn't parse cleanly and what's left is a URL slug instead of real
// prose (e.g. "govt-averts-dumsor") — all-lowercase, hyphen-joined,
// no spaces, no punctuation. A genuine headline never looks like this,
// so it's a safe, narrow pattern to catch and clean up rather than
// show users a slug verbatim.
const SLUG_TITLE_REGEX = /^[a-z0-9]+(?:-[a-z0-9]+){2,}$/;
function humanizeSlugTitle(title) {
    const t = String(title || '').trim();
    if (!SLUG_TITLE_REGEX.test(t)) return t;
    return t.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

// Last-resort fallback for a feed that STILL fails to parse as XML
// even after sanitizeFeedXml() — pulls title/link/pubDate/description
// out of each <item>...</item> block with plain regex instead of a
// real parser, tolerant of exactly the kind of malformed nesting that
// makes rss-parser give up entirely. Deliberately dumb (no attempt at
// full RSS spec compliance) — this only runs as a fallback, and
// "some fields, roughly right" beats "nothing at all" for a feed
// that's otherwise unusable. Logged distinctly so it's obvious in the
// logs when a feed is limping along on this path rather than parsing
// cleanly, in case it's worth debugging the actual XML at some point.
function extractItemsWithRegex(rawXml) {
    const items = [];
    const itemBlocks = rawXml.match(/<item[\s\S]*?<\/item>/gi) || [];
    for (const block of itemBlocks) {
        const grab = (tag) => {
            const m = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i').exec(block);
            if (!m) return '';
            return m[1].replace(/^<!\[CDATA\[([\s\S]*?)\]\]>$/i, '$1').trim();
        };
        const title = stripHtml(grab('title'));
        const link = grab('link').trim();
        if (!title || !link) continue;
        const pubDateRaw = grab('pubdate') || grab('dc:date');
        let isoDate = null;
        if (pubDateRaw) {
            const d = new Date(pubDateRaw);
            if (!isNaN(d)) isoDate = d.toISOString();
        }
        items.push({ title, link, contentSnippet: stripHtml(grab('description')), isoDate });
    }
    return items;
}

function stripHtml(html) {
    return String(html || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

// Pulls a $.url (or bare .url) out of an rss-parser customField value,
// which can come back as either a single object or an array depending
// on the feed — keepArray:true above always gives us an array, but this
// stays defensive in case a feed shape changes.
function firstMediaUrl(field) {
    const list = Array.isArray(field) ? field : (field ? [field] : []);
    for (const entry of list) {
        const url = entry?.$?.url || entry?.url;
        if (url) return url;
    }
    return null;
}

function extractImageFromRssItem(item) {
    if (item.enclosure && item.enclosure.url) return item.enclosure.url;
    // media:content / media:thumbnail — see the customFields comment on
    // rssParser above for why these need checking explicitly.
    const mediaContentUrl = firstMediaUrl(item.mediaContent);
    if (mediaContentUrl) return mediaContentUrl;
    const mediaThumbnailUrl = firstMediaUrl(item.mediaThumbnail);
    if (mediaThumbnailUrl) return mediaThumbnailUrl;
    const html = item['content:encoded'] || item.content || item.summary || '';
    const match = /<img[^>]+src="([^"]+)"/i.exec(html);
    return match ? match[1] : null;
}

// Google News' own RSS feed NEVER carries an image — no <enclosure>, no
// media:content, nothing in the description either. That's not a parsing
// gap like the media:content one above; the data simply isn't in the
// feed. Since Google News search is most of what actually gets fetched
// here (Yen News, Ghanaian Times, Graphic Online, etc. all come in
// through it), that alone would leave most articles image-less forever.
//
// The only way to get a real image for these is to visit the article
// page itself and read its og:image meta tag. item.link is a Google
// News redirect wrapper (news.google.com/rss/articles/...), not the
// publisher's real URL — following it with a normal HTTP request
// resolves through to the real page for many (not all) links; when it
// doesn't, this just finds no og:image and returns null, same as before
// the fix, so there's no downside to always trying it.
//
// Best-effort and deliberately quiet on failure: a slow or blocking
// publisher site should never take down the whole fetch cycle over one
// missing thumbnail.
async function scrapeOgImage(url, debugInfo) {
    // debugInfo is optional and purely additive — when a caller passes an
    // object, this fills in .reason (and sometimes .detail) explaining
    // why null came back. The live fetch cycle doesn't pass one and
    // behaves exactly as before; the backfill-images-live route below
    // does, so failures are visible instead of just silently absent.
    const setReason = (reason, detail) => {
        if (debugInfo) {
            debugInfo.reason = reason;
            if (detail !== undefined) debugInfo.detail = detail;
        }
    };
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);
    try {
        const res = await fetch(url, {
            redirect: 'follow',
            signal: controller.signal,
            headers: OUTBOUND_HEADERS
        });
        if (!res.ok) { setReason('http-error', res.status); return null; }
        // If the redirect never actually left Google (res.url is still
        // news.google.com/google.com), this is Google's own interstitial
        // page, not the publisher's article — its og:image is a generic
        // "G News" branding logo, which is exactly the ugly fallback that
        // was showing up on every article whose redirect didn't resolve.
        // Bail out here instead of scraping that page at all.
        let finalHost = '';
        try { finalHost = new URL(res.url).hostname; } catch (_) { /* leave empty */ }
        if (/(^|\.)google\.com$/i.test(finalHost) || /(^|\.)gstatic\.com$/i.test(finalHost)) {
            setReason('redirect-stayed-on-google', finalHost);
            return null;
        }
        // The redirect DID resolve to a real publisher page — surface
        // that resolved URL via debugInfo even before we know whether an
        // og:image is present, so callers can use it for the source
        // favicon (real outlet domain) instead of Google's wrapper link.
        if (debugInfo) debugInfo.resolvedUrl = res.url;

        // Bail early on non-HTML responses (PDFs, images, etc.) rather
        // than reading a potentially huge body just to find no match.
        const contentType = res.headers.get('content-type') || '';
        if (!contentType.includes('html')) { setReason('non-html-response', contentType); return null; }
        const html = await res.text();
        // og:image first, twitter:image as a fallback — attribute order
        // varies by site (content-before-property is common), so this
        // checks both orders rather than assuming one.
        const patterns = [
            /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i,
            /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i,
            /<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i,
            /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image["']/i
        ];
        for (const re of patterns) {
            const match = re.exec(html);
            if (match && match[1]) {
                // Extra safety net: even on a non-Google host, don't accept
                // an image that's itself served from a Google-owned domain
                // (e.g. a page that embeds Google's share-card image
                // somewhere in its markup) — that's still the same ugly
                // logo, not a real article photo.
                let imgHost = '';
                try { imgHost = new URL(match[1], res.url).hostname; } catch (_) { /* leave empty */ }
                if (/(^|\.)google\.com$/i.test(imgHost) || /(^|\.)gstatic\.com$/i.test(imgHost) || /(^|\.)googleusercontent\.com$/i.test(imgHost)) continue;
                return match[1];
            }
        }
        setReason('no-og-image-tag-found');
        return null;
    } catch (err) {
        setReason('fetch-threw', err.message);
        return null;
    } finally {
        clearTimeout(timeout);
    }
}

function resolveUrl(maybeRelative, base) {
    if (!maybeRelative) return null;
    try { return new URL(maybeRelative, base).toString(); }
    catch { return null; }
}

// "2 minutes ago" / "3 hours ago" / "5 days ago" — computed fresh on
// every response (not stored) so it's never stale sitting in the DB.
// Falls back to a plain date once it's old enough that "N days ago"
// stops being useful.
function formatTimeAgo(date) {
    if (!date) return '';
    const d = date instanceof Date ? date : new Date(date);
    if (isNaN(d)) return '';
    const seconds = Math.floor((Date.now() - d.getTime()) / 1000);
    if (seconds < 0) return 'just now';
    if (seconds < 45) return 'just now';
    if (seconds < 90) return '1 minute ago';
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `${minutes} minutes ago`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return hours === 1 ? '1 hour ago' : `${hours} hours ago`;
    const days = Math.round(hours / 24);
    if (days < 7) return days === 1 ? '1 day ago' : `${days} days ago`;
    const weeks = Math.round(days / 7);
    if (weeks < 5) return weeks === 1 ? '1 week ago' : `${weeks} weeks ago`;
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

// Real per-source logo, not a hand-picked emoji — resolved from
// whichever URL that source's article actually lives at, via Google's
// public favicon endpoint. This is what "fetches" the logo: the
// browser loads this URL directly as an <img src>, and it works out
// of the box for any outlet (including ones added later) without a
// logo image having to be uploaded/hosted for each one.
function sourceLogoUrl(articleUrl) {
    try {
        const host = new URL(articleUrl).hostname.replace(/^www\./, '');
        return `https://www.google.com/s2/favicons?sz=64&domain=${host}`;
    } catch {
        return null;
    }
}

// Google News RSS titles are "Headline - Outlet"; the outlet name is
// everything after the LAST " - " (headlines themselves sometimes
// contain a dash, so splitting on the first one would cut a real
// headline in half).
function parseGoogleNewsItem(item) {
    const raw = String(item.title || '');
    const idx = raw.lastIndexOf(' - ');
    if (idx === -1) return { headline: raw, outlet: 'Google News' };
    return { headline: raw.slice(0, idx).trim(), outlet: raw.slice(idx + 3).trim() || 'Google News' };
}

module.exports = function initNewsSystem(app, deps) {
    const {
        mongoose,
        PushSubscription,
        User,
        sendPushToSubscribers,
        normalizeLocation,
        titleCaseLocation,
        escapeRegex,
        verifyAdminToken
    } = deps;

    // ---- Schema / model: raw ingested articles (unchanged shape,
    // admin routes below still operate on this exactly as before) --
    const newsArticleSchema = new mongoose.Schema({
        title:        { type: String, required: true },
        summary:      { type: String, default: '' },
        imageUrl:     { type: String, default: null },
        sourceName:   { type: String, required: true },
        sourceIcon:   { type: String, default: '📰' },
        isOfficial:   { type: Boolean, default: false },
        category:     { type: String, enum: ['maintenance', 'outage', 'tariff', 'restoration', 'general'], default: 'general' },
        articleUrl:   { type: String, required: true, unique: true },
        // Populated only for Google News items whose redirect actually
        // resolves through to the real publisher page (see scrapeOgImage).
        // Lets sourceLogoUrl() show the real outlet's favicon instead of
        // Google's own — articleUrl itself stays untouched since it's
        // still the correct click-through link.
        resolvedUrl:  { type: String, default: null },
        dedupeKey:    { type: String, required: true },
        publishedAt:  { type: Date, required: true },
        fetchedAt:    { type: Date, default: Date.now },
        mentionedLocations: { type: [String], default: [] },
        notifiedLocations:  { type: [String], default: [] },
        isNationwide:       { type: Boolean, default: false },
        notifiedNationwide: { type: Boolean, default: false },
        isAdminPosted:      { type: Boolean, default: false },
        // NEW — which NewsEvent this raw article was folded into.
        eventId: { type: mongoose.Schema.Types.ObjectId, ref: 'NewsEvent', default: null }
    });
    // TTL: MongoDB auto-deletes a raw article once its publishedAt is
    // older than NEWS_RETENTION_DAYS — no cron job/route needed. The
    // NewsEvent it was folded into is unaffected (see the separate TTL
    // on newsEventSchema.lastUpdatedAt below) — an event that's still
    // getting corroborating sources/updates keeps living long after its
    // oldest founding article has aged out and been dropped.
    newsArticleSchema.index({ publishedAt: -1 }, { expireAfterSeconds: NEWS_RETENTION_SECONDS });
    newsArticleSchema.index({ isOfficial: -1, publishedAt: -1 });
    newsArticleSchema.index({ dedupeKey: 1, publishedAt: -1 });
    newsArticleSchema.index({ mentionedLocations: 1, isOfficial: -1, publishedAt: -1 });
    newsArticleSchema.index({ mentionedLocations: 1 });
    newsArticleSchema.index({ eventId: 1 });

    const NewsArticle = mongoose.models.NewsArticle || mongoose.model('NewsArticle', newsArticleSchema);

    // ---- Schema / model: NEW — permanent delete blocklist ----------
    // Deleting an event/article previously only removed the current
    // rows — if the source (Google News especially, with its 14-day
    // search window) still served the same story on a later fetch
    // cycle, storeArticle saw a "new" URL (since the old row was gone)
    // and recreated it, complete with re-firing push notifications.
    // Every delete now also records the deleted article's articleUrl
    // and dedupeKey here; storeArticle checks both before creating
    // anything, so a deliberately-deleted story stays gone for good,
    // even under a different outlet's URL for the same headline.
    const newsBlocklistSchema = new mongoose.Schema({
        articleUrl: { type: String, required: true, unique: true },
        dedupeKey:  { type: String, default: null },
        deletedAt:  { type: Date, default: Date.now }
    });
    newsBlocklistSchema.index({ dedupeKey: 1 });
    const NewsBlocklist = mongoose.models.NewsBlocklist || mongoose.model('NewsBlocklist', newsBlocklistSchema);

    // ---- Schema / model: NEW — clustered events -------------------
    const newsEventSchema = new mongoose.Schema({
        // Coarse family, used for clustering/queries. eventType is the
        // human-facing label derived from this + text (see eventTypeLabel).
        category: { type: String, enum: ['maintenance', 'outage', 'tariff', 'restoration', 'general'], default: 'general' },
        eventType: { type: String, required: true }, // e.g. "Planned Outage", "Power Restoration"
        headline:  { type: String, required: true }, // most-recently-updated headline
        summary:   { type: String, default: '' },
        imageUrl:  { type: String, default: null },
        affectedLocations: { type: [String], default: [] },
        isNationwide: { type: Boolean, default: false },
        startTimeText: { type: String, default: null },
        endTimeText:   { type: String, default: null },
        startTime: { type: Date, default: null },
        endTime:   { type: Date, default: null },
        firstPublishedAt: { type: Date, required: true },
        lastUpdatedAt:    { type: Date, required: true },
        dedupeKey: { type: String, required: true }, // title key of the FIRST source, used as a fast pre-filter
        titleTokens: { type: [String], default: [] }, // cached tokens of the most recent headline, for re-scoring
        sources: {
            type: [{
                name: String, icon: String, official: Boolean,
                url: String, resolvedUrl: String, headline: String, publishedAt: Date
            }], default: []
        },
        confidenceScore: { type: Number, default: 0 }, // 0-100
        status: { type: String, enum: ['active', 'resolved'], default: 'active' },
        // Every category label this event has already triggered a push
        // for — stops five sources confirming the SAME outage from
        // sending five notifications, while still letting a later
        // status change (outage -> restoration) send its own.
        notifiedStates: { type: [String], default: [] },
        history: {
            type: [{ at: Date, note: String }], default: []
        }
    });
    // TTL: deletes an event once it's gone NEWS_RETENTION_DAYS with no
    // update. Because lastUpdatedAt gets bumped forward every time a new
    // corroborating source or a restoration update attaches (see
    // attachArticleToEvent), an event that's still active effectively
    // never expires — only ones that have genuinely gone quiet do.
    newsEventSchema.index({ lastUpdatedAt: -1 }, { expireAfterSeconds: NEWS_RETENTION_SECONDS });
    newsEventSchema.index({ category: 1, lastUpdatedAt: -1 });
    newsEventSchema.index({ affectedLocations: 1, lastUpdatedAt: -1 });
    newsEventSchema.index({ dedupeKey: 1 });

    const NewsEvent = mongoose.models.NewsEvent || mongoose.model('NewsEvent', newsEventSchema);

    // ---- Location matching (unchanged) -----------------------------
    async function getKnownLocationKeys() {
        const [subLocations, secondaryLocations, userCities] = await Promise.all([
            PushSubscription.distinct('location'),
            PushSubscription.distinct('secondaryLocationKey'),
            User.distinct('city')
        ]);
        const keys = new Set();
        [...subLocations, ...secondaryLocations, ...userCities].forEach(loc => {
            if (!loc) return;
            const key = normalizeLocation(loc).split(',')[0].trim();
            if (key && key.length >= 3) keys.add(key);
        });
        return [...keys];
    }

    function findMentionedLocations(text, knownKeys) {
        const t = normalizeLocation(text);
        if (!t) return [];
        return knownKeys.filter(key => {
            const re = new RegExp(`\\b${escapeRegex(key)}\\b`, 'i');
            return re.test(t);
        });
    }

    // ---- Notifications ---------------------------------------------
    // Set only for the duration of runNewsFetchCycle() below — while
    // it's set, notifyForEvent() queues instead of sending immediately,
    // so several distinct events discovered in the same 7-minute cycle
    // (real example from your logs: 4 separate dumsor maintenance
    // notices in one cycle) land as ONE digest push instead of four
    // back-to-back ones. Outside a scheduled cycle (e.g. the admin
    // manual-publish route) this stays null and sends immediately.
    let activeCycleQueue = null;

    async function notifyLocationMentions(event, locationKeys) {
        if (!locationKeys.length) return;
        try {
            const subscribers = await PushSubscription.find({ location: { $in: locationKeys } }).lean();
            if (!subscribers.length) return;
            const displayLocation = titleCaseLocation(locationKeys[0]);
            const payload = {
                title: `LightWatch News — ${displayLocation}`,
                body: event.headline,
                url: '/pages/chat.html',
                tag: `news-event-${event._id}-${event.category}`,
                requireInteraction: false,
                vibrate: [200, 90, 200],
                tone: 'news'
            };
            console.log(`[news] Notifying ${subscribers.length} subscriber(s) — "${event.headline}" mentions ${locationKeys.join(', ')}`);
            await sendPushToSubscribers(subscribers, payload);
        } catch (err) {
            console.error('[news] Location-mention push error:', err.message);
        }
    }

    async function notifyAllUsers(event, reason) {
        try {
            // Send every news event to all subscribed push clients.
            // This intentionally ignores the outage-specific opt-out
            // toggle, because every fetched news item should arrive as a
            // notification to users when this feature is enabled.
            const subscribers = await PushSubscription.find({}).lean();
            if (!subscribers.length) return;
            const payload = {
                title: 'LightWatch News — Ghana',
                body: event.headline,
                url: '/pages/chat.html',
                tag: `news-event-broadcast-${event._id}-${event.category}`,
                requireInteraction: false,
                vibrate: [200, 90, 200, 90, 200],
                tone: 'news'
            };
            console.log(`[news] Broadcasting to ${subscribers.length} subscriber(s) [${reason}] — "${event.headline}"`);
            await sendPushToSubscribers(subscribers, payload);
        } catch (err) {
            console.error('[news] Broadcast push error:', err.message);
        }
    }

    async function notifyAllUsersDigest(events) {
        try {
            const subscribers = await PushSubscription.find({ outageNewsAlertsEnabled: { $ne: false } }).lean();
            if (!subscribers.length) return;
            const headlines = events.slice(0, 3).map(e => e.headline);
            const more = events.length > 3 ? ` +${events.length - 3} more` : '';
            const payload = {
                title: `LightWatch News — ${events.length} power updates`,
                body: headlines.join(' • ') + more,
                url: '/pages/chat.html',
                tag: `news-digest-broadcast-${Date.now()}`,
                requireInteraction: false,
                vibrate: [200, 90, 200, 90, 200],
                tone: 'news'
            };
            console.log(`[news] Broadcasting DIGEST to ${subscribers.length} subscriber(s) — ${events.length} events bundled`);
            await sendPushToSubscribers(subscribers, payload);
        } catch (err) {
            console.error('[news] Digest broadcast push error:', err.message);
        }
    }

    async function notifyLocationDigest(locationKey, events) {
        try {
            const subscribers = await PushSubscription.find({ location: locationKey }).lean();
            if (!subscribers.length) return;
            const displayLocation = titleCaseLocation(locationKey);
            const headlines = events.slice(0, 3).map(e => e.headline);
            const more = events.length > 3 ? ` +${events.length - 3} more` : '';
            const payload = {
                title: `LightWatch News — ${displayLocation} (${events.length} updates)`,
                body: headlines.join(' • ') + more,
                url: '/pages/chat.html',
                tag: `news-digest-${locationKey}-${Date.now()}`,
                requireInteraction: false,
                vibrate: [200, 90, 200],
                tone: 'news'
            };
            console.log(`[news] Notifying ${subscribers.length} subscriber(s) [digest] — ${displayLocation}: ${events.length} events bundled`);
            await sendPushToSubscribers(subscribers, payload);
        } catch (err) {
            console.error('[news] Location digest push error:', err.message);
        }
    }

    async function flushCycleQueue(queue) {
        if (!queue) return;
        const { broadcasts, byLocation } = queue;
        if (broadcasts.length === 1) {
            await notifyAllUsers(broadcasts[0].event, broadcasts[0].reason);
        } else if (broadcasts.length > 1) {
            await notifyAllUsersDigest(broadcasts.map(b => b.event));
        }
        for (const [loc, events] of byLocation.entries()) {
            if (events.length === 1) await notifyLocationMentions(events[0], [loc]);
            else await notifyLocationDigest(loc, events);
        }
    }

    // Fires whenever an event is created, or an existing one changes to
    // a status it hasn't already notified for (see notifiedStates).
    // Deliberately does NOT fire again just because a 2nd/3rd/4th source
    // confirms the same already-notified state — that only bumps
    // confidence, silently.
    async function notifyForEvent(event, combinedText) {
        if (event.notifiedStates.includes(event.category)) return;

        const reason = 'all-news';

        if (activeCycleQueue) {
            activeCycleQueue.broadcasts.push({ event, reason });
        } else {
            await notifyAllUsers(event, reason);
        }

        event.notifiedStates.push(event.category);
        await event.save();
    }

    // ---- Confidence score --------------------------------------------
    // Weighted by how many distinct outlets independently reported this
    // event and whether any of them is ECG's own official channel — a
    // single source (even ECG) is meaningful but capped below 100 since
    // there's been no independent corroboration yet.
    function computeConfidence(event) {
        const distinctOutlets = new Set(event.sources.map(s => s.name)).size;
        const hasOfficial = event.sources.some(s => s.official);
        let score = Math.min(distinctOutlets, 5) * 15; // up to 75 for 5+ outlets
        if (hasOfficial) score += 20;
        if (distinctOutlets === 1 && !hasOfficial) score = Math.min(score, 35);
        return Math.max(0, Math.min(100, score));
    }

    // ---- Event clustering --------------------------------------------
    // Looks for a recent, same-family event this article most likely
    // belongs to. Returns the best match (if any) above threshold.
    async function findMatchingEvent(article, category, mentionedLocations, nationwide) {
        const family = CATEGORY_FAMILY[category];
        const cutoff = new Date(Date.now() - EVENT_MATCH_WINDOW_MS);
        const familyCategories = Object.keys(CATEGORY_FAMILY).filter(c => CATEGORY_FAMILY[c] === family);

        const query = {
            category: { $in: familyCategories },
            lastUpdatedAt: { $gte: cutoff },
            status: 'active'
        };
        if (mentionedLocations.length || nationwide) {
            query.$or = [
                ...(mentionedLocations.length ? [{ affectedLocations: { $in: mentionedLocations } }] : []),
                ...(nationwide ? [{ isNationwide: true }] : [])
            ];
        }

        const candidates = await NewsEvent.find(query).limit(30).lean();
        if (!candidates.length) return null;

        const incomingTokens = titleTokens(article.title);
        let best = null, bestScore = 0;
        for (const candidate of candidates) {
            const sim = jaccardSimilarity(incomingTokens, candidate.titleTokens || []);
            const locationOverlap = mentionedLocations.some(l => (candidate.affectedLocations || []).includes(l));
            // Require either location overlap (or both nationwide) alongside
            // a modest title match, OR a very high title match on its own
            // (catches paraphrased headlines where location extraction
            // missed a place name mentioned only in the body).
            const qualifies = (sim >= 0.35 && (locationOverlap || (nationwide && candidate.isNationwide))) || sim >= 0.6;
            if (qualifies && sim > bestScore) { best = candidate; bestScore = sim; }
        }
        return best;
    }

    // Merges a raw article into an existing event, or creates a new one.
    // Always runs (independent of whether the raw NewsArticle itself
    // was a near-duplicate of one already stored) — corroboration from
    // a second outlet on the SAME story is exactly what should raise
    // confidence, not get thrown away.
    async function attachArticleToEvent(article, combinedText, category, mentionedLocations, nationwide) {
        const match = await findMatchingEvent(article, category, mentionedLocations, nationwide);
        const { startTimeText, endTimeText } = extractTimeWindow(combinedText);
        const label = eventTypeLabel(category, combinedText);

        if (!match) {
            const event = await NewsEvent.create({
                category,
                eventType: label,
                headline: article.title,
                summary: article.summary,
                imageUrl: article.imageUrl || null,
                affectedLocations: mentionedLocations,
                isNationwide: nationwide,
                startTimeText, endTimeText,
                firstPublishedAt: article.publishedAt,
                lastUpdatedAt: article.publishedAt,
                dedupeKey: titleDedupeKey(article.title),
                titleTokens: titleTokens(article.title),
                sources: [{
                    name: article.sourceName, icon: article.sourceIcon, official: article.isOfficial,
                    url: article.articleUrl, resolvedUrl: article.resolvedUrl || null, headline: article.title, publishedAt: article.publishedAt
                }],
                confidenceScore: 0,
                history: [{ at: article.publishedAt, note: `Event opened from ${article.sourceName}` }]
            });
            event.confidenceScore = computeConfidence(event);
            await event.save();
            article.eventId = event._id;
            await article.save();
            await notifyForEvent(event, combinedText);
            return event;
        }

        const event = await NewsEvent.findById(match._id);
        const alreadyHasSource = event.sources.some(s => s.url === article.articleUrl);
        const statusChanged = event.category !== category;

        if (!alreadyHasSource) {
            event.sources.push({
                name: article.sourceName, icon: article.sourceIcon, official: article.isOfficial,
                url: article.articleUrl, resolvedUrl: article.resolvedUrl || null, headline: article.title, publishedAt: article.publishedAt
            });
        }

        // Image backfill runs independently of which article is
        // "current" below. Google News RSS items almost never carry a
        // photo (extractImageFromRssItem has nothing to find in their
        // feed), so gating this behind "is this article the newest"
        // meant a newer Google News corroboration permanently blocked
        // an older direct-feed article's real image from ever reaching
        // the event — even though that image was sitting right there
        // in the same event's source list. Now: always take an image
        // if the event doesn't have one yet, and let a newer article
        // that DOES have one replace an older image.
        if (article.imageUrl && (!event.imageUrl || article.publishedAt >= event.lastUpdatedAt)) {
            event.imageUrl = article.imageUrl;
        }

        // A newer article always wins on "current" fields — that's what
        // keeps the event reflecting the LATEST information (e.g. a
        // restoration notice replacing an outage's status) rather than
        // whichever source happened to be first.
        if (article.publishedAt >= event.lastUpdatedAt) {
            event.lastUpdatedAt = article.publishedAt;
            event.headline = article.title;
            event.summary = article.summary || event.summary;
            event.category = category;
            event.eventType = label;
            if (startTimeText) event.startTimeText = startTimeText;
            if (endTimeText) event.endTimeText = endTimeText;
            event.titleTokens = titleTokens(article.title);
            if (category === 'restoration') event.status = 'resolved';
        }

        // Locations only ever grow (a later article naming an ADDITIONAL
        // affected area is new information, not a correction).
        for (const loc of mentionedLocations) {
            if (!event.affectedLocations.includes(loc)) event.affectedLocations.push(loc);
        }
        if (nationwide) event.isNationwide = true;

        event.confidenceScore = computeConfidence(event);
        event.history.push({
            at: article.publishedAt,
            note: statusChanged
                ? `${article.sourceName} reported an update: now "${label}"`
                : `${article.sourceName} corroborated this event`
        });

        await event.save();
        article.eventId = event._id;
        await article.save();
        await notifyForEvent(event, combinedText);
        return event;
    }

    // ---- Store raw article (relevance filter + exact-dup guard) ------
    // `opts.skipRelevanceFilter` is used only by the admin manual-publish
    // route — an admin curating a story has already made that call.
    async function storeArticle(raw, source, opts = {}) {
        const title = humanizeSlugTitle(String(raw.title || '').trim());
        const articleUrl = raw.url;
        if (!title || !articleUrl) return null;

        const summary = stripHtml(raw.summary || '').slice(0, 500) || title;
        const combinedText = `${title} ${summary}`;
        const dedupeKey = titleDedupeKey(title);

        // A story an admin explicitly deleted stays deleted, even if the
        // source (Google News especially) keeps serving it on later
        // fetch cycles — see the NewsBlocklist comment above. Checked by
        // both articleUrl (this exact link) and dedupeKey (same headline
        // from a different outlet/URL), before any other work happens.
        const blocked = await NewsBlocklist.findOne({ $or: [{ articleUrl }, { dedupeKey }] }).select('_id').lean();
        if (blocked) return opts.throwOnDuplicate ? 'duplicate' : null;

        // Moved up (used to run after the relevance check below) so the
        // Google News Ghana-gate can use mentionedLocations too, e.g. a
        // story that names a subscriber's city but never says "Ghana"
        // out loud still counts as relevant.
        const knownKeys = opts.knownKeys || await getKnownLocationKeys();
        const mentionedLocations = findMentionedLocations(combinedText, knownKeys);

        if (!opts.skipRelevanceFilter) {
            if (!isRelevantArticle(combinedText)) return null;
            // Extra gate for Google News search results only — see
            // isGhanaRelevant() above for why direct feeds don't need it.
            if (opts.isGoogleNews && !isGhanaRelevant(combinedText, mentionedLocations)) {
                console.log(`[news] Dropped non-Ghana Google News result: "${title}"`);
                return null;
            }
        }

        // Only reject on an EXACT url repeat now — near-duplicate
        // titles from a different outlet are exactly what the event
        // layer below wants to see (extra corroboration), so they're
        // no longer dropped/replaced here the way the old version of
        // this file did.
        const existing = await NewsArticle.findOne({ articleUrl }).select('_id imageUrl resolvedUrl eventId').lean();
        if (existing) {
            // Self-heal: articles stored before the media:content/
            // media:thumbnail extraction fix (see extractImageFromRssItem)
            // are sitting in the DB with imageUrl: null forever, since a
            // repeat fetch of the same URL stops right here without ever
            // looking at raw.imageUrl again. If this cycle's fetch of the
            // same URL DOES carry an image now, patch it into the stored
            // article, and into its event too if that event still has no
            // image of its own. Nothing else about the existing row changes.
            //
            // Also clears out the Google "G News" logo that scrapeOgImage
            // could briefly return for redirect links that never actually
            // left news.google.com (fixed above, but rows saved during that
            // window need cleaning up here rather than staying stuck on it
            // forever) — an existing bad-domain image is treated the same
            // as no image at all for the purposes of this heal.
            const isBadImage = (u) => {
                if (!u) return true;
                try { return /(^|\.)google\.com$|(^|\.)gstatic\.com$|(^|\.)googleusercontent\.com$/i.test(new URL(u).hostname); }
                catch (_) { return false; }
            };
            if (raw.imageUrl && isBadImage(existing.imageUrl)) {
                await NewsArticle.updateOne({ _id: existing._id }, { $set: { imageUrl: raw.imageUrl } });
                if (existing.eventId) {
                    await NewsEvent.updateOne(
                        { _id: existing.eventId, $or: [{ imageUrl: null }, { imageUrl: { $exists: false } }, { imageUrl: { $regex: /google\.com|gstatic\.com|googleusercontent\.com/i } }] },
                        { $set: { imageUrl: raw.imageUrl } }
                    );
                }
            } else if (isBadImage(existing.imageUrl) && existing.imageUrl) {
                // No fresh replacement available this cycle, but the stored
                // value is still the bad logo — clear it so the frontend
                // just shows no image (graceful) instead of the ugly one.
                await NewsArticle.updateOne({ _id: existing._id }, { $set: { imageUrl: null } });
                if (existing.eventId) {
                    await NewsEvent.updateOne(
                        { _id: existing.eventId, imageUrl: { $regex: /google\.com|gstatic\.com|googleusercontent\.com/i } },
                        { $set: { imageUrl: null } }
                    );
                }
            }
            // Same idea for resolvedUrl — only ever fills a blank, never
            // overwrites a real one, and pushes into the event's sources
            // entry too so the favicon fixes itself without needing the
            // image backfill routes to also run.
            if (raw.resolvedUrl && !existing.resolvedUrl) {
                await NewsArticle.updateOne({ _id: existing._id }, { $set: { resolvedUrl: raw.resolvedUrl } });
                if (existing.eventId) {
                    await NewsEvent.updateOne(
                        { _id: existing.eventId, 'sources.url': articleUrl },
                        { $set: { 'sources.$.resolvedUrl': raw.resolvedUrl } }
                    );
                }
            }
            return opts.throwOnDuplicate ? 'duplicate' : null;
        }

        const category = raw.category || detectCategory(combinedText);
        const nationwide = isNationwideArticle(combinedText, category);

        let doc;
        try {
            doc = await NewsArticle.create({
                title,
                summary,
                imageUrl: raw.imageUrl || null,
                resolvedUrl: raw.resolvedUrl || null,
                sourceName: source.name,
                sourceIcon: source.icon,
                isOfficial: !!source.official,
                category,
                articleUrl,
                dedupeKey,
                publishedAt: raw.publishedAt instanceof Date && !isNaN(raw.publishedAt) ? raw.publishedAt : new Date(),
                mentionedLocations,
                isNationwide: nationwide,
                isAdminPosted: !!opts.skipRelevanceFilter
            });
        } catch (err) {
            if (err.code === 11000) return opts.throwOnDuplicate ? 'duplicate' : null;
            throw err;
        }

        try {
            await attachArticleToEvent(doc, combinedText, category, mentionedLocations, nationwide);
        } catch (err) {
            // Never let event-clustering failures lose the raw article —
            // it's already safely stored above either way.
            console.error('[news] Event clustering error:', err.message);
        }

        return doc;
    }

    // ---- Fetchers -----------------------------------------------
    // Staged XML→items parsing, shared by fetchRssSource (plain fetch)
    // and the headless-browser ECG blog fetch below — same three-stage
    // repair escalation either way, just fed by a different transport.
    // Throws if every stage (including the regex fallback) comes up
    // empty; callers decide how to report that.
    async function parseFeedXmlStaged(rawXml, sourceLabel) {
        // Entity-escaping only — pure and safe, always applied.
        const escaped = sanitizeFeedXml(rawXml);

        let feed = null;
        let lastParseErr = null;

        // Stage 1 — raw (entity-escaped) XML, no structural repair.
        try {
            feed = await rssParser.parseString(escaped);
        } catch (err) {
            lastParseErr = err;
        }

        // Stage 2 — bare/unquoted-attribute normalization only.
        if (!feed) {
            try {
                feed = await rssParser.parseString(normalizeXmlAttributesDocumentWide(escaped));
            } catch (err) {
                lastParseErr = err;
            }
        }

        // Stage 3 — last resort: crossed/unclosed-tag balancer on top
        // of the attribute fix. Only reached once stages 1–2 both fail.
        if (!feed) {
            try {
                const attrFixed = normalizeXmlAttributesDocumentWide(escaped);
                feed = await rssParser.parseString(balanceCrossedTagsDocumentWide(attrFixed));
            } catch (err) {
                lastParseErr = err;
            }
        }

        if (feed) return feed.items || [];

        // Every parse stage failed — try the dumb regex fallback rather
        // than losing this source's items outright.
        const items = extractItemsWithRegex(rawXml);
        if (items.length) {
            console.warn(`[news] ${sourceLabel}: rss-parser rejected the feed (${lastParseErr && lastParseErr.message}) — recovered ${items.length} item(s) via regex fallback instead.`);
            return items;
        }
        throw lastParseErr || new Error('Unable to parse feed'); // fallback found nothing either — let the caller report the real error
    }

    async function fetchRssSource(source, knownKeys) {
        let items = [];
        try {
            // 15s bound — RSS/XML feeds are small and should respond fast.
            // Without this, an unresponsive/slow host leaves this await
            // hanging for undici's default timeout (well over a minute),
            // and since fetch()'s DNS resolution shares Node's small
            // (4-slot) libuv threadpool with zlib — the same pool
            // compression() uses on every JSON response this backend
            // sends — one hung source here was enough to stall completely
            // unrelated API responses (e.g. GET /news reads) for minutes,
            // not just delay this fetch cycle.
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 15000);
            let res;
            try {
                res = await fetch(source.url, {
                    signal: controller.signal,
                    headers: OUTBOUND_HEADERS
                });
            } finally {
                clearTimeout(timeout);
            }
            if (!res.ok) {
                const serverHeader = res.headers.get('server') || 'unknown';
                let snippet = '';
                try { snippet = (await res.text()).slice(0, 200).replace(/\s+/g, ' ').trim(); } catch {}
                throw new Error(`HTTP ${res.status} (server: ${serverHeader})${snippet ? ` — body: "${snippet}"` : ''}`);
            }
            const rawXml = await res.text();
            // A 200 with an HTML body instead of XML (GhanaWeb's current
            // failure mode: "Feed not recognized as RSS 1 or 2") is almost
            // always a bot-challenge/redirect page, not a malformed feed —
            // no amount of the XML repair below fixes that, so surface it
            // as what it actually is instead of a confusing parse error.
            // NOT an attempt to get past whatever's serving it; this repo's
            // only bypass mechanism (the headless browser) stays scoped to
            // ECG, same as before.
            if (/^\s*<!doctype html/i.test(rawXml) || /^\s*<html[\s>]/i.test(rawXml)) {
                const snippet = rawXml.slice(0, 200).replace(/\s+/g, ' ').trim();
                throw new Error(`Response was an HTML page, not an XML feed — likely bot-gated (would need the same kind of headless-browser fetch as ECG, not addressed here). First 200 chars: "${snippet}"`);
            }
            items = await parseFeedXmlStaged(rawXml, source.name);
        } catch (err) {
            console.error(`[news] RSS fetch FAILED for ${source.name} (${source.url}): ${err.message}`);
            return { fetched: 0, stored: 0 };
        }

        let stored = 0;
        for (const item of items.slice(0, 25)) {
            let title = item.title;
            let sourceForItem = source;
            if (source.type === 'google-news') {
                const parsed = parseGoogleNewsItem(item);
                title = parsed.headline;
                // Credit the real outlet Google surfaced, not "Google News"
                // itself — keeps sourceList/isOfficial meaningful downstream.
                sourceForItem = { name: parsed.outlet, icon: '📰', official: false };
            }
            let imageUrl = extractImageFromRssItem(item);
            let resolvedUrl = null;
            if (!imageUrl && source.type === 'google-news') {
                const debugInfo = {};
                imageUrl = await scrapeOgImage(item.link, debugInfo);
                resolvedUrl = debugInfo.resolvedUrl || null;
            }
            const doc = await storeArticle({
                title,
                summary: item.contentSnippet || item.content || item.summary || '',
                url: item.link,
                imageUrl,
                resolvedUrl,
                publishedAt: item.isoDate ? new Date(item.isoDate) : new Date()
            }, sourceForItem, { knownKeys, isGoogleNews: source.type === 'google-news' });
            if (doc) stored++;
        }

        console.log(`[news] ${source.name}${source.query ? ` (${source.query})` : ''}: fetched ${items.length} item(s), stored ${stored} new.`);
        return { fetched: items.length, stored };
    }

    // ---------------------------------------------------------------
    //  Headless browser (Playwright) — ECG only
    // ---------------------------------------------------------------
    //  ECG's site (Incapsula captcha redirect) and blog feed (same
    //  class of bot-challenge, now serving "Feed not recognized as
    //  RSS 1 or 2" instead of real XML) both need actual JS execution
    //  to get past — a plain fetch() with browser-like headers can't
    //  do that, which is the whole reason this exists. NOT used for
    //  anything else in NEWS_SOURCES; every other source still uses
    //  the plain fetch() path above.
    //
    //  REQUIRES a real install step this file can't do on its own:
    //      npm install playwright
    //      npx playwright install --with-deps chromium
    //  On Render specifically, the second command needs to run as
    //  part of the BUILD command (e.g. in render.yaml or the dashboard
    //  build command), not just added to package.json — the Chromium
    //  binary is downloaded separately from the npm package and isn't
    //  there yet on a fresh deploy without it. Skipping this step is
    //  the single most common reason this "silently doesn't work" —
    //  see the require() guard and /admin/news/headless-status below,
    //  both of which exist specifically to make that failure visible
    //  instead of silent.
    let chromiumLauncher = null;
    try {
        chromiumLauncher = require('playwright').chromium;
    } catch (err) {
        console.warn('[news] [headless] "playwright" is not installed (or its browsers aren\'t) — ECG headless fetch will be skipped every cycle until it is. Run: npm install playwright && npx playwright install --with-deps chromium');
    }

    // One browser process is kept alive across fetch cycles rather than
    // launched fresh every 7 minutes — Chromium's startup cost (several
    // hundred ms to a few seconds) isn't worth paying twice a cycle just
    // to hit two ECG URLs. A fresh BrowserContext (and page) is still
    // opened and closed per use below, so no cookies/state leak between
    // cycles or between ECG's two sources.
    let sharedBrowser = null;
    async function getSharedBrowser() {
        if (!chromiumLauncher) return null;
        if (sharedBrowser && sharedBrowser.isConnected()) return sharedBrowser;
        try {
            console.log('[news] [headless] Launching Chromium...');
            sharedBrowser = await chromiumLauncher.launch({
                headless: true,
                // Required in most container hosts (Render included) —
                // Chromium's sandbox needs kernel privileges a container
                // doesn't grant by default; without these flags launch()
                // itself throws before a page is ever opened.
                args: ['--no-sandbox', '--disable-setuid-sandbox']
            });
            console.log('[news] [headless] Chromium launched OK.');
            sharedBrowser.on('disconnected', () => {
                console.warn('[news] [headless] Chromium disconnected — will relaunch next time it\'s needed.');
                sharedBrowser = null;
            });
        } catch (err) {
            console.error(`[news] [headless] Chromium launch FAILED: ${err.message} — most likely the Chromium binary itself isn't installed (see the npx playwright install command in the comment above this function).`);
            sharedBrowser = null;
        }
        return sharedBrowser;
    }

    // Renders `url` in a real browser and returns the final HTML plus
    // the final URL actually landed on (so callers can tell whether
    // they got redirected to a captcha/challenge page instead of the
    // real content — Incapsula's redirect target, e.g., still contains
    // "sgcaptcha" in the URL even after the JS challenge itself runs).
    // Returns null (never throws) on any failure — a page failing to
    // render is treated exactly like an HTTP error from fetch(): log
    // it, return nothing, let the caller report fetched:0 this cycle.
    //
    // extraWaitOnChallengeMs: if still on a challenge page after `waitMs`,
    // wait this much longer once before giving up, rather than reading
    // the challenge stub as the page. 0 (default) preserves the original
    // single-wait behavior. ECG's news-events scrape resolves fine with
    // just `waitMs`, but its blog feed (/blog/feed/) has been observed
    // still sitting on the sgcaptcha redirect after the same wait — that
    // endpoint's challenge appears to need more time to self-resolve, so
    // fetchRssViaHeadless (below) opts into the longer second wait;
    // this stays 0 (unchanged) for every other caller.
    // acceptHeader: lets a caller ask for XML instead of the default
    // browser Accept (text/html,...) that Playwright sends on real page
    // navigation. Citi News' CDN was found to redirect /feed/ to the
    // site's homepage specifically when it sees an HTML-navigation
    // Accept header — same signal a real browser tab sends, different
    // from what a feed reader sends (see OUTBOUND_HEADERS' Accept, used
    // by the plain fetch() path). Passing that same value here through
    // fetchRssViaHeadless below asks their edge for the feed, not a
    // browser page, while still executing JS so the bot-challenge itself
    // can resolve. Left undefined (unchanged) for every other caller —
    // ECG's site scrape wants a real HTML page, not XML.
    async function fetchRenderedHtml(url, { waitMs = 4000, timeoutMs = 20000, extraWaitOnChallengeMs = 0, acceptHeader = null } = {}) {
        const browser = await getSharedBrowser();
        if (!browser) return null;

        let context;
        try {
            const extraHTTPHeaders = { 'Accept-Language': OUTBOUND_HEADERS['Accept-Language'] };
            if (acceptHeader) extraHTTPHeaders['Accept'] = acceptHeader;
            context = await browser.newContext({
                userAgent: OUTBOUND_HEADERS['User-Agent'],
                extraHTTPHeaders
            });
            const page = await context.newPage();
            console.log(`[news] [headless] Navigating to ${url} ...`);
            await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
            // Incapsula/Cloudflare-style JS challenges resolve client-side
            // and self-redirect once they pass — give that a moment to
            // finish rather than reading the challenge stub as the page.
            await page.waitForTimeout(waitMs);
            let finalUrl = page.url();
            let html = await page.content();
            let stillChallenged = /sgcaptcha|cf-challenge|Just a moment/i.test(html) || /sgcaptcha/i.test(finalUrl);

            if (stillChallenged && extraWaitOnChallengeMs > 0) {
                console.log(`[news] [headless] Still on a challenge page after ${waitMs}ms — waiting ${extraWaitOnChallengeMs}ms more before giving up...`);
                await page.waitForTimeout(extraWaitOnChallengeMs);
                finalUrl = page.url();
                html = await page.content();
                stillChallenged = /sgcaptcha|cf-challenge|Just a moment/i.test(html) || /sgcaptcha/i.test(finalUrl);
            }

            console.log(`[news] [headless] Landed on ${finalUrl} (${html.length} bytes rendered)${stillChallenged ? ' — still looks like a challenge/captcha page' : ''}.`);
            return { html, finalUrl, stillChallenged };
        } catch (err) {
            console.error(`[news] [headless] Render FAILED for ${url}: ${err.message}`);
            return null;
        } finally {
            if (context) await context.close().catch(() => {});
        }
    }

    // Fetches an RSS feed through the headless browser instead of plain
    // fetch() so a bot-challenge (Incapsula/Cloudflare-style JS
    // interstitial) gets a chance to resolve before the response is
    // read. Originally written for ECG's blog feed specifically, but
    // nothing in here is ECG-specific — it just renders `source.url` and
    // feeds whatever comes back into the same staged XML repair/parse
    // pipeline every other RSS source uses (parseFeedXmlStaged). Reused
    // below for any source whose plain fetch() is bot-gated (see
    // 'rss-headless' type in NEWS_SOURCES) — currently Citi News and
    // GhanaWeb, both of which serve an HTML challenge page instead of
    // real XML to a plain fetch() (confirmed via the "Response was an
    // HTML page, not an XML feed" error fetchRssSource logs for them).
    async function fetchRssViaHeadless(source, knownKeys) {
        let items = [];
        try {
            const rendered = await fetchRenderedHtml(source.url, {
                extraWaitOnChallengeMs: 8000,
                acceptHeader: OUTBOUND_HEADERS['Accept']
            });
            if (!rendered) throw new Error('Headless browser unavailable or render failed — see [headless] logs above.');
            if (rendered.stillChallenged) throw new Error(`Still on a challenge/captcha page after render (landed on ${rendered.finalUrl}).`);

            // A rendered XML document usually lands inside the browser's
            // built-in XML viewer, which Chromium wraps in its own HTML
            // shell — pull the raw text back out rather than trying to
            // parse that shell as if it were the feed itself.
            const $ = cheerio.load(rendered.html);
            const rawXml = ($('pre').first().text() || rendered.html).trim();

            // Some sites' edge/WAF (Citi News confirmed) redirects the
            // feed URL to an unrelated page — the homepage, not a
            // challenge — once it decides the request came from a real
            // browser rather than a feed reader, regardless of Accept
            // header. That's not a bot-challenge (stillChallenged above
            // won't catch it) and it's not XML either, so feeding it into
            // parseFeedXmlStaged just produces a confusing raw XML-parser
            // stack trace ("Invalid character in tag name") instead of a
            // clear explanation. Catch both signals of that case up front:
            // landing somewhere other than the feed URL, or content that
            // plainly starts with an HTML document rather than XML.
            const finalPath = (() => { try { return new URL(rendered.finalUrl).pathname; } catch { return rendered.finalUrl; } })();
            const requestedPath = (() => { try { return new URL(source.url).pathname; } catch { return source.url; } })();
            const redirectedAway = finalPath !== requestedPath;
            const looksLikeHtml = /^\s*<!doctype html/i.test(rawXml) || /^\s*<html[\s>]/i.test(rawXml);
            if (redirectedAway || looksLikeHtml) {
                throw new Error(`Redirected away from the feed to a non-feed page instead of a bot-challenge (landed on ${rendered.finalUrl}) — the site is serving its homepage/HTML instead of XML to this request.`);
            }

            items = await parseFeedXmlStaged(rawXml, source.name);
        } catch (err) {
            console.error(`[news] RSS fetch FAILED for ${source.name} (${source.url}): ${err.message}`);
            return { fetched: 0, stored: 0 };
        }

        let stored = 0;
        for (const item of items.slice(0, 25)) {
            const imageUrl = extractImageFromRssItem(item);
            const doc = await storeArticle({
                title: item.title,
                summary: item.contentSnippet || item.content || item.summary || '',
                url: item.link,
                imageUrl,
                publishedAt: item.isoDate ? new Date(item.isoDate) : new Date()
            }, source, { knownKeys });
            if (doc) stored++;
        }

        console.log(`[news] ${source.name}: fetched ${items.length} item(s), stored ${stored} new.`);
        return { fetched: items.length, stored };
    }

    // ---------------------------------------------------------------
    //  ECG "News & Events" page parsing (structure-first, not class-first)
    // ---------------------------------------------------------------
    //  The old selector list below (`.blog .item, .items-leading,
    //  .item-page, .blog-item, article`) matched a Joomla template
    //  class layout ECG's site used to render with. The page still
    //  renders fine today (83KB, confirmed in the [headless] logs) —
    //  the classes just aren't there anymore, so `candidates` came back
    //  empty every cycle ("0 article blocks matched the selectors").
    //
    //  Rather than swap in a new hard-coded class list (which breaks
    //  again the next time ECG's Joomla template changes), this reads
    //  the page by STRUCTURE instead:
    //    1. Every <h1>-<h4> that wraps a link, outside the header/nav/
    //       footer/sidebar, is a candidate article title.
    //    2. A candidate only counts as a real article if a
    //       "DD Month YYYY" date (ECG's byline format on this page,
    //       e.g. "22 July 2026") turns up within a couple of DOM levels
    //       of it. That's present under every real article and absent
    //       under the sidebar's bare category links ("Eastern Region
    //       News" etc.) and the "Must Read" list, so it doubles as the
    //       filter that keeps those out — without needing to know their
    //       class names either.
    //    3. Once that wrapping element is found, the image and excerpt
    //       paragraph are pulled from inside it, same structure-first
    //       way.
    //  This survives markup/class churn as long as ECG keeps pairing
    //  each article with a heading + nearby date, which is a much safer
    //  bet than any specific class surviving the next template tweak.
    const ECG_MONTHS = {
        january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
        july: 6, august: 7, september: 8, october: 9, november: 10, december: 11
    };
    const ECG_DATE_REGEX = /\b(\d{1,2})\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})\b/i;

    function parseEcgDate(text) {
        const m = text && text.match(ECG_DATE_REGEX);
        if (!m) return null;
        const day = Number(m[1]);
        const month = ECG_MONTHS[m[2].toLowerCase()];
        const year = Number(m[3]);
        // Noon UTC rather than midnight local — sidesteps a date rolling
        // back a day if this process's TZ sits east of UTC.
        const d = new Date(Date.UTC(year, month, day, 12));
        return isNaN(d) ? null : d;
    }

    // How many ancestor levels to walk up from a heading looking for a
    // nearby date before giving up on it. Kept deliberately small: too
    // generous and a heading with NO date of its own (a sidebar category
    // link, say) could pick up some unrelated article's date from a
    // large shared ancestor instead of correctly being rejected.
    const ECG_META_HOP_LIMIT = 3;
    const ECG_NON_ARTICLE_ANCESTOR_SELECTOR = 'header, nav, footer, [class*="sidebar" i], [id*="sidebar" i], [class*="menu" i]';

    function extractEcgItemsByStructure($, baseUrl) {
        const items = [];
        const seenUrls = new Set();

        $('h1 a[href], h2 a[href], h3 a[href], h4 a[href]').each((_, el) => {
            const $link = $(el);
            const title = $link.text().trim();
            const href = $link.attr('href');
            if (!title || !href) return;

            const $heading = $link.closest('h1, h2, h3, h4');
            if ($heading.closest(ECG_NON_ARTICLE_ANCESTOR_SELECTOR).length) return;

            const articleUrl = resolveUrl(href, baseUrl);
            if (!articleUrl || seenUrls.has(articleUrl)) return;

            // Walk up looking for a nearby publish date — this is what
            // separates a real article teaser from a bare nav/sidebar/
            // category link that happens to use the same heading tag.
            let $scope = $heading.parent();
            let publishedAt = null;
            for (let hop = 0; hop < ECG_META_HOP_LIMIT && $scope.length; hop++) {
                publishedAt = parseEcgDate($scope.text());
                if (publishedAt) break;
                $scope = $scope.parent();
            }
            if (!publishedAt) return;

            seenUrls.add(articleUrl);

            const imgSrc = $scope.find('img').first().attr('src');
            const imageUrl = imgSrc ? resolveUrl(imgSrc, baseUrl) : null;

            let summary = '';
            $scope.find('p').each((_, p) => {
                const t = $(p).text().trim();
                if (t.length > 20) { summary = t; return false; }
            });

            items.push({ title, summary, url: articleUrl, imageUrl, publishedAt });
        });

        return items;
    }

    // Legacy class-based pass, kept as a fallback only — cheap safety
    // net in case ECG's template ever reintroduces one of these class
    // names, so that case still resolves on the first try instead of
    // relying solely on the structural heuristic above.
    function extractEcgItemsLegacy($, baseUrl) {
        const items = [];
        $('.blog .item, .items-leading, .item-page, .blog-item, article').each((_, el) => {
            const $el = $(el);
            const headingEl = $el.find('h2 a, h3 a, h2, h3').first();
            const title = headingEl.text().trim();
            let href = headingEl.is('a') ? headingEl.attr('href') : $el.find('a').first().attr('href');
            if (!title || !href) return;
            const articleUrl = resolveUrl(href, baseUrl);
            if (!articleUrl) return;
            const summary = $el.find('p').first().text().trim();
            const imgSrc = $el.find('img').first().attr('src');
            const imageUrl = imgSrc ? resolveUrl(imgSrc, baseUrl) : null;
            items.push({ title, summary, url: articleUrl, imageUrl, publishedAt: new Date() });
        });
        return items;
    }

    async function scrapeEcgSite(source, knownKeys) {
        let html;
        try {
            const rendered = await fetchRenderedHtml(source.url);
            if (!rendered) throw new Error('Headless browser unavailable or render failed — see [headless] logs above.');
            if (rendered.stillChallenged) throw new Error(`Still on a challenge/captcha page after render (landed on ${rendered.finalUrl}).`);
            html = rendered.html;
        } catch (err) {
            console.error(`[news] ECG site fetch FAILED (${source.url}): ${err.message}`);
            return { fetched: 0, stored: 0 };
        }

        let items = [];
        let usedLegacySelectors = false;
        try {
            const $ = cheerio.load(html);
            items = extractEcgItemsByStructure($, source.url);
            if (items.length === 0) {
                items = extractEcgItemsLegacy($, source.url);
                usedLegacySelectors = items.length > 0;
            }
        } catch (err) {
            // A parsing bug here (e.g. ECG's markup trips up cheerio in
            // some new way) should degrade to "0 articles this cycle",
            // never take down the rest of the news-fetch cycle.
            console.error(`[news] ECG: error while parsing page markup: ${err.message}`);
            items = [];
        }

        if (items.length === 0) {
            if (html.length < 2000) {
                console.warn(`[news] ECG: page fetched but only ${html.length} bytes back — likely still blocked/challenged even after headless render. Body: ${html.slice(0, 500)}`);
            } else {
                console.warn(`[news] ECG: page fetched (${html.length} bytes) but 0 article blocks matched the selectors (structural + legacy pass both came back empty).`);
            }
            return { fetched: 0, stored: 0 };
        }

        const seen = new Set();
        let stored = 0;
        for (const item of items) {
            if (seen.has(item.url)) continue;
            seen.add(item.url);
            const doc = await storeArticle({
                title: item.title,
                summary: item.summary || '',
                url: item.url,
                imageUrl: item.imageUrl || null,
                publishedAt: item.publishedAt || new Date()
            }, source, { knownKeys });
            if (doc) stored++;
        }

        console.log(`[news] ECG: found ${items.length} candidate item(s)${usedLegacySelectors ? ' [via legacy class selectors]' : ''}, stored ${stored} new.`);
        return { fetched: items.length, stored };
    }

    let lastFetchStats = null;

    // Guards against two cycles running at once. NEWS_FETCH_INTERVAL_MS
    // (below) is comfortably longer than a normal cycle takes today, but
    // this cycle sequentially awaits ~19 outbound HTTP fetches, each with
    // its own up-to-15s timeout — a bad run (several sources timing out
    // back to back) can realistically take longer than the interval. Without
    // this guard, the next setInterval tick would fire anyway and start a
    // second cycle on top of the first: two loops hitting the same outlets,
    // double the outbound requests in flight, and — worse — both cycles
    // writing to the same module-level `activeCycleQueue` used for
    // broadcast/notification batching, which is only safe with one cycle
    // active at a time. The admin "Refresh now" button (POST
    // /admin/news/refresh) shares this same guard so it can't stack a
    // second cycle on top of a scheduled one either.
    let cycleInFlight = null;

    async function runNewsFetchCycle() {
        if (cycleInFlight) {
            console.log('[news] Fetch cycle requested while one is already running — reusing it instead of starting a second.');
            return cycleInFlight;
        }
        cycleInFlight = runNewsFetchCycleInner().finally(() => { cycleInFlight = null; });
        return cycleInFlight;
    }

    async function runNewsFetchCycleInner() {
        console.log('[news] Fetch cycle starting...');
        const stats = { startedAt: new Date(), sources: {} };
        const knownKeys = await getKnownLocationKeys();

        const cycleQueue = { broadcasts: [], byLocation: new Map() };
        activeCycleQueue = cycleQueue;

        try {
            // ECG's own official channel is fetched first and in complete
            // isolation from the third-party outlet loop below — wrapped in
            // its own try/catch on top of fetchRssSource's/scrapeEcgSite's
            // existing internal handling, so nothing about ECG's fetch
            // (today's blog-feed/site-scrape attempts, or a future
            // headless-browser fetch) can ever stop NEWS_SOURCES from
            // being fetched this cycle.
            for (const source of ECG_SOURCES) {
                let result;
                try {
                    if (source.type === 'rss') result = await fetchRssViaHeadless(source, knownKeys);
                    else if (source.type === 'scrape-ecg') result = await scrapeEcgSite(source, knownKeys);
                } catch (err) {
                    console.error(`[news] ECG source "${source.name}" failed unexpectedly: ${err.message}`);
                    result = { fetched: 0, stored: 0 };
                }
                stats.sources[source.name] = result || { fetched: 0, stored: 0 };
            }

            for (const source of NEWS_SOURCES) {
                let result;
                if (source.type === 'rss' || source.type === 'google-news') result = await fetchRssSource(source, knownKeys);
                else if (source.type === 'rss-headless') result = await fetchRssViaHeadless(source, knownKeys);
                const label = source.query ? `${source.name} (${source.query})` : source.name;
                stats.sources[label] = result || { fetched: 0, stored: 0 };
            }
        } finally {
            activeCycleQueue = null; // stop queuing before flushing, so nothing sent here loops back into itself
            await flushCycleQueue(cycleQueue);
        }

        stats.finishedAt = new Date();
        lastFetchStats = stats;
        clearNewsCache();
        console.log('[news] Fetch cycle complete:', JSON.stringify(stats.sources));
    }

    // ---- Scheduler ------------------------------------------------
    // 5–10 min window as requested; default sits in the middle of it.
    // NOTE: this cycle now hits ~8 Google News queries plus ~11 direct
    // feeds every run — comfortably fine at this interval, but if more
    // queries/outlets get added later and outbound requests start
    // taking noticeably longer than the interval itself, raise this
    // rather than let cycles start overlapping.
    const NEWS_FETCH_INTERVAL_MS = Number(process.env.NEWS_FETCH_INTERVAL_MS) || 7 * 60 * 1000;
    const EVENT_MATCH_WINDOW_MS = Number(process.env.NEWS_EVENT_MATCH_WINDOW_MS) || 5 * 24 * 60 * 60 * 1000;

    const initialFetchTimer = setTimeout(() => { runNewsFetchCycle().catch(err => console.error('[news] Initial fetch failed:', err.message)); }, 10000);
    const scheduledFetchTimer = setInterval(() => { runNewsFetchCycle().catch(err => console.error('[news] Scheduled fetch failed:', err.message)); }, NEWS_FETCH_INTERVAL_MS);

    // Render (and most PaaS hosts) send SIGTERM to the OLD container
    // during a deploy, then give it a grace period before a hard kill —
    // Node keeps running through that grace period unless something
    // stops it. That's what produced the back-to-back "[news] Fetch
    // cycle starting..." pair seen in production: the dying old
    // container's own scheduler (its 7-min setInterval, or its 10s
    // startup setTimeout on a fast redeploy) fired during that window
    // at the same moment the brand-new container's own startup timer
    // fired — two SEPARATE processes hitting the same outlets at once.
    // The in-process cycleInFlight guard above can't help here since it
    // only stops a second cycle from starting inside the SAME process.
    // Once SIGTERM/SIGINT arrives, stop scheduling any further cycles
    // and let the shared Chromium instance close cleanly instead of
    // leaving it running into the kill.
    let newsShuttingDown = false;
    function stopNewsScheduling(signal) {
        if (newsShuttingDown) return;
        newsShuttingDown = true;
        console.log(`[news] ${signal} received — stopping the news scheduler (no further fetch cycles will start this process).`);
        clearTimeout(initialFetchTimer);
        clearInterval(scheduledFetchTimer);
        if (sharedBrowser) sharedBrowser.close().catch(() => {});
    }
    process.on('SIGTERM', () => stopNewsScheduling('SIGTERM'));
    process.on('SIGINT', () => stopNewsScheduling('SIGINT'));

    // ---- In-memory response cache ------------------------------------
    const NEWS_CACHE_TTL_MS = Number(process.env.NEWS_CACHE_TTL_MS) || 60 * 1000;
    const newsResponseCache = new Map();
    function clearNewsCache() { newsResponseCache.clear(); }

    // ---- Routes -----------------------------------------------------
    // GET /events — NEW. Full structured event view.
    app.get('/events', async (req, res) => {
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 30, 1), 100);
        const includeNationwide = ['1', 'true'].includes(String(req.query.includeNationwide || '').toLowerCase());
        const cacheKey = `EVT:${req.originalUrl}`;
        const cached = newsResponseCache.get(cacheKey);
        if (cached && cached.expiresAt > Date.now()) return res.json(cached.body);

        const andClauses = [];
        if (req.query.category) andClauses.push({ category: req.query.category });
        if (req.query.status) andClauses.push({ status: req.query.status });
        if (req.query.location) {
            const key = normalizeLocation(req.query.location).split(',')[0].trim();
            andClauses.push(
                includeNationwide
                    ? { $or: [{ affectedLocations: key }, { isNationwide: true }] }
                    : { affectedLocations: key }
            );
        } else if (includeNationwide) {
            andClauses.push({ isNationwide: true });
        }
        const query = andClauses.length ? { $and: andClauses } : {};

        try {
            const events = await NewsEvent.find(query).sort({ lastUpdatedAt: -1 }).limit(limit).lean();
            const body = events.map(e => {
                const officialSource = e.sources.find(s => s.official);
                const mainSource = officialSource || e.sources[e.sources.length - 1] || {};
                return {
                    id: e._id,
                    eventType: e.eventType,
                    headline: e.headline,
                    summary: e.summary,
                    // Left null when there's no real image — the frontend
                    // picks its own (varied, per-article) fallback graphic
                    // for that case. Baking '/images/graphic.png' in here
                    // used to make every image-less event load that exact
                    // file successfully, which meant the frontend's onerror-
                    // driven fallback logic never even ran for them.
                    image: e.imageUrl || null,
                    isNationwide: !!e.isNationwide,
                    startTime: e.startTimeText,
                    endTime: e.endTimeText,
                    firstPublishedAt: e.firstPublishedAt,
                    lastUpdatedAt: e.lastUpdatedAt,
                    timeAgo: formatTimeAgo(e.lastUpdatedAt),
                    firstPublishedTimeAgo: formatTimeAgo(e.firstPublishedAt),
                    status: e.status,
                    confidenceScore: e.confidenceScore,
                    sourceCount: new Set(e.sources.map(s => s.name)).size,
                    // Main source's real logo — this is span.news-item__source-icon.
                    sourceIcon: sourceLogoUrl(mainSource.resolvedUrl || mainSource.url) || null,
                    sourceName: mainSource.name || 'LightWatch',
                    sources: e.sources.map(s => ({
                        name: s.name, official: s.official, url: s.url, headline: s.headline,
                        publishedAt: s.publishedAt, timeAgo: formatTimeAgo(s.publishedAt),
                        logo: sourceLogoUrl(s.resolvedUrl || s.url)
                    })),
                    history: e.history
                };
            });
            newsResponseCache.set(cacheKey, { expiresAt: Date.now() + NEWS_CACHE_TTL_MS, body });
            return res.json(body);
        } catch (err) {
            console.error('Events fetch error:', err.message);
            return res.status(500).json({ error: 'Server error fetching events' });
        }
    });

    // GET /news — kept for the existing frontend. Same field names as
    // before, but each row is now an EVENT (sources merged) rather than
    // one raw article; `source`/`sourceIcon`/`isOfficial` reflect the
    // most-recently-updated source, with the full list also included
    // under `sources` for any client that wants to show them all.
    app.get('/news', async (req, res) => {
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 30, 1), 100);
        const includeNationwide = ['1', 'true'].includes(String(req.query.includeNationwide || '').toLowerCase());
        const cacheKey = req.originalUrl;
        const cached = newsResponseCache.get(cacheKey);
        if (cached && cached.expiresAt > Date.now()) return res.json(cached.body);

        const andClauses = [];
        if (req.query.category) andClauses.push({ category: req.query.category });
        if (req.query.official === 'true') andClauses.push({ 'sources.official': true });
        if (req.query.before) {
            const beforeDate = new Date(req.query.before);
            if (!isNaN(beforeDate)) andClauses.push({ lastUpdatedAt: { $lt: beforeDate } });
        }
        if (req.query.location) {
            const key = normalizeLocation(req.query.location).split(',')[0].trim();
            andClauses.push(
                includeNationwide
                    ? { $or: [{ affectedLocations: key }, { isNationwide: true }] }
                    : { affectedLocations: key }
            );
        } else if (includeNationwide) {
            andClauses.push({ isNationwide: true });
        }
        const query = andClauses.length ? { $and: andClauses } : {};

        try {
            // Sort strictly by recency. isNationwide used to sort ahead of
            // lastUpdatedAt here, which meant any event ever flagged
            // nationwide (any "dumsor"-keyword story — see
            // shouldBroadcastToAll) would permanently outrank newer,
            // non-nationwide events for as long as it stayed alive (up to
            // the retention TTL, refreshed further by every corroborating
            // source). Once 30+ such events piled up, brand-new local
            // articles could never crack the top `limit` results at all —
            // they'd get fetched, stored, clustered, and even trigger a
            // push notification (that path doesn't touch this query), but
            // never actually reach the frontend feed. isNationwide is still
            // returned in the response body below for the UI to badge —
            // it just no longer overrides recency in the ordering/limit.
            const events = await NewsEvent.find(query)
                .sort({ lastUpdatedAt: -1 })
                .limit(limit)
                .lean();

            const body = events.map(e => {
                const latestSource = e.sources[e.sources.length - 1] || {};
                const officialSource = e.sources.find(s => s.official);
                const mainSource = officialSource || latestSource;
                return {
                    id: e._id,
                    title: e.headline,
                    summary: e.summary,
                    // Left null when there's no real image — see the same
                    // note on GET /events above. The frontend now assigns
                    // its own varied fallback graphic per article; baking
                    // a real, always-loadable graphic.png URL in here
                    // short-circuited that for every image-less event.
                    image: e.imageUrl || null,
                    source: mainSource.name || 'LightWatch',
                    // Real fetched logo for the main source (span.news-item__source-icon),
                    // not the old static emoji. iconEmoji kept alongside for
                    // any UI that still wants a text/emoji fallback.
                    sourceIcon: sourceLogoUrl(mainSource.resolvedUrl || mainSource.url) || null,
                    iconEmoji: mainSource.icon || '📰',
                    isOfficial: !!officialSource,
                    category: e.category,
                    publishedAt: e.lastUpdatedAt,
                    // What span.news-item__time should show.
                    timeAgo: formatTimeAgo(e.lastUpdatedAt),
                    url: mainSource.url,
                    locations: e.affectedLocations,
                    isNationwide: !!e.isNationwide,
                    isAdminPosted: false,
                    // New, additive fields — safe for the current frontend
                    // to ignore until it's updated to show them.
                    eventType: e.eventType,
                    sourceCount: new Set(e.sources.map(s => s.name)).size,
                    sources: e.sources.map(s => ({ ...s, logo: sourceLogoUrl(s.resolvedUrl || s.url), timeAgo: formatTimeAgo(s.publishedAt) })),
                    confidenceScore: e.confidenceScore,
                    status: e.status
                };
            });

            newsResponseCache.set(cacheKey, { expiresAt: Date.now() + NEWS_CACHE_TTL_MS, body });
            return res.json(body);
        } catch (err) {
            console.error('News fetch error:', err.message);
            return res.status(500).json({ error: 'Server error fetching news' });
        }
    });

    // ---- Admin routes (unchanged behavior — still operate on the raw
    // NewsArticle collection) ------------------------------------------
    app.post('/admin/news/refresh', verifyAdminToken, async (req, res) => {
        try {
            await runNewsFetchCycle();
            const totalArticles = await NewsArticle.countDocuments();
            const totalEvents = await NewsEvent.countDocuments();
            return res.json({ success: true, totalArticles, totalEvents, lastFetchStats });
        } catch (err) {
            console.error('Admin news refresh error:', err.message);
            return res.status(500).json({ error: 'Server error refreshing news' });
        }
    });

    app.get('/admin/news/status', verifyAdminToken, async (req, res) => {
        const totalArticles = await NewsArticle.countDocuments();
        const totalEvents = await NewsEvent.countDocuments();
        return res.json({
            totalArticles, totalEvents, lastFetchStats,
            sources: [...ECG_SOURCES, ...NEWS_SOURCES].map(s => ({ name: s.name, url: s.url, type: s.type, query: s.query }))
        });
    });

    // GET /admin/news/headless-status — NEW. Answers "is the headless
    // browser even working" directly, independent of the news fetch
    // cycle and independent of whether ECG's own bot-challenge happens
    // to let it through today. Three things are checked and reported
    // separately, since they fail for different reasons and each needs
    // a different fix:
    //   1. playwrightInstalled — false means `npm install playwright`
    //      never ran (or failed) at build time.
    //   2. chromiumLaunched — false (with playwrightInstalled true)
    //      means the package is there but the Chromium BINARY isn't —
    //      `npx playwright install --with-deps chromium` never ran, or
    //      ran somewhere other than this deploy's build step.
    //   3. testNavigation — actually renders a known-good, non-ECG page
    //      (example.com) to confirm the browser can load and return
    //      real content, not just launch. If this passes but ECG itself
    //      still fails in the fetch cycle logs, the browser is fine and
    //      the problem is specifically ECG's challenge, not this setup.
    app.get('/admin/news/headless-status', verifyAdminToken, async (req, res) => {
        const result = {
            playwrightInstalled: !!chromiumLauncher,
            chromiumLaunched: false,
            testNavigation: null
        };

        if (!chromiumLauncher) {
            return res.json(result);
        }

        const browser = await getSharedBrowser();
        result.chromiumLaunched = !!browser;
        if (!browser) return res.json(result);

        const rendered = await fetchRenderedHtml('https://example.com', { waitMs: 500, timeoutMs: 10000 });
        result.testNavigation = rendered
            ? { ok: true, finalUrl: rendered.finalUrl, bytes: rendered.html.length }
            : { ok: false };

        return res.json(result);
    });

    // POST /admin/news/backfill-images — ONE-OFF. Repairs events that
    // were merged before the imageUrl-gating bug above was fixed: for
    // every event still missing an image, look at the raw NewsArticle
    // docs already folded into it (via eventId) and pull an image from
    // whichever one has it — preferring the most recently published
    // article that actually has one, same preference order the merge
    // logic uses going forward. No re-fetching, no data reset; this
    // only reads articles already sitting in the DB. Safe to call more
    // than once — events that still have no image anywhere in their
    // source articles are simply left as null and skipped.
    //
    // Also does an immediate cleanup pass for the Google "G News" logo
    // that scrapeOgImage could briefly return for redirect links that
    // never left news.google.com (see the domain guard added there) —
    // rows saved with that logo URL before the guard existed would
    // otherwise only get fixed whenever their article URL happens to
    // come through a future fetch cycle, which could be days away.
    // Cleared straight to null here instead (frontend already handles a
    // missing image gracefully), then the normal candidate-search below
    // gets a chance to fill in a real one from another source article.
    const GOOGLE_LOGO_IMAGE_REGEX = /google\.com|gstatic\.com|googleusercontent\.com/i;
    app.post('/admin/news/backfill-images', verifyAdminToken, async (req, res) => {
        try {
            const [articleCleanup, eventCleanup] = await Promise.all([
                NewsArticle.updateMany(
                    { imageUrl: { $regex: GOOGLE_LOGO_IMAGE_REGEX } },
                    { $set: { imageUrl: null } }
                ),
                NewsEvent.updateMany(
                    { imageUrl: { $regex: GOOGLE_LOGO_IMAGE_REGEX } },
                    { $set: { imageUrl: null } }
                )
            ]);

            const events = await NewsEvent.find({
                $or: [{ imageUrl: null }, { imageUrl: { $exists: false } }]
            }).select('_id');

            let updated = 0;
            let stillMissing = 0;

            for (const { _id } of events) {
                // Filtered in JS rather than via a $not/$regex combo in the
                // query itself (that combination behaves inconsistently
                // across MongoDB/Mongoose versions) — this event's article
                // set is small, so pulling a few candidates and picking the
                // first clean one is simpler and more reliable.
                const candidates = await NewsArticle.find({ eventId: _id, imageUrl: { $ne: null } })
                    .sort({ publishedAt: -1 })
                    .select('imageUrl')
                    .lean();
                const candidate = candidates.find(c => c.imageUrl && !GOOGLE_LOGO_IMAGE_REGEX.test(c.imageUrl));

                if (candidate) {
                    await NewsEvent.updateOne({ _id }, { $set: { imageUrl: candidate.imageUrl } });
                    updated++;
                } else {
                    stillMissing++;
                }
            }

            clearNewsCache();
            return res.json({
                success: true,
                badLogoImagesCleared: { articles: articleCleanup.modifiedCount, events: eventCleanup.modifiedCount },
                eventsChecked: events.length, updated, stillMissing
            });
        } catch (err) {
            console.error('Admin image backfill error:', err.message);
            return res.status(500).json({ error: 'Server error backfilling images' });
        }
    });

    // POST /admin/news/backfill-images-live?limit=10 — separate from the
    // route above on purpose. That one only reads what's already in the
    // DB; this one actually goes out and fetches pages, using the exact
    // same scrapeOgImage() the live fetch cycle already relies on (same
    // domain guards, same 6s timeout, same "quiet failure" behavior) — so
    // nothing new or untested is happening here, just applied to old
    // events on demand instead of waiting for their URL to resurface.
    //
    // Deliberately batched (default 10, capped at 25 per call) rather
    // than doing all image-less events in one request: each event can
    // need several outbound fetches (one per candidate source article,
    // until one yields a real image), and a single request looping over
    // dozens of events with 6s-timeout fetches each could run long enough
    // to hit a platform request timeout and get killed mid-write. Call it
    // repeatedly — already-fixed events won't be picked up again since
    // the query only ever selects imageUrl: null.
    app.post('/admin/news/backfill-images-live', verifyAdminToken, async (req, res) => {
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 10, 1), 25);
        try {
            const events = await NewsEvent.find({
                $or: [{ imageUrl: null }, { imageUrl: { $exists: false } }]
            }).select('_id').limit(limit).lean();

            let updated = 0;
            let stillMissing = 0;
            const errors = [];

            for (const { _id } of events) {
                try {
                    // Newest source article first — most likely to still
                    // be reachable, and most representative of the story.
                    const articles = await NewsArticle.find({ eventId: _id, articleUrl: { $ne: null } })
                        .sort({ publishedAt: -1 })
                        .select('_id articleUrl imageUrl')
                        .lean();

                    if (articles.length === 0) {
                        stillMissing++;
                        errors.push({ eventId: String(_id), note: 'no NewsArticle rows reference this eventId' });
                        continue;
                    }

                    let found = null;
                    const attempts = [];
                    for (const article of articles) {
                        // Skip anything already known bad; don't re-scrape it.
                        if (article.imageUrl && !GOOGLE_LOGO_IMAGE_REGEX.test(article.imageUrl)) {
                            found = article.imageUrl;
                            break;
                        }
                        const debugInfo = {};
                        const scraped = await scrapeOgImage(article.articleUrl, debugInfo);
                        attempts.push({ articleUrl: article.articleUrl, ...debugInfo });
                        if (scraped) {
                            await NewsArticle.updateOne({ _id: article._id }, { $set: { imageUrl: scraped } });
                            found = scraped;
                            break;
                        }
                    }

                    if (found) {
                        await NewsEvent.updateOne({ _id }, { $set: { imageUrl: found } });
                        updated++;
                    } else {
                        stillMissing++;
                        if (attempts.length) errors.push({ eventId: String(_id), attempts });
                    }
                } catch (innerErr) {
                    // One event failing (bad URL, network hiccup, etc.)
                    // must never abort the whole batch.
                    stillMissing++;
                    errors.push({ eventId: String(_id), error: innerErr.message });
                }
            }

            clearNewsCache();
            return res.json({
                success: true,
                eventsChecked: events.length,
                updated,
                stillMissing,
                remaining: await NewsEvent.countDocuments({ $or: [{ imageUrl: null }, { imageUrl: { $exists: false } }] }),
                errors: errors.length ? errors : undefined
            });
        } catch (err) {
            console.error('Admin live image backfill error:', err.message);
            return res.status(500).json({ error: 'Server error backfilling images' });
        }
    });

    app.post('/admin/news', verifyAdminToken, async (req, res) => {
        const { title, summary, url, image, category, sourceName, isOfficial, publishedAt } = req.body || {};

        if (!title || !String(title).trim()) {
            return res.status(400).json({ error: 'Title is required' });
        }
        if (!url || !String(url).trim()) {
            return res.status(400).json({ error: 'A link is required — the article\'s own URL, or the link to the tweet/post you\'re sharing' });
        }
        const ALLOWED_CATEGORIES = ['maintenance', 'outage', 'tariff', 'restoration', 'general'];
        const normalizedCategory = ALLOWED_CATEGORIES.includes(category) ? category : undefined;

        const source = {
            name: sourceName && String(sourceName).trim() ? String(sourceName).trim() : 'LightWatch Admin',
            icon: '📢',
            official: isOfficial !== false
        };

        try {
            const result = await storeArticle({
                title: String(title).trim(),
                summary: summary ? String(summary).trim() : '',
                url: String(url).trim(),
                imageUrl: image && String(image).trim() ? String(image).trim() : null,
                category: normalizedCategory,
                publishedAt: publishedAt ? new Date(publishedAt) : new Date()
            }, source, { skipRelevanceFilter: true, throwOnDuplicate: true });

            if (result === 'duplicate') {
                return res.status(409).json({ error: 'This link has already been published to Official News' });
            }
            if (!result) {
                return res.status(500).json({ error: 'Could not publish article' });
            }

            clearNewsCache();

            return res.status(201).json({
                id: result._id,
                title: result.title,
                summary: result.summary,
                image: result.imageUrl || null,
                source: result.sourceName,
                sourceIcon: result.sourceIcon,
                isOfficial: result.isOfficial,
                category: result.category,
                publishedAt: result.publishedAt,
                url: result.articleUrl,
                locations: result.mentionedLocations,
                isNationwide: !!result.isNationwide,
                isAdminPosted: true,
                eventId: result.eventId
            });
        } catch (err) {
            console.error('Admin news publish error:', err.message);
            return res.status(500).json({ error: 'Server error publishing article' });
        }
    });

    // FIX (bug: news randomly disappearing / old articles reappearing):
    // this used to treat an empty/missing `ids` array as "delete
    // EVERYTHING" — `NewsEvent.deleteMany({})` + `NewsArticle.deleteMany({})`
    // with no blocklist entries recorded for any of it (that only
    // happens in the ids.length branch above). Any call that reaches
    // this route without a populated `ids` array — a frontend bug that
    // sends `{ ids: [] }` when nothing's actually checked, a race
    // between reading the checkbox state and firing the request, a
    // retried request after a timeout, even a stray/test call — wiped
    // every event and every raw article with no confirmation and no
    // undo. The fetch cycle then rebuilds from scratch on its next run,
    // which is exactly "old articles are the ones showing" from the
    // user's perspective: nothing was blocklisted during a mass wipe
    // (only the targeted-ids path records the blocklist), so stories
    // already sitting in a source's RSS feed — including ones from
    // days ago that Google News/WordPress feeds keep serving — get
    // re-ingested as if brand new, while the events that actually
    // existed a minute ago are just gone.
    //
    // Full-collection clear is still supported (the admin panel likely
    // has a legitimate "clear everything" action), but now only fires
    // on an explicit, unambiguous `confirmAll: true` in the body — never
    // as the default behavior for "no ids provided."
    app.delete('/admin/news', verifyAdminToken, async (req, res) => {
        const ids = Array.isArray(req.body?.ids) ? req.body.ids.filter(Boolean) : [];
        const confirmAll = req.body?.confirmAll === true;

        if (!ids.length && !confirmAll) {
            return res.status(400).json({
                error: 'No article/event ids provided. To clear all news, resend with { "confirmAll": true }.'
            });
        }

        try {
            if (ids.length) {
                // Record every article being deleted in the permanent
                // blocklist BEFORE actually deleting it — storeArticle
                // checks this on every future fetch, so the same story
                // can't quietly resurface just because Google News (or a
                // direct feed) still serves it on a later cycle. Fetched
                // first as a separate query since deleteMany doesn't hand
                // back the deleted documents' fields.
                const articlesToBlock = await NewsArticle.find({
                    $or: [{ _id: { $in: ids } }, { eventId: { $in: ids } }]
                }).select('articleUrl dedupeKey').lean();

                if (articlesToBlock.length) {
                    try {
                        await NewsBlocklist.insertMany(
                            articlesToBlock.map(a => ({ articleUrl: a.articleUrl, dedupeKey: a.dedupeKey })),
                            { ordered: false }
                        );
                    } catch (blockErr) {
                        // Re-deleting something already blocklisted trips
                        // the unique index on articleUrl — expected and
                        // harmless with ordered:false (other inserts in
                        // the batch still go through); only worth logging
                        // if it's some other kind of failure.
                        if (blockErr.code !== 11000 && blockErr.name !== 'MongoBulkWriteError') {
                            console.error('Blocklist insert warning:', blockErr.message);
                        }
                    }
                }

                // The admin news table is populated from GET /news, and
                // every `id` it hands back is a NewsEvent._id (see the
                // events-based response body in GET /news above) — NOT a
                // raw NewsArticle._id. Deleting only from NewsArticle (the
                // old behavior) matched nothing and silently no-opped,
                // which is why a "deleted" story kept reappearing.
                // Delete the event itself, plus every raw NewsArticle
                // folded into it (via eventId), so it can't just get
                // re-clustered back together next cycle. Also still
                // matches directly against NewsArticle._id for backward
                // compatibility with any caller that already has a raw
                // article id instead of an event id.
                await Promise.all([
                    NewsEvent.deleteMany({ _id: { $in: ids } }),
                    NewsArticle.deleteMany({ $or: [{ _id: { $in: ids } }, { eventId: { $in: ids } }] })
                ]);
            } else {
                await Promise.all([
                    NewsEvent.deleteMany({}),
                    NewsArticle.deleteMany({})
                ]);
            }
            clearNewsCache();
            return res.json({ success: true });
        } catch (err) {
            console.error('Admin news clear error:', err.message);
            return res.status(500).json({ error: 'Server error clearing news' });
        }
    });

    // DELETE /admin/events/:id — NEW. Remove a bad/duplicate event
    // cluster without touching the raw articles it was built from.
    app.delete('/admin/events/:id', verifyAdminToken, async (req, res) => {
        try {
            await NewsEvent.deleteOne({ _id: req.params.id });
            clearNewsCache();
            return res.json({ success: true });
        } catch (err) {
            console.error('Admin event delete error:', err.message);
            return res.status(500).json({ error: 'Server error deleting event' });
        }
    });

    return { NewsArticle, NewsEvent, runNewsFetchCycle };
};