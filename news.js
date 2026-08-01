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

const rssParser = new Parser({
    timeout: 15000,
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LightWatchNewsBot/1.0; +https://lightwatch-backend-production.up.railway.app)' },
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

function repairEmbeddedHtml(snippet) {
    let out = snippet;
    out = out.replace(/<([a-zA-Z][\w:-]*)((?:\s+[a-zA-Z_:][\w:.-]*(?:\s*=\s*(?:"[^"]*"|'[^']*'))?)*)\s*(\/?)\s*>/g,
        (match, tagName, attrs, selfClose) => {
            const fixed = attrs ? attrs.replace(/(\s+)([a-zA-Z_:][\w:.-]*)(?!\s*=)(?=\s|$)/g, '$1$2=""') : '';
            const needsSelfClose = selfClose || VOID_ELEMENTS.test(tagName);
            return `<${tagName}${fixed}${needsSelfClose ? ' /' : ''}>`;
        });
    return repairCrossedTags(out);
}

function scopeToArticleFields(xml) {
    return xml.replace(
        /(<(?:description|content:encoded)\b[^>]*>)([\s\S]*?)(<\/(?:description|content:encoded)>)/g,
        (fullMatch, openTag, inner, closeTag) => {
            if (inner.trimStart().startsWith('<![CDATA[')) return fullMatch;
            return openTag + repairEmbeddedHtml(inner) + closeTag;
        }
    );
}

function sanitizeFeedXml(xml) {
    let out = String(xml || '');
    out = out.replace(/&([a-zA-Z][a-zA-Z0-9]{1,10});/g, (m, name) => {
        const lower = name.toLowerCase();
        if (['amp', 'lt', 'gt', 'quot', 'apos'].includes(lower)) return m;
        return HTML_ENTITY_MAP[lower] !== undefined ? HTML_ENTITY_MAP[lower] : m;
    });
    out = out.replace(/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/g, '&amp;');
    out = scopeToArticleFields(out);
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

const NEWS_SOURCES = [
    // ECG's own site sits behind bot-detection on its main domain
    // (confirmed: Render's requests get a captcha-redirect stub back).
    // Its WordPress blog carries the same press releases and isn't
    // behind that gate.
    {
        name: 'ECG',
        icon: '⚡',
        official: true,
        type: 'rss',
        url: 'https://ecg.com.gh/blog/feed/'
    },
    { name: 'Citi News',           icon: '📰', official: false, type: 'rss', url: 'https://citinewsroom.com/feed/' },
    { name: 'MyJoyOnline',         icon: '📰', official: false, type: 'rss', url: 'https://www.myjoyonline.com/feed/' },
    { name: 'Graphic Online',      icon: '📰', official: false, type: 'rss', url: 'https://www.graphic.com.gh/news.feed?type=rss' },
    { name: 'GhanaWeb',            icon: '📰', official: false, type: 'rss', url: 'https://www.ghanaweb.com/GhanaHomePage/NewsArchive/rss.xml' },
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
    })),
    {
        name: 'ECG (site scrape)',
        icon: '⚡',
        official: true,
        type: 'scrape-ecg',
        url: 'https://ecg.com.gh/index.php/en/media-centre/news-events'
    }
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
function shouldBroadcastToAll(text, isNationwide) {
    return isNationwide || DUMSOR_REGEX.test(text);
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
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LightWatchNewsBot/1.0)' }
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
    newsArticleSchema.index({ publishedAt: -1 });
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
    newsEventSchema.index({ lastUpdatedAt: -1 });
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
            const subscribers = await PushSubscription.find({}).lean();
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

        const broadcast = shouldBroadcastToAll(combinedText, event.isNationwide);
        const reason = event.isNationwide ? 'nationwide' : 'dumsor-keyword';

        if (activeCycleQueue) {
            if (broadcast) {
                activeCycleQueue.broadcasts.push({ event, reason });
            } else if (event.affectedLocations.length) {
                for (const loc of event.affectedLocations) {
                    if (!activeCycleQueue.byLocation.has(loc)) activeCycleQueue.byLocation.set(loc, []);
                    activeCycleQueue.byLocation.get(loc).push(event);
                }
            }
        } else if (broadcast) {
            await notifyAllUsers(event, reason);
        } else if (event.affectedLocations.length) {
            await notifyLocationMentions(event, event.affectedLocations);
        }
        // else: no specific location and not broadcast-worthy — nothing
        // to target notifications at (e.g. a vague general-category
        // story); it still shows up in the feed either way.

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
    async function fetchRssSource(source, knownKeys) {
        let items = [];
        try {
            const res = await fetch(source.url, {
                headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LightWatchNewsBot/1.0)' }
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const rawXml = await res.text();
            const sanitized = sanitizeFeedXml(rawXml);
            try {
                const feed = await rssParser.parseString(sanitized);
                items = feed.items || [];
            } catch (parseErr) {
                // Sanitized XML STILL didn't parse — try the dumb regex
                // fallback rather than losing this source's items outright.
                items = extractItemsWithRegex(rawXml);
                if (items.length) {
                    console.warn(`[news] ${source.name}: rss-parser rejected the feed (${parseErr.message}) — recovered ${items.length} item(s) via regex fallback instead.`);
                } else {
                    throw parseErr; // fallback found nothing either — report the real error below
                }
            }
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

    async function scrapeEcgSite(source, knownKeys) {
        let html;
        try {
            const res = await fetch(source.url, {
                headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LightWatchNewsBot/1.0)' }
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            html = await res.text();
        } catch (err) {
            console.error(`[news] ECG site fetch FAILED (${source.url}): ${err.message}`);
            return { fetched: 0, stored: 0 };
        }

        const $ = cheerio.load(html);
        const candidates = $('.blog .item, .items-leading, .item-page, .blog-item, article');
        const items = [];

        candidates.each((_, el) => {
            const $el = $(el);
            const headingEl = $el.find('h2 a, h3 a, h2, h3').first();
            const title = headingEl.text().trim();
            let href = headingEl.is('a') ? headingEl.attr('href') : $el.find('a').first().attr('href');
            if (!title || !href) return;
            href = resolveUrl(href, source.url);
            if (!href) return;
            const summary = $el.find('p').first().text().trim();
            const imgSrc = $el.find('img').first().attr('src');
            const imageUrl = imgSrc ? resolveUrl(imgSrc, source.url) : null;
            items.push({ title, summary, url: href, imageUrl, publishedAt: new Date() });
        });

        if (items.length === 0) {
            if (html.length < 2000) {
                console.warn(`[news] ECG: page fetched but only ${html.length} bytes back — likely blocked/challenged. Body: ${html.slice(0, 500)}`);
            } else {
                console.warn(`[news] ECG: page fetched (${html.length} bytes) but 0 article blocks matched the selectors.`);
            }
            return { fetched: 0, stored: 0 };
        }

        const seen = new Set();
        let stored = 0;
        for (const item of items) {
            if (seen.has(item.url)) continue;
            seen.add(item.url);
            const doc = await storeArticle(item, source, { knownKeys });
            if (doc) stored++;
        }

        console.log(`[news] ECG: found ${items.length} candidate item(s), stored ${stored} new.`);
        return { fetched: items.length, stored };
    }

    let lastFetchStats = null;

    async function runNewsFetchCycle() {
        console.log('[news] Fetch cycle starting...');
        const stats = { startedAt: new Date(), sources: {} };
        const knownKeys = await getKnownLocationKeys();

        const cycleQueue = { broadcasts: [], byLocation: new Map() };
        activeCycleQueue = cycleQueue;

        try {
            for (const source of NEWS_SOURCES) {
                let result;
                if (source.type === 'rss' || source.type === 'google-news') result = await fetchRssSource(source, knownKeys);
                else if (source.type === 'scrape-ecg') result = await scrapeEcgSite(source, knownKeys);
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

    setTimeout(() => { runNewsFetchCycle().catch(err => console.error('[news] Initial fetch failed:', err.message)); }, 10000);
    setInterval(() => { runNewsFetchCycle().catch(err => console.error('[news] Scheduled fetch failed:', err.message)); }, NEWS_FETCH_INTERVAL_MS);

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
                    image: e.imageUrl || null,
                    affectedLocations: e.affectedLocations,
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
            const events = await NewsEvent.find(query)
                .sort({ isNationwide: -1, lastUpdatedAt: -1 })
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
                    // Was hardcoded to null — that was the regression that
                    // broke article images. Now carried through from
                    // whichever source article had one (see imageUrl on
                    // NewsEvent, set/merged in attachArticleToEvent).
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
            sources: NEWS_SOURCES.map(s => ({ name: s.name, url: s.url, type: s.type, query: s.query }))
        });
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
                image: result.imageUrl,
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

    app.delete('/admin/news', verifyAdminToken, async (req, res) => {
        const ids = Array.isArray(req.body?.ids) ? req.body.ids.filter(Boolean) : [];
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