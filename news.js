// ============================================================
//  NEWS.JS — Official electricity-news system for LightWatch
//
//  Self-contained module: owns its own Mongoose schema/model,
//  the background fetch scheduler, and the public GET /news
//  route. Wired into server.js with a single call:
//
//      require('./news')(app, {
//          mongoose, PushSubscription, User,
//          sendPushToSubscribers, normalizeLocation,
//          titleCaseLocation, escapeRegex, verifyAdminToken
//      });
//
//  WHAT IT DOES
//   1. Every NEWS_FETCH_INTERVAL_MS (default 20 min, well inside
//      the requested 15–30 min window) it polls a list of trusted
//      Ghanaian media RSS feeds plus ECG's own "News & Events"
//      page (scraped — ECG doesn't publish an RSS feed).
//   2. Every candidate item is filtered against an electricity-
//      related keyword allowlist (ECG, GRIDCo, outages, tariffs,
//      maintenance, etc.) — anything that doesn't match is
//      dropped before it ever reaches the database.
//   3. Duplicates are rejected two ways: an exact articleUrl
//      match (same story re-fetched next cycle) and a fuzzy
//      title match against anything stored in the last 3 days
//      (same story picked up by two outlets).
//   4. Surviving articles are stored with a normalized set of
//      "mentioned locations" — matched against the same location
//      keys LightWatch already tracks (every PushSubscription's
//      location/secondaryLocationKey, every User's city). Any
//      match fires a push notification to devices watching that
//      location, through the exact same sendPushToSubscribers()
//      pipeline lightstatus/chat pushes already use.
//   5. GET /news returns the stored feed, ECG articles always
//      sorted first (isOfficial), then newest first.
//
//  DEPENDENCIES (new): rss-parser, cheerio.
//      npm install rss-parser cheerio --save
//  Node 18+ is assumed for global fetch() (Render's default
//  runtime already ships 18+). If running on an older Node,
//  swap the fetch() call in scrapeEcgSite() for node-fetch.
// ============================================================

const Parser = require('rss-parser');
const cheerio = require('cheerio');

const rssParser = new Parser({
    timeout: 15000,
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LightWatchNewsBot/1.0; +https://lightwatch-backend.onrender.com)' }
});

// A handful of these feeds ship genuinely malformed XML. Three recurring
// causes, all from Ghanaian outlets running WordPress/Joomla feed
// generators that were clearly built against HTML tolerance, not strict
// XML:
//   1. Common named HTML entities (&mdash; &nbsp; &rsquo; etc.) — valid
//      in HTML, but NOT among XML's five predefined entities, so a
//      strict parser errors out exactly like it would on a raw "&".
//   2. Bare/valueless HTML attributes leaking into the feed (e.g.
//      <img ... allowfullscreen>) — valid HTML, invalid XML, and shows
//      up as "Attribute without value".
//   3. Unclosed HTML "void" elements (<br>, <img ...>, <hr> etc. with
//      no trailing "/") embedded in a <description>/<content:encoded>
//      body. XML has no concept of an element that never needs a
//      closing tag, so a strict parser treats the next real closing
//      tag it hits (e.g. the </p> after a stray <br>) as unmatched —
//      exactly the "Unexpected close tag" errors ECG and GhanaWeb throw.
//      Self-closing every void element (<br /> instead of <br>) before
//      parsing fixes this without touching genuinely paired tags.
// Rather than lose the whole feed over one bad headline or embedded
// snippet, fetch the raw text ourselves and repair all three before
// handing it to the parser.
// NOTE: "link" and "source" are HTML void elements but are deliberately
// left OFF this list — RSS/Atom itself uses <link>...</link> and
// <source url="...">...</source> as ordinary elements with real text
// content, so self-closing a bare <link> or <source> at the feed's own
// structural level would corrupt the feed (turns its real closing tag
// into an "unexpected close tag" itself). The elements below don't
// collide with any RSS/Atom vocabulary, so they're safe to always
// self-close wherever they show up, structural or embedded-HTML.
const VOID_ELEMENTS = /^(area|base|br|col|embed|hr|img|input|meta|param|track|wbr)$/i;
const HTML_ENTITY_MAP = {
    nbsp: '\u00A0', mdash: '\u2014', ndash: '\u2013', hellip: '\u2026',
    lsquo: '\u2018', rsquo: '\u2019', ldquo: '\u201C', rdquo: '\u201D',
    copy: '\u00A9', reg: '\u00AE', trade: '\u2122', deg: '\u00B0',
    eacute: '\u00E9', egrave: '\u00E8', agrave: '\u00E0', ccedil: '\u00E7'
};

// Stack-based tag balancer — see cause #4 in sanitizeFeedXml() below for
// why this needs an actual stack rather than a regex substitution.
// Walks every tag in the string in order; a closing tag matching the
// top of the stack pops normally, one matching something DEEPER in the
// stack force-closes everything above it too (flattening the crossed
// structure), and one matching NOTHING currently open is dropped as a
// stray. Anything still open when the string ends gets auto-closed.
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
            if (stackIdx === -1) continue; // stray closing tag, no match open — drop it
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

function sanitizeFeedXml(xml) {
    let out = String(xml || '');

    // Decode recognized HTML named entities to real characters. Anything
    // NOT in the map (unknown/rare entity) falls through to the generic
    // ampersand escape below, same as a truly raw "&".
    out = out.replace(/&([a-zA-Z][a-zA-Z0-9]{1,10});/g, (m, name) => {
        const lower = name.toLowerCase();
        if (['amp', 'lt', 'gt', 'quot', 'apos'].includes(lower)) return m; // already XML-valid, leave alone
        return HTML_ENTITY_MAP[lower] !== undefined ? HTML_ENTITY_MAP[lower] : m;
    });

    // Escape any "&" that still isn't part of a valid XML entity
    // (numeric entities and the 5 XML-predefined ones are left alone).
    out = out.replace(/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/g, '&amp;');

    // Repair bare/valueless attributes inside tags — e.g. <img ...
    // allowfullscreen> — by giving them an empty value. Only touches
    // attribute POSITIONS within a tag; well-formed name="value" pairs
    // (the vast majority) are matched but left untouched by the lookahead.
    // Same pass also self-closes unclosed void elements (cause #3 above):
    // any <br|img|hr|...> tag that isn't already self-closed gets a
    // trailing "/" added. Only matches opening tags (the tagName capture
    // requires a letter right after "<", so "</p>" etc. are never
    // touched) and only ever adds a slash for tags on the void list —
    // ordinary paired elements (<p>, <div>, ...) are left exactly as-is.
    out = out.replace(/<([a-zA-Z][\w:-]*)((?:\s+[a-zA-Z_:][\w:.-]*(?:\s*=\s*(?:"[^"]*"|'[^']*'))?)*)\s*(\/?)\s*>/g,
        (match, tagName, attrs, selfClose) => {
            const fixed = attrs ? attrs.replace(/(\s+)([a-zA-Z_:][\w:.-]*)(?!\s*=)(?=\s|$)/g, '$1$2=""') : '';
            const needsSelfClose = selfClose || VOID_ELEMENTS.test(tagName);
            return `<${tagName}${fixed}${needsSelfClose ? ' /' : ''}>`;
        });

    // Cause #4 — genuinely CROSSED (overlapping) tags, e.g.
    // <b>text<p>more</b></p>. This is distinct from the unclosed-void-
    // element case above: these are real paired tags, just nested in an
    // order browsers silently auto-correct but XML never tolerates —
    // extremely common when article text is copy-pasted from Word/
    // Google Docs into WordPress/Joomla. A regex substitution can't fix
    // this (it requires tracking actual nesting), so repairCrossedTags()
    // below walks the tag stream with a stack and, whenever a closing
    // tag doesn't match what's currently open, closes everything down
    // to its real match instead (dropping it entirely if no match is
    // open at all). This doesn't preserve the original's visual nesting
    // — but nothing downstream needs that: descriptions are stripped to
    // plain text via stripHtml() right after parsing, so "parses
    // successfully" is the only bar this needs to clear.
    out = repairCrossedTags(out);

    return out;
}

// ---- Sources ------------------------------------------------
// `official: true` is reserved for ECG's own site — that's the
// flag the /news route and the frontend use to always surface
// ECG's own announcements first. Media RSS URLs occasionally
// move when an outlet re-platforms; if a feed starts 404ing,
// fetchRssSource() just logs and skips it rather than crashing
// the whole cycle, so one dead feed never takes the others down.
const NEWS_SOURCES = [
    // Was: scraping https://ecg.com.gh/index.php/en/media-centre/news-events
    // directly. That path sits behind a bot-check (confirmed: Render's
    // requests get a 210-byte "sgcaptcha" redirect stub instead of the
    // real page — an IP-level block, not a selector/markup problem, so
    // no amount of scraper tweaking will fix it). ECG separately runs a
    // WordPress blog at ecg.com.gh/blog/ (different software stack, not
    // behind the same gate) with the same press releases — using its
    // standard WordPress RSS feed instead. If this ever comes back
    // empty, check the URL still resolves before assuming it's blocked
    // too.
    {
        name: 'ECG',
        icon: '⚡',
        official: true,
        type: 'rss',
        url: 'https://ecg.com.gh/blog/feed/'
    },
    // NOTE: this has been seen returning both a 403 and (on other runs) a
    // malformed-XML parse error — inconsistent behavior consistent with
    // bot-detection (e.g. Cloudflare) that sometimes challenges Render's
    // requests and sometimes lets a mangled response through. If it never
    // recovers, it likely can't be fixed from this hosting IP without a
    // proxy/rotating-IP service — may be worth dropping if it stays dead.
    { name: 'Citi News',      icon: '📰', official: false, type: 'rss', url: 'https://citinewsroom.com/feed/' },
    { name: 'MyJoyOnline',    icon: '📰', official: false, type: 'rss', url: 'https://www.myjoyonline.com/feed/' },
    // Was 'https://www.graphic.com.gh/feed' — 404s now. Graphic's Joomla
    // feed generator lives at this path instead (same pattern as their
    // per-section feeds, e.g. /features/features.feed?type=rss). Worth
    // double-checking in a browser if this ever goes quiet again.
    { name: 'Graphic Online', icon: '📰', official: false, type: 'rss', url: 'https://www.graphic.com.gh/news.feed?type=rss' },
    { name: 'GhanaWeb',       icon: '📰', official: false, type: 'rss', url: 'https://www.ghanaweb.com/GhanaHomePage/NewsArchive/rss.xml' },
    // Was 'https://www.modernghana.com/rss/news.xml' — wrong host/path.
    // Confirmed current URL straight from modernghana.com/rssfeed/.
    { name: 'Modern Ghana',   icon: '📰', official: false, type: 'rss', url: 'https://rss.modernghana.com/news.xml' },
    // New sources added to widen coverage — both confirmed live (real
    // rss+xml / WordPress feed content, not a 404 or parked-domain page)
    // before being added here.
    { name: 'AdomOnline',        icon: '📰', official: false, type: 'rss', url: 'https://www.adomonline.com/feed' },
    { name: 'Ghana Business News', icon: '📰', official: false, type: 'rss', url: 'https://www.ghanabusinessnews.com/feed/' }
];

// ---- Relevance keyword allowlist -----------------------------
// NOTE: no bare 'feeder' entry. Confirmed real false positive: a
// Parliament road-funding story about "feeder roads" (a standard term
// for rural access roads in Ghana, nothing to do with electricity)
// matched the allowlist purely because of that word. Unlike the
// 'purc'/"purchase" bug, word-boundary matching can't fix this one —
// "feeder" really is a standalone word in both the electrical sense
// ("11kV feeder") and the roads sense ("feeder roads"), so it's a
// genuine homonym, not a substring artifact. 'feeder fault' (the
// actual recurring ECG-outage phrasing) stays, since that compound
// phrase doesn't collide with the roads usage.
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

// Compiled once. Word-boundary matching, NOT plain substring matching —
// this matters because several keywords here are short abbreviations
// ("purc", "ecg") that would otherwise match as a SUBSTRING of an
// unrelated ordinary word. Confirmed real-world false positive: 'purc'
// (meant to catch "PURC", the utility regulator) was matching inside
// "purchase"/"purchasing" — which let completely unrelated stories
// (a doctor buying hospital equipment, a condom-vending-machine
// article, a road-infrastructure funding story) sail through the
// allowlist just because they contained the word "purchase" somewhere.
// \b...\b anchors each keyword to real word boundaries, so "purc"
// matches only the standalone word "PURC", never "purchase". Multi-word
// phrases are unaffected — the space between words is already a word
// boundary on both sides.
const NEWS_KEYWORD_REGEX = new RegExp(
    '\\b(' + NEWS_KEYWORDS.map(k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')\\b',
    'i'
);

function isRelevantArticle(text) {
    return NEWS_KEYWORD_REGEX.test(text);
}

function detectCategory(text) {
    const t = text.toLowerCase();
    if (/(restor|back on|resum|reconnect)/.test(t)) return 'restoration';
    if (/(maintenance|upgrade|scheduled|planned outage|planned works)/.test(t)) return 'maintenance';
    if (/(tariff|price hike|bill increase|surcharge)/.test(t)) return 'tariff';
    if (/(outage|fault|blackout|power cut|interruption|dumsor|load shedding)/.test(t)) return 'outage';
    return 'general';
}

// Cheap normalized-title key for cross-source duplicate detection —
// lowercase, strip punctuation, collapse whitespace, keep the first
// ~12 significant words (enough to catch "ECG explains outage in
// Kumasi" vs "ECG explains outage in Kumasi — Citi News" without
// needing a full similarity algorithm).
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

function stripHtml(html) {
    return String(html || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function extractImageFromRssItem(item) {
    if (item.enclosure && item.enclosure.url) return item.enclosure.url;
    const html = item['content:encoded'] || item.content || item.summary || '';
    const match = /<img[^>]+src="([^"]+)"/i.exec(html);
    return match ? match[1] : null;
}

function resolveUrl(maybeRelative, base) {
    if (!maybeRelative) return null;
    try { return new URL(maybeRelative, base).toString(); }
    catch { return null; }
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

    // ---- Schema / model --------------------------------------
    const newsArticleSchema = new mongoose.Schema({
        title:        { type: String, required: true },
        summary:      { type: String, default: '' },
        imageUrl:     { type: String, default: null },
        sourceName:   { type: String, required: true },
        sourceIcon:   { type: String, default: '📰' },
        isOfficial:   { type: Boolean, default: false }, // true only for ECG's own site
        category:     { type: String, enum: ['maintenance', 'outage', 'tariff', 'restoration', 'general'], default: 'general' },
        articleUrl:   { type: String, required: true, unique: true },
        dedupeKey:    { type: String, required: true },
        publishedAt:  { type: Date, required: true },
        fetchedAt:    { type: Date, default: Date.now },
        // Location keys (same normalized form as PushSubscription.location)
        // found mentioned in the title/summary text.
        mentionedLocations: { type: [String], default: [] },
        // Which of those locations have already had a push sent for this
        // article — guards against double-notifying if the article gets
        // touched again by a later fetch cycle for any reason.
        notifiedLocations:  { type: [String], default: [] }
    });
    newsArticleSchema.index({ publishedAt: -1 });
    newsArticleSchema.index({ isOfficial: -1, publishedAt: -1 });
    newsArticleSchema.index({ dedupeKey: 1, publishedAt: -1 });
    newsArticleSchema.index({ mentionedLocations: 1 });

    const NewsArticle = mongoose.models.NewsArticle || mongoose.model('NewsArticle', newsArticleSchema);

    // ---- Location matching ------------------------------------
    // Reuses the same location vocabulary LightWatch already has —
    // every device's primary/secondary watched location, plus every
    // signed-up user's home city — rather than maintaining a separate
    // hardcoded gazetteer of Ghanaian place names.
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
            // Skip very short keys (e.g. stray single letters) to avoid
            // noisy false-positive matches inside unrelated words.
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

    async function notifyLocationMentions(article, locationKeys) {
        if (!locationKeys.length) return;
        try {
            const subscribers = await PushSubscription.find({ location: { $in: locationKeys } });
            if (!subscribers.length) return;

            const displayLocation = titleCaseLocation(locationKeys[0]);
            const payload = {
                title: `LightWatch News — ${displayLocation}`,
                body: article.title,
                url: '/pages/chat.html',
                tag: `news-${article._id}`,
                requireInteraction: false,
                vibrate: [200, 90, 200],
                image: article.imageUrl || undefined,
                tone: 'chat'
            };

            console.log(`[news] Notifying ${subscribers.length} subscriber(s) — "${article.title}" mentions ${locationKeys.join(', ')}`);
            await sendPushToSubscribers(subscribers, payload);

            await NewsArticle.updateOne(
                { _id: article._id },
                { $addToSet: { notifiedLocations: { $each: locationKeys } } }
            );
        } catch (err) {
            console.error('[news] Location-mention push error:', err.message);
        }
    }

    // ---- Store (with relevance filter + dedupe) ----------------
    async function storeArticle(raw, source) {
        const title = String(raw.title || '').trim();
        const articleUrl = raw.url;
        if (!title || !articleUrl) return null;

        const summary = stripHtml(raw.summary || '').slice(0, 500) || title;
        const combinedText = `${title} ${summary}`;

        if (!isRelevantArticle(combinedText)) return null;

        // Exact-URL duplicate (this story, already stored).
        const existing = await NewsArticle.findOne({ articleUrl }).select('_id').lean();
        if (existing) return null;

        // Cross-source near-duplicate (same story, different outlet)
        // within the last 3 days.
        const dedupeKey = titleDedupeKey(title);
        const cutoff = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
        const nearDuplicate = await NewsArticle.findOne({
            dedupeKey,
            publishedAt: { $gte: cutoff }
        }).select('_id isOfficial').lean();

        // If a non-official outlet already has this story but ECG's own
        // version just came in, prefer keeping ECG's — replace rather
        // than skip, so official framing wins over a re-hash.
        if (nearDuplicate) {
            if (source.official && !nearDuplicate.isOfficial) {
                await NewsArticle.deleteOne({ _id: nearDuplicate._id });
            } else {
                return null;
            }
        }

        const knownKeys = await getKnownLocationKeys();
        const mentionedLocations = findMentionedLocations(combinedText, knownKeys);

        let doc;
        try {
            doc = await NewsArticle.create({
                title,
                summary,
                imageUrl: raw.imageUrl || null,
                sourceName: source.name,
                sourceIcon: source.icon,
                isOfficial: !!source.official,
                category: detectCategory(combinedText),
                articleUrl,
                dedupeKey,
                publishedAt: raw.publishedAt instanceof Date && !isNaN(raw.publishedAt) ? raw.publishedAt : new Date(),
                mentionedLocations
            });
        } catch (err) {
            // Unique-index race (two cycles overlapping, or the same URL
            // appearing twice in one feed) — not a real error, just skip.
            if (err.code === 11000) return null;
            throw err;
        }

        if (mentionedLocations.length) {
            // Don't block the fetch cycle waiting on push delivery.
            notifyLocationMentions(doc, mentionedLocations);
        }

        return doc;
    }

    // ---- Fetchers -----------------------------------------------
    async function fetchRssSource(source) {
        let items = [];
        try {
            // Fetch raw text ourselves (instead of rssParser.parseURL, which
            // fetches AND parses in one step) so malformed XML can be
            // repaired before it ever reaches the strict parser — see
            // sanitizeFeedXml() above.
            const res = await fetch(source.url, {
                headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LightWatchNewsBot/1.0)' }
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const rawXml = await res.text();
            const feed = await rssParser.parseString(sanitizeFeedXml(rawXml));
            items = feed.items || [];
        } catch (err) {
            // This is the #1 thing to check first if news isn't showing up —
            // a feed URL that's moved/changed shows up here as a 404/parse
            // error, distinct from "fetched fine but nothing was relevant"
            // below.
            console.error(`[news] RSS fetch FAILED for ${source.name} (${source.url}): ${err.message}`);
            return { fetched: 0, stored: 0 };
        }

        let stored = 0;
        for (const item of items.slice(0, 25)) {
            const doc = await storeArticle({
                title: item.title,
                summary: item.contentSnippet || item.content || item.summary || '',
                url: item.link,
                imageUrl: extractImageFromRssItem(item),
                publishedAt: item.isoDate ? new Date(item.isoDate) : new Date()
            }, source);
            if (doc) stored++;
        }

        console.log(`[news] ${source.name}: fetched ${items.length} item(s), stored ${stored} new (rest were off-topic, duplicates, or already stored).`);
        return { fetched: items.length, stored };
    }

    // ECG doesn't publish RSS, so its "Media Centre / News & Events"
    // page is scraped directly. Selectors target the common Joomla
    // blog-listing markup that page uses; kept loose (several
    // fallback selectors) since a template tweak on ECG's end is far
    // more likely to break a scraper than an RSS feed. The keyword
    // filter in storeArticle() means a stale/broken selector just
    // yields nothing useful rather than bad data reaching users.
    async function scrapeEcgSite(source) {
        let html;
        try {
            const res = await fetch(source.url, {
                headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LightWatchNewsBot/1.0)' }
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            html = await res.text();
        } catch (err) {
            // A ReferenceError here ("fetch is not defined") means the
            // Node runtime is older than 18 and has no global fetch —
            // check `node -v` on the host if you see that specific message.
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

        // If the fetch succeeded (HTML came back) but the selectors above
        // found zero candidate blocks, that's a near-certain sign ECG's
        // page markup no longer matches these selectors — worth checking
        // `curl <url>` and inspecting the actual HTML structure.
        if (items.length === 0) {
            // A response under ~2KB is almost certainly NOT the real page
            // (the actual News & Events page is tens of KB) — far more
            // likely a bot-detection/challenge page, a redirect stub, or a
            // WAF block of Render's outbound IP. Log the actual body in
            // that case so it's obvious which one we're dealing with,
            // rather than assuming "markup changed" and chasing selectors
            // that were never the problem.
            if (html.length < 2000) {
                console.warn(`[news] ECG: page fetched but only ${html.length} bytes back — likely blocked/challenged rather than a markup change. Body: ${html.slice(0, 500)}`);
            } else {
                console.warn(`[news] ECG: page fetched (${html.length} bytes) but 0 article blocks matched the selectors — the site's markup may have changed.`);
            }
            return { fetched: 0, stored: 0 };
        }

        // De-dupe within this single scrape pass (the same story can
        // appear in more than one listing block on the page).
        const seen = new Set();
        let stored = 0;
        for (const item of items) {
            if (seen.has(item.url)) continue;
            seen.add(item.url);
            const doc = await storeArticle(item, source);
            if (doc) stored++;
        }

        console.log(`[news] ECG: found ${items.length} candidate item(s), stored ${stored} new.`);
        return { fetched: items.length, stored };
    }

    // Kept around so GET /admin/news/refresh (and anyone poking at this
    // from a debugger) can see exactly what the last cycle did per
    // source, without having to go dig through log history.
    let lastFetchStats = null;

    async function runNewsFetchCycle() {
        console.log('[news] Fetch cycle starting...');
        const stats = { startedAt: new Date(), sources: {} };

        for (const source of NEWS_SOURCES) {
            let result;
            if (source.type === 'rss') result = await fetchRssSource(source);
            else if (source.type === 'scrape-ecg') result = await scrapeEcgSite(source);
            stats.sources[source.name] = result || { fetched: 0, stored: 0 };
        }

        stats.finishedAt = new Date();
        lastFetchStats = stats;
        console.log('[news] Fetch cycle complete:', JSON.stringify(stats.sources));
    }

    // ---- Scheduler ------------------------------------------------
    // 15–30 min window as requested; default sits in the middle of it.
    const NEWS_FETCH_INTERVAL_MS = Number(process.env.NEWS_FETCH_INTERVAL_MS) || 20 * 60 * 1000;

    // Give Mongo a moment to finish connecting before the first run,
    // then settle into the regular interval.
    setTimeout(() => { runNewsFetchCycle().catch(err => console.error('[news] Initial fetch failed:', err.message)); }, 10000);
    setInterval(() => { runNewsFetchCycle().catch(err => console.error('[news] Scheduled fetch failed:', err.message)); }, NEWS_FETCH_INTERVAL_MS);

    // ---- Routes -----------------------------------------------------
    // GET /news — latest articles, ECG's own announcements pinned first.
    app.get('/news', async (req, res) => {
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 30, 1), 100);

        const query = {};
        if (req.query.category) query.category = req.query.category;
        if (req.query.official === 'true') query.isOfficial = true;
        if (req.query.location) {
            query.mentionedLocations = normalizeLocation(req.query.location).split(',')[0].trim();
        }
        if (req.query.before) {
            const beforeDate = new Date(req.query.before);
            if (!isNaN(beforeDate)) query.publishedAt = { $lt: beforeDate };
        }

        try {
            const articles = await NewsArticle.find(query)
                .sort({ isOfficial: -1, publishedAt: -1 })
                .limit(limit)
                .lean();

            return res.json(articles.map(a => ({
                id: a._id,
                title: a.title,
                summary: a.summary,
                image: a.imageUrl,
                source: a.sourceName,
                sourceIcon: a.sourceIcon,
                isOfficial: a.isOfficial,
                category: a.category,
                publishedAt: a.publishedAt,
                url: a.articleUrl,
                locations: a.mentionedLocations
            })));
        } catch (err) {
            console.error('News fetch error:', err.message);
            return res.status(500).json({ error: 'Server error fetching news' });
        }
    });

    // ---- Admin: manual refresh + cleanup (mirrors the existing
    // admin/* route conventions elsewhere in server.js) -------------
    app.post('/admin/news/refresh', verifyAdminToken, async (req, res) => {
        try {
            await runNewsFetchCycle();
            const totalArticles = await NewsArticle.countDocuments();
            return res.json({ success: true, totalArticles, lastFetchStats });
        } catch (err) {
            console.error('Admin news refresh error:', err.message);
            return res.status(500).json({ error: 'Server error refreshing news' });
        }
    });

    // GET version too — same verifyAdminToken (Bearer JWT in the
    // Authorization header, same as every other /admin/* route) but
    // read-only, for a quick status check without triggering a fetch.
    app.get('/admin/news/status', verifyAdminToken, async (req, res) => {
        const totalArticles = await NewsArticle.countDocuments();
        return res.json({ totalArticles, lastFetchStats, sources: NEWS_SOURCES.map(s => ({ name: s.name, url: s.url, type: s.type })) });
    });

    app.delete('/admin/news', verifyAdminToken, async (req, res) => {
        try {
            await NewsArticle.deleteMany({});
            return res.json({ success: true });
        } catch (err) {
            console.error('Admin news clear error:', err.message);
            return res.status(500).json({ error: 'Server error clearing news' });
        }
    });

    return { NewsArticle, runNewsFetchCycle };
};