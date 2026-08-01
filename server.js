const path = require('path');
const dns = require('dns');
const fs = require('fs');
dns.setDefaultResultOrder('ipv4first');

require('dotenv').config();
const mongoose = require('mongoose');
const express = require('express');
const cors = require('cors');
const compression = require('compression');
const jwt = require('jsonwebtoken');
const webpush = require('web-push');
const admin = require('firebase-admin');

// MONGODB CONNECTION
const MONGO_URI = process.env.MONGODB_URI;
const JWT_SECRET = process.env.JWT_SECRET || "your-secret-key-change-this";

// Admin sign-in is a single password check against ADMIN_PASSWORD — no
// email/OTP step, since the admin console has no live inbox and doesn't
// need one. Set ADMIN_PASSWORD on Render (or in your .env locally); the
// fallback below only exists so the app still boots without one, and a
// clear warning is logged so it's never mistaken for a real deployment.
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

if (!process.env.ADMIN_PASSWORD) {
    console.warn("WARNING: ADMIN_PASSWORD not set in environment. Using an insecure default. Set it on Render.");
}

// ── Dev/testing login bypass (regular USER app — NOT the admin console) ──
// This is separate from ADMIN_PASSWORD above. It exists so an admin/dev
// can sign in and out of the ordinary consumer app (the same flow every
// other user goes through — login.js -> verification.js) for back-and-forth
// testing without needing access to a real inbox or phone. When someone
// signs up/signs in/resends with this exact contact, the server uses a
// fixed code and skips actually sending an email/SMS — nothing goes out
// for it, ever. It does NOT grant admin-console access on its own; it's
// just a normal user account. Override via env vars, or set
// DEV_LOGIN_EMAIL to an empty string to disable the bypass entirely.
const DEV_LOGIN_EMAIL = (process.env.DEV_LOGIN_EMAIL || "").toLowerCase().trim();
const DEV_LOGIN_CODE  = (process.env.DEV_LOGIN_CODE || "").trim();

function isDevLoginContact(emailPhone) {
    return !!DEV_LOGIN_EMAIL && emailPhone === DEV_LOGIN_EMAIL;
}

if (!MONGO_URI) {
    console.error("FATAL: MONGODB_URI environment variable is not set.");
    process.exit(1);
}

if (!process.env.JWT_SECRET) {
    console.warn("WARNING: JWT_SECRET not set in environment. Using default (insecure). Set it on Render.");
}

// The signup page's "use my location" button reverse-geocodes lat/lng
// into a city name via /geocode/reverse below, which calls Google's
// Geocoding API server-side so the key never reaches the browser.
if (!process.env.GOOGLE_MAPS_API_KEY) {
    console.warn("WARNING: GOOGLE_MAPS_API_KEY not set. The signup page's \"use my location\" button will not be able to resolve a city name.");
}

// VAPID setup for push notifications
if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    webpush.setVapidDetails(
        `mailto:${process.env.VAPID_EMAIL}`,
        process.env.VAPID_PUBLIC_KEY,
        process.env.VAPID_PRIVATE_KEY
    );
    console.log("Web push VAPID configured.");
} else {
    console.warn("WARNING: VAPID keys not set. Push notifications will not work.");
}

// ── Firebase Admin setup for FCM (native Android push) ──────────────
// The native app can't use web-push (Android System WebView has no
// PushManager — see notification.js's isNativeAndroidApp() branch), so
// Android devices register an FCM token instead of a web PushSubscription
// (POST /subscribe/fcm), and get notified via admin.messaging() below
// instead of webpush.sendNotification(). Browser/PWA users are
// unaffected — they keep going through the VAPID path above.
//
// FIREBASE_SERVICE_ACCOUNT_KEY should be the full service-account JSON
// (Firebase console → Project settings → Service accounts → Generate
// new private key), stored as a single-line string in the env var.
let fcmEnabled = false;
if (process.env.FIREBASE_SERVICE_ACCOUNT_KEY) {
    try {
        const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);
        admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
        fcmEnabled = true;
        console.log("Firebase Admin (FCM) configured.");
    } catch (err) {
        console.error("FIREBASE_SERVICE_ACCOUNT_KEY is set but invalid JSON:", err.message);
    }
} else {
    console.warn("WARNING: FIREBASE_SERVICE_ACCOUNT_KEY not set. Native Android push notifications will not work.");
}

// Log a masked version of the URI so we can confirm which form is being used (no secrets printed)
try {
    const prefix = MONGO_URI.indexOf('://') !== -1 ? MONGO_URI.split('://')[0] + '://' : '';
    const hostPart = MONGO_URI.replace(/.*@/, '').slice(0, 40);
    console.log('Using MONGO_URI:', prefix + hostPart.replace(/:.*/, ':***'));
} catch (e) {
    console.log('Using MONGO_URI: (masked)');
}

// NOTE: this is the ONLY mongoose.connect() call in the app — Mongoose
// manages a single pooled connection for the whole process from here,
// and every model/query below reuses it automatically. There is no
// per-request or per-route connect/disconnect anywhere in this file,
// which is what you want on Render (opening a fresh connection per
// request is one of the most common Express+Mongo performance bugs).
// maxPoolSize/minPoolSize just tune how many sockets that single
// connection is allowed to use concurrently under load.
mongoose.connect(MONGO_URI, {
    serverSelectionTimeoutMS: 10000,
    family: 4,
    maxPoolSize: Number(process.env.MONGO_MAX_POOL_SIZE) || 10,
    minPoolSize: Number(process.env.MONGO_MIN_POOL_SIZE) || 1
})
.then(() => {
    console.log("MongoDB connected successfully");
})
.catch(err => {
    console.error("MongoDB connection error:", err.message);
});

mongoose.connection.on('error', (err) => {
    console.error("MongoDB runtime error:", err.message);
});

// Mongoose debug mode logs every single query — extremely useful while
// developing, but real overhead (extra I/O + string formatting) on every
// request in production. Only auto-enable it in development; set
// MONGOOSE_DEBUG=true explicitly if you ever need it on Render too.
mongoose.set('debug', process.env.MONGOOSE_DEBUG === 'true' || process.env.NODE_ENV === 'development');

// SCHEMAS / MODELS
const userSchema = new mongoose.Schema({
    name: { type: String, required: true },
    emailPhone: { type: String, required: true, unique: true },
    region: { type: String, required: true },
    city: { type: String, required: true },
    cityChangeLocked: { type: Boolean, default: false },
    cityChangedAt: { type: Date, default: null },
    chatHandle: { type: String },
    // Optional uploaded avatar image (data URL) used as profile photo.
    avatarImage: { type: String, default: null },
    // Optional second monitored location (e.g. "Work") — separate from the
    // primary signup region/city above, which stays the account's home base.
    secondaryLocation: {
        label:  { type: String, default: null }, // "Work", "Family house", etc.
        city:   { type: String, default: null },
        region: { type: String, default: null }
    },
    createdAt: { type: Date, default: Date.now }
});
// emailPhone already gets a unique index for free from `unique: true` above.
// chatHandle: looked up on every generateUniqueChatHandle() collision check
// and every /signin. city: read via User.distinct('city') in /admin/summary
// and /admin/locations.
userSchema.index({ chatHandle: 1 });
userSchema.index({ city: 1 });

const chatSchema = new mongoose.Schema({
    // Not required: admin-broadcast messages (see POST /admin/broadcast)
    // are authored by the admin dashboard, not a User account, and are
    // saved directly as Chat docs with userId omitted + isAdmin: true.
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: false },
    handle: { type: String, required: true },
    // Text can be empty when the post is image-only.
    text: { type: String, default: '' },
    // Snapshot of sender avatar at post time so feeds can render
    // without extra user lookups per message.
    avatarImage: { type: String, default: null },
    scope: { type: String, enum: ['local', 'global'], default: 'local' },
    // True only for messages created by POST /admin/broadcast — lets the
    // Reports feed always surface them (see GET /reports below) and lets
    // the frontend give them a distinct "official" look in the chat list.
    isAdmin: { type: Boolean, default: false },
    replyTo: {
        chatId: { type: String },
        handle: { type: String },
        text: { type: String }
    },
    repost: {
        chatId: { type: String },
        handle: { type: String },
        text: { type: String }
    },
    quote: {
        chatId: { type: String },
        handle: { type: String },
        text: { type: String }
    },
    media: {
        kind: { type: String, enum: ['image'] },
        url: { type: String }
    },
    location: { type: String, required: true },
    locationKey: { type: String, required: true },
    // Who has seen this message (excluding the author). Used to show a
    // "seen" indicator on the sender's own bubble — cleared from view
    // client-side (not from this array) once a reply targets the
    // message, so we keep the raw read history here regardless.
    seenBy: { type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }], default: [] },
    createdAt: { type: Date, default: Date.now }
});
// Every existing Chat query is one of these access patterns — indexes
// below just make each of them use an index instead of a collection scan:
//   - GET /chats, GET /admin/chats: sort by createdAt (works for both
//     scope values since it's a prefix-free sort-only index).
//   - GET /reports (community items): Chat.find({ scope: 'local' }) sorted
//     by createdAt.
//   - GET /reports (admin items): Chat.find({ isAdmin: true }) sorted by
//     createdAt.
//   - POST /chats/seen: Chat.updateMany({ _id: { $in }, userId: { $ne } })
//     — covered by the default _id index, no extra index needed there.
//   - POST /chats (reply push), GET /reports (replyChats): lookups by
//     replyTo.chatId.
//   - GET /user/:id (reportCount... actually chatCount via userId).
chatSchema.index({ createdAt: -1 });
chatSchema.index({ scope: 1, createdAt: -1 });
chatSchema.index({ isAdmin: 1, createdAt: -1 });
chatSchema.index({ userId: 1 });
chatSchema.index({ 'replyTo.chatId': 1 });

const lightStatusSchema = new mongoose.Schema({
    locationKey: { type: String, required: true, unique: true },
    status: { type: String, enum: ['on', 'off', 'unknown'], default: 'unknown' },
    reportedBy: { type: String },
    reportedAt: { type: Date, default: Date.now }
});

const lightStatusEventSchema = new mongoose.Schema({
    locationKey: { type: String, required: true },
    status: { type: String, enum: ['on', 'off'], required: true },
    reportedBy: { type: String },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    reportedAt: { type: Date, default: Date.now }
});
// getLightStatusStats() and GET /reports filter+sort by locationKey +
// reportedAt together; GET /admin/reports sorts the whole collection by
// reportedAt; GET /user/:id counts by userId.
lightStatusEventSchema.index({ locationKey: 1, reportedAt: -1 });
lightStatusEventSchema.index({ reportedAt: -1 });
lightStatusEventSchema.index({ userId: 1 });

// Push subscription — one per device, upserted on endpoint
const pushSubscriptionSchema = new mongoose.Schema({
    userId:       { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    location:     { type: String, required: true }, // normalised location key
    text: { type: String, default: '' },
    chatMentionsEnabled: { type: Boolean, default: true },
    // Second location this device wants "status changed" alerts for.
    // null/unset = not watching a second location. Set/cleared from the
    // "Notify me here" toggle on the second-location panel (home.js) via
    // PATCH /subscribe/preferences. Looked up directly by the
    // POST /lightstatus handler whenever a location's status flips.
    secondaryLocationKey:   { type: String, default: null },
    secondaryLocationLabel: { type: String, default: null },
    // 'web'     — browser/PWA subscriber, delivered via web-push (VAPID).
    // 'android' — native app subscriber, delivered via FCM.
    // Kept in the SAME collection (rather than a separate one) so every
    // existing query here (by location, by secondaryLocationKey, by
    // userId) automatically reaches both kinds of subscriber without
    // being duplicated — sendPushToSubscribers() below is what branches
    // per-row on this field.
    platform:     { type: String, enum: ['web', 'android'], default: 'web' },
    // Full browser push subscription object — required for 'web' rows,
    // absent for 'android' rows.
    subscription: { type: Object, required: false },
    // FCM registration token — required for 'android' rows, absent for
    // 'web' rows. A device gets a new token occasionally (app
    // reinstall, data clear, token rotation); re-registering just
    // upserts on this field, same as web-push re-subscribing.
    //
    // NO `default: null` here — that was the bug behind the
    // "E11000 duplicate key ... fcmToken: null" 500s on every 2nd+ web
    // subscriber. `sparse: true` on the index below only excludes
    // documents where the field is genuinely MISSING/undefined — a
    // field explicitly set to `null` (which `default: null` did for
    // every single 'web' row) still counts as a real indexed value, so
    // the second 'web' subscriber to ever sign up collided with the
    // first one's `fcmToken: null`. Leaving the field unset for 'web'
    // rows lets `sparse: true` do what it was actually meant to do.
    fcmToken:     { type: String },
    createdAt:    { type: Date, default: Date.now }
});
// sparse: true on both — a row only ever populates ONE of these two
// identifiers depending on `platform`, and without sparse:true, Mongo
// would treat every row missing a given field as sharing the same
// "null" index value and reject the second insert as a duplicate.
pushSubscriptionSchema.index({ 'subscription.endpoint': 1 }, { unique: true, sparse: true });
pushSubscriptionSchema.index({ fcmToken: 1 }, { unique: true, sparse: true });
// `location` is filtered on every chat/light-status/news push fan-out
// (by far the hottest query on this collection). `secondaryLocationKey`
// backs the second-location watch push. `userId` backs
// /subscribe/preferences and the admin bulk-delete-by-user cascade.
pushSubscriptionSchema.index({ location: 1 });
pushSubscriptionSchema.index({ secondaryLocationKey: 1 });
pushSubscriptionSchema.index({ userId: 1 });

// Lightweight product-analytics events — one document per client-side event.
// Kept intentionally generic (a handful of typed events) rather than a table
// per metric, since the volume here is small (Kumasi-only, per home.js) and
// this lets the admin dashboard derive new breakdowns later without a schema
// change. See getTopSearchedAreas/getReportsPerDay/etc. below for how each
// dashboard metric is computed from these events.
const analyticsEventSchema = new mongoose.Schema({
    type: { type: String, enum: ['search', 'screen_view', 'app_open', 'exit'], required: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    // Anonymous per-device id (localStorage-based) so signed-out activity —
    // and returning-device behavior — can still be counted.
    deviceId: { type: String },
    sessionId: { type: String },
    screen: { type: String },       // e.g. "home", "chat", "reports"
    query: { type: String },        // raw search text, for 'search' events
    locationKey: { type: String },  // normalized location, for 'search' events
    durationMs: { type: Number },   // time spent on `screen`, for 'exit'/'screen_view' events
    createdAt: { type: Date, default: Date.now }
});
analyticsEventSchema.index({ type: 1, createdAt: -1 });
analyticsEventSchema.index({ screen: 1, createdAt: -1 });
analyticsEventSchema.index({ deviceId: 1, createdAt: -1 });

const User             = mongoose.model('User', userSchema);
const Chat             = mongoose.model('Chat', chatSchema);
const LightStatus      = mongoose.model('LightStatus', lightStatusSchema);
const LightStatusEvent = mongoose.model('LightStatusEvent', lightStatusEventSchema);
const PushSubscription = mongoose.model('PushSubscription', pushSubscriptionSchema);
const AnalyticsEvent    = mongoose.model('AnalyticsEvent', analyticsEventSchema);

console.log("MY SERVER FILE IS RUNNING");

// APP / MIDDLEWARE
const app = express();

// compression() gzips every JSON/text response before it goes over the
// wire. This is the single biggest easy win for a JSON API — chat/report/
// news list payloads compress especially well. Placed first so it wraps
// everything after it. `filter` keeps the default behavior (skips
// already-compressed types, honors Cache-Control: no-transform) but also
// respects an `x-no-compression` request header, useful for local
// debugging with curl.
app.use(compression({
    filter: (req, res) => {
        if (req.headers['x-no-compression']) return false;
        return compression.filter(req, res);
    }
}));

app.use(cors());
app.use(express.json());

// Serves frontend files from the frontend folder during development
// In production, copy built frontend files to a 'public' folder or adjust path
// maxAge adds a Cache-Control header so browsers/CDNs stop re-requesting
// unchanged static assets (logo, css, js, service-worker) on every load.
// Purely a response-header change — same files, same routes, same
// content — so it doesn't affect API functionality at all.
app.use(express.static(path.join(__dirname, '../frontend'), {
    maxAge: process.env.NODE_ENV === 'production' ? '1d' : 0,
    etag: true
}));

// Serves assets that live inside the backend itself (e.g. the logo used
// in emails). This is separate from the frontend static folder above —
// the frontend deploys independently to Netlify, so files that only
// live in frontend/ are NOT guaranteed to exist on Render at runtime.
// Put files like dev-logo.png in backend/public/images/ so they're
// always available wherever the backend is deployed.
app.use('/images', express.static(path.join(__dirname, 'public/images'), {
    maxAge: process.env.NODE_ENV === 'production' ? '1d' : 0,
    etag: true
}));

// If a logo file was placed at the backend root (e.g. backend/dev-logo.png),
// serve that single file at /images/dev-logo.png so email templates and
// LOGO_URL point to a hosted asset even when the frontend is deployed
// separately (Netlify). This keeps the rest of the backend's files
// private while exposing only that one image path.
const backendLogoPath = path.join(__dirname, 'dev-logo.png');
if (fs.existsSync(backendLogoPath)) {
    app.get('/images/dev-logo.png', (req, res) => {
        res.sendFile(backendLogoPath);
    });
}

// Set this to your real Render URL (e.g. https://lightwatch-api.onrender.com)
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || 'https://lightwatch-backend.onrender.com';
const LOGO_URL = `${PUBLIC_BASE_URL}/images/dev-logo.png`;

// ---- REQUEST PERFORMANCE LOGGING ----
// Times every request end-to-end and logs method, path, status, and
// duration. Replaces the old "log every non-noisy GET's method+url"
// middleware — this keeps the same noisy-route filtering (so the
// polling endpoints don't flood the logs) but now also reports how long
// each request actually took, which the old version didn't.
// Toggle: set DISABLE_PERF_LOGGING=true on Render (or anywhere) to turn
// this off entirely with zero code changes.
const PERF_LOGGING_ENABLED = process.env.DISABLE_PERF_LOGGING !== 'true';
const NOISY_GET_ROUTES = ['/lightstatus', '/user/', '/chats'];

function isNoisyRequest(req) {
    const isNoisyGet = req.method === 'GET' && NOISY_GET_ROUTES.some(route => req.url.startsWith(route));
    // The typing heartbeat fires every ~2s per active typist in both
    // directions (POST to ping, DELETE to clear) — noisy the same way
    // the GET polls above are, just not a GET.
    const isTypingRoute = req.url.startsWith('/chats/typing');
    return isNoisyGet || isTypingRoute;
}

if (PERF_LOGGING_ENABLED) {
    app.use((req, res, next) => {
        const noisy = isNoisyRequest(req);
        const startedAt = process.hrtime.bigint();

        // 'finish' fires once the response has actually been sent, so this
        // measures true end-to-end handler time (including any awaited DB
        // calls), not just the time to reach this middleware.
        res.on('finish', () => {
            if (noisy) return;
            const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
            console.log(`${req.method} ${req.url} ${res.statusCode} ${durationMs.toFixed(1)}ms`);
        });

        next();
    });
}

// Admin token verification middleware
function verifyAdminToken(req, res, next) {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) {
        return res.status(401).json({ error: "Missing authorization token" });
    }
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        if (decoded.role !== 'admin') {
            return res.status(403).json({ error: "Forbidden" });
        }
        req.admin = decoded;
        next();
    } catch (err) {
        return res.status(401).json({ error: "Invalid token" });
    }
}

// HELPERS
// FIX: this used to be one template — `anon-<word>-<number>` — drawn
// from a single 12-word pool, so with enough users most handles read
// as visibly-the-same-shape ("anon-glow-482", "anon-glow-119", ...).
// Now several independent word pools plus several handle *shapes*, so
// two handles rarely even look like they were built the same way.
const HANDLE_LEFT = [
    'akwa', 'kofi', 'ama', 'esi', 'nana', 'kwame', 'adwoa', 'yaw',
    'solar', 'nova', 'ember', 'echo', 'atlas', 'pixel', 'luma', 'zephyr',
    'breeze', 'mango', 'cocoa', 'kente', 'adinkra', 'harbor', 'cedar', 'onyx',
    'sable', 'lotus', 'mist', 'ripple', 'drift', 'aurora', 'safari', 'tide'
];
const HANDLE_RIGHT = [
    'sparrow', 'falcon', 'otter', 'ibis', 'lynx', 'comet', 'voyager', 'runner',
    'weaver', 'anchor', 'ranger', 'keeper', 'garden', 'grove', 'meadow', 'horizon',
    'ember', 'quartz', 'canyon', 'summit', 'harvest', 'orbit', 'ripple', 'sunrise',
    'moon', 'river', 'coconut', 'baobab', 'palms', 'lagoon', 'thunder', 'bloom'
];
const HANDLE_CONNECTOR = ['', '', '', '-', '_'];

function randomFrom(list) {
    return list[Math.floor(Math.random() * list.length)];
}

function randomNumber(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

// Each shape returns a full candidate handle. Picked at random per
// attempt so the pool of *formats* is as varied as the words feeding
// them, not just one template with different words dropped in.
const HANDLE_SHAPES = [
    () => `${randomFrom(HANDLE_LEFT)}${randomFrom(HANDLE_CONNECTOR)}${randomFrom(HANDLE_RIGHT)}`,
    () => `${randomFrom(HANDLE_RIGHT)}${randomFrom(HANDLE_CONNECTOR)}${randomFrom(HANDLE_LEFT)}`,
    () => `${randomFrom(HANDLE_LEFT)}${randomFrom(HANDLE_RIGHT)}`
];

function sanitizeHandle(raw) {
    return String(raw || '')
        .trim()
        .toLowerCase()
        .replace(/\s+/g, '')
        .replace(/[^a-z0-9_-]/g, '')
        .slice(0, 24);
}

function isValidHandle(handle) {
    return /^[a-z0-9](?:[a-z0-9_-]{1,22}[a-z0-9])$/.test(handle);
}

function sanitizeAvatarImageDataUrl(raw) {
    const value = String(raw || '').trim();
    if (!value) return null;
    if (!/^data:image\/(png|jpe?g|webp);base64,/i.test(value)) return null;
    // Rough cap: ~1.5MB payload as base64 string.
    if (value.length > 2_000_000) return null;
    return value;
}

function sanitizeMediaImageDataUrl(raw) {
    const value = String(raw || '').trim();
    if (!value) return null;
    if (!/^data:image\/(png|jpe?g|webp);base64,/i.test(value)) return null;
    // Smaller cap for in-feed media snapshots.
    if (value.length > 1_200_000) return null;
    return value;
}

async function generateUniqueChatHandle() {
    for (let tries = 0; tries < 200; tries += 1) {
        const handle = sanitizeHandle(randomFrom(HANDLE_SHAPES)());
        const existing = await User.findOne({ chatHandle: new RegExp(`^${escapeRegex(handle)}$`, 'i') }).select('_id').lean();
        if (!existing) return handle;
    }
    // Very unlikely fallback: add a short random suffix.
    while (true) {
        const handle = sanitizeHandle(`${randomFrom(HANDLE_LEFT)}-${randomFrom(HANDLE_RIGHT)}-${Math.random().toString(36).slice(2, 6)}`);
        const existing = await User.findOne({ chatHandle: new RegExp(`^${escapeRegex(handle)}$`, 'i') }).select('_id').lean();
        if (!existing) return handle;
    }
}

function normalizeLocation(value) {
    if (!value) return "";
    return value.toString().trim().toLowerCase().replace(/\s+/g, ' ');
}

function titleCaseLocation(value) {
    if (!value) return 'Unknown';
    return value
        .toString()
        .split(',')[0]
        .trim()
        .split(' ')
        .filter(Boolean)
        .map(word => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ');
}

function escapeRegex(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Same "close enough" rule GET /chats has always used for local scope:
// exact match, or either string containing the other (handles e.g.
// "Bantama, Kumasi" vs "Bantama Market, Kumasi" being treated as the
// same neighborhood). Both inputs should already be normalizeLocation()'d.
function locationsFuzzyMatch(a, b) {
    if (!a || !b) return false;
    return a === b || a.includes(b) || b.includes(a);
}

// ---- TYPING INDICATOR (in-memory only — never touches Mongo) ----
// Chat is polling-based (no sockets), so "typing" is just a fast
// heartbeat: clients POST while they have text in the box, and GET
// to see who else nearby is doing the same right now.
// One Map per scope ('local' / 'global') -> Map<userId, { handle,
// locationKey, lastTypedAt }>. Local-scope reads filter that map down
// with locationsFuzzyMatch() — same rule GET /chats uses — rather than
// keying rooms by exact location, since two accounts can have slightly
// different (but "same neighborhood") location strings that already
// see each other's messages via that fuzzy match.
// Entries are pruned lazily on read/write against TYPING_TTL_MS, so
// nothing needs a background timer to stay clean, and a crashed tab
// (no explicit "stopped typing" call) self-clears within the TTL.
// NOTE: this is process-local. Fine on a single Render instance; if
// this ever scales to multiple instances, it needs Redis instead.
const typingByScope = new Map(); // 'local' | 'global' -> Map<userId, entry>
const TYPING_TTL_MS = 4000;

function getTypingRoom(scope) {
    if (!typingByScope.has(scope)) typingByScope.set(scope, new Map());
    return typingByScope.get(scope);
}

function pruneTypingRoom(room) {
    const cutoff = Date.now() - TYPING_TTL_MS;
    for (const [userId, entry] of room) {
        if (entry.lastTypedAt < cutoff) room.delete(userId);
    }
}

async function getLightStatusStats(locationKey) {
    const events = await LightStatusEvent.find({ locationKey }).sort({ reportedAt: 1 }).lean();
    const now = Date.now();
    const oneWeekAgo = now - 7 * 24 * 60 * 60 * 1000;

    const eventsThisWeek = events.filter(event => event.reportedAt >= oneWeekAgo);
    const onChecksThisWeek = eventsThisWeek.filter(event => event.status === 'on').length;
    const offChecksThisWeek = eventsThisWeek.filter(event => event.status === 'off').length;
    const totalChecks = events.length;
    const uniqueContributors = new Set(events
        .map(event => event.reportedBy)
        .filter(report => report && report !== 'anonymous')
    ).size;

    const outageDurations = [];
    for (let i = 0; i < events.length - 1; i++) {
        if (events[i].status === 'off' && events[i + 1].status === 'on') {
            outageDurations.push(events[i + 1].reportedAt.getTime() - events[i].reportedAt.getTime());
        }
    }

    const avgOutageMs = outageDurations.length > 0
        ? Math.round(outageDurations.reduce((acc, value) => acc + value, 0) / outageDurations.length)
        : null;
    const lastOutageMs = outageDurations.length > 0
        ? outageDurations[outageDurations.length - 1]
        : null;
    const outageFreq = eventsThisWeek.filter(event => event.status === 'off').length;
    const checksThisWeek = eventsThisWeek.length;
    const uptimePercent = checksThisWeek > 0
        ? Math.round((onChecksThisWeek / checksThisWeek) * 100)
        : 0;
    const sameStatePercent = checksThisWeek > 0
        ? Math.round((Math.max(onChecksThisWeek, offChecksThisWeek) / checksThisWeek) * 100)
        : 0;

    return {
        totalChecks,
        uniqueContributors,
        checksThisWeek,
        onChecksThisWeek,
        uptimePercent,
        sourceConfidence: sameStatePercent,
        avgOutageMs,
        lastOutageMs,
        outageFreq
    };
}

// Pending verification store — backed by MongoDB (not in-memory) so it
// survives Render restarts/redeploys and works across multiple instances.
// The TTL index below makes MongoDB auto-delete expired docs on its own.
const pendingVerificationSchema = new mongoose.Schema({
    emailPhone: { type: String, required: true, unique: true },
    type:       { type: String, enum: ['signup', 'signin'], required: true },
    code:       { type: String, required: true },
    attempts:   { type: Number, default: 0 },
    userData:   { type: Object },   // only for type: 'signup'
    userId:     { type: String },   // only for type: 'signin'
    expiresAt:  { type: Date, required: true }
});
pendingVerificationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
const PendingVerification = mongoose.model('PendingVerification', pendingVerificationSchema);

const OTP_LENGTH       = 4;                 // matches the 4-box UI on verification.html
const OTP_EXPIRY_MS    = 10 * 60 * 1000;    // codes are valid for 10 minutes
const OTP_MAX_ATTEMPTS = 5;                 // lock the code after 5 wrong tries

// ── Generate a random numeric code, e.g. "4839" ────────────────
function generateOtpCode(length = OTP_LENGTH) {
    let code = '';  
    for (let i = 0; i < length; i++) {
        code += Math.floor(Math.random() * 10);
    }
    return code;
}

// ── Pull the last name off a full name for a friendlier greeting
// ("Kofi Sarkodie" -> "Sarkodie"). Falls back to '' (caller then
// falls back to "there") if there's nothing usable. ──────────────
function getLastName(fullName) {
    if (!fullName || typeof fullName !== 'string') return '';
    const parts = fullName.trim().split(/\s+/).filter(Boolean);
    return parts.length ? parts[parts.length - 1] : '';
}

// ── Minimal HTML-escaping for the one user-supplied string we ever
// interpolate into the email template (the name). ─────────────────
function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
}

// ── Email sending via Brevo's HTTP API ──────────────────────
// NOT using SMTP here on purpose: Render's free tier blocks all
// outbound traffic on SMTP ports (25, 465, 587) as of Sept 2025,
// so nodemailer/SMTP will always hang and time out on a free
// instance. Brevo's API runs over plain HTTPS (port 443), which
// isn't blocked, so this works on the free tier with no changes
// needed on Render's side.
if (!process.env.BREVO_API_KEY) {
    console.warn("WARNING: BREVO_API_KEY not set. Email OTPs will just be logged to the console instead of sent.");
}

// Builds the branded HTML body for the OTP email. Kept as a plain string
// with inline styles (not classes) because most email clients strip
// <style> blocks and external CSS — inline is the only thing that
// renders consistently across Gmail, Outlook, Apple Mail, etc.
function buildOtpEmailHtml(code, name) {
    const year = new Date().getFullYear();
    const greetingName = escapeHtml(getLastName(name) || 'there');
    return `
<!DOCTYPE html>
<html>
  <body style="margin:0; padding:0; background-color:#f2f4f7; font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f2f4f7; padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="max-width:480px; width:100%; background-color:#ffffff; border-radius:12px; overflow:hidden; box-shadow:0 2px 10px rgba(16,24,40,0.06);">

            <!-- Header -->
            <tr>
              <td align="center" style="background-color:#0a0e1a; padding:32px 24px;">
                <img src="${LOGO_URL}" width="56" height="56" alt="LightWatch" style="display:block; border-radius:14px;" />
                <div style="margin-top:12px; font-size:18px; font-weight:600; color:#ffffff; letter-spacing:0.3px;">
                  LightWatch
                </div>
                <div style="margin-top:4px; font-size:13px; color:#9aa4b8;">
                  Community power outage reports
                </div>
              </td>
            </tr>

            <!-- Body -->
            <tr>
              <td style="padding:32px 32px 8px 32px;">
                <p style="margin:0 0 16px 0; font-size:15px; line-height:1.6; color:#1f2430;">
                  Hi ${greetingName},
                </p>
                <p style="margin:0 0 24px 0; font-size:15px; line-height:1.6; color:#1f2430;">
                  Use the code below to verify your email and finish setting up your LightWatch account.
                </p>
              </td>
            </tr>

            <!-- OTP code -->
            <tr>
              <td align="center" style="padding:0 32px 24px 32px;">
                <p style="margin:0 0 10px 0; font-size:13px; font-weight:600; letter-spacing:0.2px; color:#6b7280; text-transform:uppercase;">Your LightWatch verification code</p>
                <div style="display:inline-block; padding:18px 36px; background:linear-gradient(135deg,#f4c95d,#5b8def); border-radius:10px;">
                  <span style="font-size:38px; font-weight:700; letter-spacing:6px; color:#0a0e1a; font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">${code}</span>
                </div>
                <p style="margin:16px 0 0 0; font-size:13px; color:#6b7280;">
                  This code expires in 10 minutes.
                </p>
              </td>
            </tr>

            <!-- Security note -->
            <tr>
              <td style="padding:0 32px 32px 32px;">
                <p style="margin:0; font-size:13px; line-height:1.6; color:#6b7280; border-top:1px solid #eef0f3; padding-top:20px;">
                  Didn't request this code? You can safely ignore this email — no account changes will be made.
                </p>
              </td>
            </tr>

            <!-- Footer -->
            <tr>
              <td align="center" style="background-color:#f8f9fb; padding:20px 24px;">
                <p style="margin:0; font-size:12px; color:#98a2b3;">
                  © ${year} LightWatch · Real-time power status for your community
                </p>
              </td>
            </tr>

          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

async function sendOtpEmail(email, code, name) {
    if (!process.env.BREVO_API_KEY) {
        console.log(`[DEV MODE — no BREVO_API_KEY set] OTP for ${email} is ${code}`);
        return;
    }
    const response = await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'api-key': process.env.BREVO_API_KEY
        },
        body: JSON.stringify({
            sender: {
                name: 'LightWatch',
                email: process.env.BREVO_SENDER_EMAIL || 'no-reply@lightwatch.app'
            },
            to: [{ email }],
            subject: 'Your LightWatch verification code',
            htmlContent: buildOtpEmailHtml(code, name),
            // Plain-text fallback for clients that block/strip HTML.
            textContent: `Your LightWatch verification code is ${code}. It expires in 10 minutes. If you didn't request this, you can ignore this email.`
        })
    });
    if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Email send failed: ${response.status} ${errText}`);
    }
}

// ── SMS sending via Arkesel (only wired up if ARKESEL_API_KEY is set) ──
// Arkesel works well for Ghanaian numbers specifically. Swap this out
// for Termii/Twilio/etc if you'd rather use a different provider —
// only this one function needs to change.
async function sendOtpSms(phoneNumber, code) {
    if (!process.env.ARKESEL_API_KEY) {
        console.log(`[DEV MODE — no SMS provider configured] OTP for ${phoneNumber} is ${code}`);
        return;
    }
    const response = await fetch('https://sms.arkesel.com/api/v2/sms/send', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'api-key': process.env.ARKESEL_API_KEY
        },
        body: JSON.stringify({
            sender: process.env.ARKESEL_SENDER_ID || 'LightWatch',
            message: `Your LightWatch verification code is ${code}. It expires in 10 minutes.`,
            recipients: [phoneNumber]
        })
    });
    if (!response.ok) {
        const errText = await response.text();
        throw new Error(`SMS send failed: ${response.status} ${errText}`);
    }
}

// ── Picks email vs SMS automatically based on the value's shape ──
async function sendOtp(emailPhone, code, name) {
    const isEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailPhone);
    if (isEmail) {
        await sendOtpEmail(emailPhone, code, name);
    } else {
        await sendOtpSms(emailPhone, code);
    }
}

function maskContact(value) {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    const phoneRegex = /^[0-9]{10}$/;
    if (phoneRegex.test(value)) {
        return "*".repeat(value.length - 2) + value.slice(-2);
    }
    if (emailRegex.test(value)) {
        const parts = value.split("@");
        return parts[0][0] + "****@" + parts[1];
    }
    return value;
}

// ── Reverse geocoding for the signup page's "use my location" button ──
// The browser only ever sends us a lat/lng; the Google Maps API key
// stays server-side. Returns a best-guess city/town name, or null if
// nothing usable came back (caller falls back to manual entry).
async function reverseGeocodeCity(lat, lng) {
    if (!process.env.GOOGLE_MAPS_API_KEY) {
        console.log('[DEV MODE — no GOOGLE_MAPS_API_KEY set] Skipping reverse geocode lookup.');
        return null;
    }

    const url = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}&key=${process.env.GOOGLE_MAPS_API_KEY}`;
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`Geocode request failed: ${response.status}`);
    }

    const data = await response.json();
    if (data.status !== 'OK' || !Array.isArray(data.results) || !data.results.length) {
        return null;
    }

    // Prefer an actual city/town over a broader region — first address
    // component of the first result that matches one of these types,
    // checked in order of specificity.
    const preferredTypes = ['locality', 'postal_town', 'sublocality', 'administrative_area_level_2', 'administrative_area_level_1'];
    for (const type of preferredTypes) {
        for (const result of data.results) {
            const match = (result.address_components || []).find(c => c.types.includes(type));
            if (match) return match.long_name;
        }
    }
    return data.results[0].formatted_address || null;
}

// ---------------------------------------------------------------------------
// ROUTES
// ---------------------------------------------------------------------------

// ---- REVERSE GEOCODE (signup city/town "use my location" button) ----
// Public — this runs before an account exists, so it can't require auth.
app.get('/geocode/reverse', async (req, res) => {
    const lat = parseFloat(req.query.lat);
    const lng = parseFloat(req.query.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        return res.status(400).json({ error: 'lat and lng query params are required' });
    }

    try {
        const city = await reverseGeocodeCity(lat, lng);
        if (!city) {
            return res.status(404).json({ error: 'Could not determine a city for this location' });
        }
        res.json({ city });
    } catch (err) {
        console.error('Reverse geocode error:', err);
        res.status(502).json({ error: 'Location lookup failed' });
    }
});

// ---- SIGN UP ----
app.post('/signup', async (req, res) => {
    console.log("SIGNUP ROUTE HIT");
    const { name, region, city } = req.body;
    const emailPhone = (req.body.emailPhone || "").toLowerCase().trim();

    if (!name || !emailPhone || !region || !city) {
        return res.status(400).json({ error: "Please fill these required fields" });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    const phoneRegex = /^[0-9]{10}$/;

    if (!emailRegex.test(emailPhone) && !phoneRegex.test(emailPhone)) {
        return res.status(400).json({ error: "Invalid email or phone number" });
    }

    try {
        const exists = await User.findOne({ emailPhone }).select('_id').lean();
        if (exists) {
            return res.status(400).json({ error: "Account already exists" });
        }

        const code = isDevLoginContact(emailPhone) ? DEV_LOGIN_CODE : generateOtpCode();

        if (isDevLoginContact(emailPhone)) {
            console.log(`[DEV LOGIN BYPASS] Signup code for ${emailPhone} is ${code} — not actually sent.`);
        } else {
            try {
                await sendOtp(emailPhone, code, name);
            } catch (sendErr) {
                console.error("Failed to send signup OTP:", sendErr.message);
                return res.status(500).json({ error: "Could not send verification code. Please try again." });
            }
        }

        await PendingVerification.findOneAndUpdate(
            { emailPhone },
            {
                type: 'signup',
                code,
                expiresAt: new Date(Date.now() + OTP_EXPIRY_MS),
                attempts: 0,
                userData: { name, emailPhone, region, city }
            },
            { upsert: true, new: true }
        );

        console.log(`Pending signup created for ${emailPhone}`);

        return res.status(200).json({
            emailPhone,
            maskedContact: maskContact(emailPhone)
            // NOTE: the code itself is intentionally NOT included here —
            // it only goes out via the SMS/email send above.
        });
    } catch (err) {
        console.error("Signup error:", err.message);
        return res.status(500).json({ error: "Server error during signup" });
    }
});

// ---- SIGN IN ----
app.post('/signin', async (req, res) => {
    console.log("SIGNIN ROUTE HIT");
    const emailPhone = (req.body.emailPhone || "").toLowerCase().trim();

    try {
        const foundUser = await User.findOne({ emailPhone });

        if (!foundUser) {
            return res.status(400).json({ error: "No account found" });
        }

        if (!foundUser.chatHandle) {
            foundUser.chatHandle = await generateUniqueChatHandle();
            await foundUser.save();
        }

        const code = isDevLoginContact(emailPhone) ? DEV_LOGIN_CODE : generateOtpCode();

        if (isDevLoginContact(emailPhone)) {
            console.log(`[DEV LOGIN BYPASS] Signin code for ${emailPhone} is ${code} — not actually sent.`);
        } else {
            try {
                await sendOtp(emailPhone, code, foundUser.name);
            } catch (sendErr) {
                console.error("Failed to send signin OTP:", sendErr.message);
                return res.status(500).json({ error: "Could not send verification code. Please try again." });
            }
        }

        await PendingVerification.findOneAndUpdate(
            { emailPhone },
            {
                type: 'signin',
                code,
                expiresAt: new Date(Date.now() + OTP_EXPIRY_MS),
                attempts: 0,
                userId: foundUser._id.toString()
            },
            { upsert: true, new: true }
        );

        console.log(`Pending signin created for ${emailPhone}`);

        return res.json({
            userId: foundUser._id.toString(),
            maskedContact: maskContact(foundUser.emailPhone),
            chatHandle: foundUser.chatHandle
            // NOTE: the code itself is intentionally NOT included here —
            // it only goes out via the SMS/email send above.
        });
    } catch (err) {
        console.error("Signin error:", err.message);
        return res.status(500).json({ error: "Server error during signin" });
    }
});

// ---- VERIFY ----
app.post('/verify', async (req, res) => {
    const code = (req.body.code || '').trim();
    const emailPhone = (req.body.emailPhone || "").toLowerCase().trim();
    if (!emailPhone || !code) {
        return res.status(400).json({ error: "Email/phone and code are required" });
    }

    const pending = await PendingVerification.findOne({ emailPhone });
    if (!pending) {
        return res.status(400).json({ error: "No pending verification. Please request a new code." });
    }

    if (Date.now() > pending.expiresAt.getTime()) {
        await PendingVerification.deleteOne({ emailPhone });
        return res.status(400).json({ error: "This code has expired. Please request a new one." });
    }

    if (pending.code !== code) {
        pending.attempts = (pending.attempts || 0) + 1;
        if (pending.attempts >= OTP_MAX_ATTEMPTS) {
            await PendingVerification.deleteOne({ emailPhone });
            return res.status(400).json({ error: "Too many incorrect attempts. Please request a new code." });
        }
        await pending.save();
        return res.status(400).json({ error: "Incorrect code" });
    }

    try {
        let userId;
        let chatHandle;

        if (pending.type === 'signup') {
            const chatHandleValue = await generateUniqueChatHandle();
            const newUser = new User({
                ...pending.userData,
                chatHandle: chatHandleValue
            });
            await newUser.save();
            userId = newUser._id.toString();
            chatHandle = newUser.chatHandle;
            console.log("User saved to MongoDB:", newUser.emailPhone);
        } else if (pending.type === 'signin') {
            const existingUser = await User.findById(pending.userId);
            if (existingUser && !existingUser.chatHandle) {
                existingUser.chatHandle = await generateUniqueChatHandle();
                await existingUser.save();
            }
            userId = pending.userId;
            chatHandle = existingUser?.chatHandle;
        }

        await PendingVerification.deleteOne({ emailPhone });

        return res.json({
            success: true,
            userId,
            maskedContact: maskContact(emailPhone),
            chatHandle
        });
    } catch (err) {
        console.error("Verify error:", err.message);
        return res.status(500).json({ error: "Server error during verification" });
    }
});

// ---- RESEND CODE ----
// Regenerates a fresh code for whatever verification is already pending
// (signup or signin) and sends it again — powers the "Get a new code"
// link on the verification page.
app.post('/resend', async (req, res) => {
    const emailPhone = (req.body.emailPhone || "").toLowerCase().trim();
    if (!emailPhone) {
        return res.status(400).json({ error: "Email/phone is required" });
    }

    const pending = await PendingVerification.findOne({ emailPhone });
    if (!pending) {
        return res.status(400).json({ error: "No pending verification for this contact. Please start again." });
    }

    const code = isDevLoginContact(emailPhone) ? DEV_LOGIN_CODE : generateOtpCode();

    // Same name the original code's email used — from the signup form
    // data still sitting on the pending doc, or looked back up for an
    // existing user signing in.
    let name;
    if (pending.type === 'signup') {
        name = pending.userData?.name;
    } else if (pending.type === 'signin') {
        const existingUser = await User.findById(pending.userId).select('name').lean();
        name = existingUser?.name;
    }

    if (isDevLoginContact(emailPhone)) {
        console.log(`[DEV LOGIN BYPASS] Resent code for ${emailPhone} is ${code} — not actually sent.`);
    } else {
        try {
            await sendOtp(emailPhone, code, name);
        } catch (sendErr) {
            console.error("Failed to resend OTP:", sendErr.message);
            return res.status(500).json({ error: "Could not send verification code. Please try again." });
        }
    }

    pending.code = code;
    pending.expiresAt = new Date(Date.now() + OTP_EXPIRY_MS);
    pending.attempts = 0;
    await pending.save();

    console.log(`Resent code for ${emailPhone}`);
    return res.json({ success: true, maskedContact: maskContact(emailPhone) });
});

// ---- CHATS ----
app.get('/chats', async (req, res) => {
    const location = req.query.location;
    const scope = (req.query.scope || 'local').toString().toLowerCase() === 'global' ? 'global' : 'local';

    try {
        // Was: Chat.find() (no filter) pulling up to 500 docs of BOTH
        // scopes on every call, then filtering scope in JS. This is the
        // single hottest polling route in the app (it's in
        // NOISY_GET_ROUTES), so pushing the scope filter into the query
        // lets it use the existing { scope: 1, createdAt: -1 } index and
        // return only the docs the caller actually wants — same result,
        // less data read from Mongo and sent over the wire every poll.
        // scope === 'global' → exact match. scope === 'local' → { $ne: 'global' }
        // rather than { scope: 'local' }, so this still matches legacy Chat
        // docs saved before the `scope` field existed (undefined scope was
        // always treated as local by the old `(chat.scope || 'local')`
        // fallback) — same result set as before, just filtered in Mongo.
        const scopeQuery = scope === 'global' ? { scope: 'global' } : { scope: { $ne: 'global' } };
        const allChats = await Chat.find(scopeQuery).sort({ createdAt: -1 }).limit(500).lean();

        if (scope === 'global') {
            return res.json(allChats);
        }

        if (location) {
            const normalizedLocation = normalizeLocation(location);
            const filtered = allChats.filter(chat => {
                const chatLoc = normalizeLocation(chat.location || chat.locationKey || '');
                return locationsFuzzyMatch(chatLoc, normalizedLocation);
            });
            return res.json(filtered);
        }

        return res.json(allChats);
    } catch (err) {
        console.error("Get chats error:", err.message);
        return res.status(500).json({ error: "Server error fetching chats" });
    }
});

app.post('/chats', async (req, res) => {
    const { userId, text, location, replyTo, repost, quote, media, scope } = req.body;
    const normalizedScope = (scope || 'local').toString().toLowerCase() === 'global' ? 'global' : 'local';
    const normalizedText = String(text || '').trim();
    const normalizedMedia = sanitizeMediaImageDataUrl(media?.url);
    const hasQuote = Boolean(quote && (quote.chatId || quote.handle || quote.text));
    const hasRepost = Boolean(repost && (repost.chatId || repost.handle || repost.text));
    if (!userId || (!normalizedText && !normalizedMedia && !hasQuote && !hasRepost) || (normalizedScope === 'local' && !location)) {
        return res.status(400).json({ error: "Missing user, content, or location" });
    }

    try {
        const user = await User.findById(userId);
        if (!user) {
            return res.status(400).json({ error: "Invalid user" });
        }

        if (!user.chatHandle) {
            user.chatHandle = await generateUniqueChatHandle();
            await user.save();
        }

        const normalizedLocation = normalizedScope === 'global'
            ? 'global'
            : normalizeLocation(location);
        const savedLocation = normalizedScope === 'global'
            ? 'All areas'
            : location.trim();

        const newChat = new Chat({
            userId,
            handle: user.chatHandle,
            text: normalizedText,
            avatarImage: user.avatarImage || null,
            scope: normalizedScope,
            replyTo: replyTo ? {
                chatId: String(replyTo.chatId || ''),
                handle: String(replyTo.handle || '').slice(0, 80),
                text: String(replyTo.text || '').slice(0, 220)
            } : undefined,
            repost: repost ? {
                chatId: String(repost.chatId || ''),
                handle: String(repost.handle || '').slice(0, 80),
                text: String(repost.text || '').slice(0, 220)
            } : undefined,
            quote: quote ? {
                chatId: String(quote.chatId || ''),
                handle: String(quote.handle || '').slice(0, 80),
                text: String(quote.text || '').slice(0, 220)
            } : undefined,
            media: normalizedMedia ? { kind: 'image', url: normalizedMedia } : undefined,
            location: savedLocation,
            locationKey: normalizedLocation
        });
        const saved = await newChat.save();

        const chatObj = saved.toObject();
        chatObj.userId = chatObj.userId.toString();
        console.log('Chat saved:', { id: chatObj._id.toString(), handle: chatObj.handle, location: chatObj.location });

        // Respond to the client the moment the chat is durably saved.
        // Everything below (who to notify, whether it's a reply/mention,
        // sending the actual pushes) is not needed to answer this request
        // and previously ran BEFORE res.json — meaning every chat send
        // waited on a PushSubscription.find() (+ a User.find() for
        // @mention detection) even though the caller never sees that
        // data. It's moved into a fire-and-forget function below so the
        // response no longer waits on it. Errors are caught internally
        // since there's no request left to report them to.
        res.status(201).json(chatObj);

        (async () => {
            const key = normalizeLocation(saved.location).split(',')[0].trim();
            const isGlobalChat = normalizedScope === 'global';
            const audienceTitle = isGlobalChat ? 'Everyone' : titleCaseLocation(key);
            // Neither of these depends on the other's result — fetch both at
            // the same time instead of sequentially.
            const [replyTargetChat, subscribers] = await Promise.all([
                replyTo?.chatId
                    ? Chat.findById(replyTo.chatId).select('userId handle text').lean()
                    : Promise.resolve(null),
                isGlobalChat
                    ? PushSubscription.find({}).select('userId subscription fcmToken platform chatMentionsEnabled muteGlobalChat').lean()
                    : PushSubscription.find({ location: key }).select('userId subscription fcmToken platform chatMentionsEnabled muteGlobalChat').lean()
            ]);
            console.log(`Sending chat push to ${subscribers.length} subscriber(s) at ${audienceTitle}`);

            const recipientUserIds = [...new Set(
                subscribers
                    .map(sub => sub.userId ? String(sub.userId) : '')
                    .filter(Boolean)
            )];
            const recipientUsers = recipientUserIds.length
                ? await User.find({ _id: { $in: recipientUserIds } }).select('chatHandle').lean()
                : [];
            const handleByUserId = new Map(recipientUsers.map(u => [String(u._id), (u.chatHandle || '').toLowerCase()]));

            const pushPromises = subscribers.map(async sub => {
                if (sub.userId && String(sub.userId) === String(userId)) {
                    return;
                }

                const isReplyForThisUser = Boolean(
                    replyTargetChat?.userId && sub.userId &&
                    String(replyTargetChat.userId) === String(sub.userId)
                );

                const recipientUserId = sub.userId ? String(sub.userId) : '';
                const recipientHandle = handleByUserId.get(recipientUserId) || '';
                const isMentionForThisUser = Boolean(
                    recipientHandle &&
                    new RegExp(`(^|\\W)@?${escapeRegex(recipientHandle)}(?=$|\\W)`, 'i').test(saved.text || '')
                );

                const isPriorityMention = isReplyForThisUser || isMentionForThisUser;
                const mentionsEnabled = sub.chatMentionsEnabled !== false;
                const mutedGlobalChat = sub.muteGlobalChat === true;

                if (isGlobalChat) {
                    if (isPriorityMention) {
                        if (!mentionsEnabled) return;
                    } else if (mutedGlobalChat) {
                        return;
                    }
                }

                const deepLinkParams = new URLSearchParams({
                    chatId: String(saved._id),
                    chatScope: normalizedScope,
                    chatLocation: savedLocation
                });
                if (replyTo?.chatId) {
                    deepLinkParams.set('replyToChatId', String(replyTo.chatId));
                }

                const payload = {
                    title: isPriorityMention
                        ? `Reply in ${audienceTitle}`
                        : `LightWatch chat — ${audienceTitle}`,
                    body: isPriorityMention
                        ? `${saved.handle} replied to your message: ${saved.text}`
                        : `${saved.handle}: ${saved.text}`,
                    url: `/chat?${deepLinkParams.toString()}`,
                    tag: isPriorityMention ? 'chat-reply' : 'chat-message',
                    requireInteraction: true,
                    vibrate: isPriorityMention ? [280, 120, 280] : [240, 120, 240],
                    chatScope: normalizedScope,
                    isReply: isReplyForThisUser,
                    isMention: isMentionForThisUser,
                    tone: 'chat'
                };

                await sendPushToOne(sub, payload);
            });
            await Promise.allSettled(pushPromises);
        })().catch(err => {
            console.error('Post-chat notification error:', err.message);
        });
    } catch (err) {
        console.error("Post chat error:", err.message);
        return res.status(500).json({ error: "Server error saving chat" });
    }
});

// ---- CHAT READ RECEIPTS ----
// Marks a batch of messages as seen by the requesting user. Called by
// the client whenever other people's messages scroll into view. Never
// marks the caller's own messages (a $ne guard, not just client trust)
// and is idempotent via $addToSet, so re-sending the same ids is safe.
app.post('/chats/seen', async (req, res) => {
    const { userId, chatIds } = req.body || {};
    if (!userId || !Array.isArray(chatIds) || chatIds.length === 0) {
        return res.status(400).json({ error: 'Missing userId or chatIds' });
    }

    const validIds = chatIds.filter(id => mongoose.Types.ObjectId.isValid(id));
    if (!validIds.length) {
        return res.json({ updated: 0 });
    }

    try {
        const result = await Chat.updateMany(
            { _id: { $in: validIds }, userId: { $ne: userId } },
            { $addToSet: { seenBy: userId } }
        );
        return res.json({ updated: result.modifiedCount ?? 0 });
    } catch (err) {
        console.error('Mark chats seen error:', err.message);
        return res.status(500).json({ error: 'Server error marking chats seen' });
    }
});

// ---- CHAT TYPING INDICATOR ----
// POST: "I'm typing" heartbeat, sent every ~2s while there's unsent
// text in the box. DELETE: "I stopped" (send/blur/cleared input) so
// the indicator can disappear immediately instead of waiting out the
// TTL. GET: who's currently typing in this room, excluding yourself.
app.post('/chats/typing', (req, res) => {
    const { userId, handle, scope, location } = req.body || {};
    const normalizedScope = (scope || 'local').toString().toLowerCase() === 'global' ? 'global' : 'local';
    if (!userId || !handle || (normalizedScope === 'local' && !location)) {
        return res.status(400).json({ error: "Missing user, handle, or location" });
    }

    const room = getTypingRoom(normalizedScope);
    room.set(String(userId), {
        handle: String(handle).slice(0, 40),
        locationKey: normalizedScope === 'global' ? 'global' : normalizeLocation(location),
        lastTypedAt: Date.now()
    });

    return res.status(204).end();
});

app.delete('/chats/typing', (req, res) => {
    const { userId, scope } = req.body || {};
    const normalizedScope = (scope || 'local').toString().toLowerCase() === 'global' ? 'global' : 'local';
    getTypingRoom(normalizedScope).delete(String(userId || ''));
    return res.status(204).end();
});

app.get('/chats/typing', (req, res) => {
    const { userId, scope, location } = req.query;
    const normalizedScope = (scope || 'local').toString().toLowerCase() === 'global' ? 'global' : 'local';
    if (normalizedScope === 'local' && !location) {
        return res.json([]);
    }

    const room = getTypingRoom(normalizedScope);
    pruneTypingRoom(room);

    const normalizedLocation = normalizedScope === 'global' ? 'global' : normalizeLocation(location);

    const typers = [...room.entries()]
        .filter(([id]) => id !== String(userId || ''))
        .filter(([, entry]) =>
            normalizedScope === 'global' || locationsFuzzyMatch(entry.locationKey, normalizedLocation)
        )
        .sort((a, b) => a[1].lastTypedAt - b[1].lastTypedAt)
        .map(([id, entry]) => ({ userId: id, handle: entry.handle }));

    return res.json(typers);
});

// ---- ANALYTICS: track a client-side event (public, best-effort) ----
// Called from the app via sendBeacon/fetch — see analytics.js. Never blocks
// or errors loudly on the client's behalf; a dropped analytics event should
// never affect the actual product experience.
const ANALYTICS_EVENT_TYPES = ['search', 'screen_view', 'app_open', 'exit'];
app.post('/analytics/track', async (req, res) => {
    try {
        const { type, userId, deviceId, sessionId, screen, query, locationKey, durationMs } = req.body || {};

        if (!ANALYTICS_EVENT_TYPES.includes(type)) {
            return res.status(400).json({ error: 'Invalid event type' });
        }

        const doc = { type };
        if (screen) doc.screen = String(screen).slice(0, 60);
        if (query) doc.query = String(query).slice(0, 140);
        if (locationKey) doc.locationKey = normalizeLocation(locationKey).split(',')[0].trim();
        if (deviceId) doc.deviceId = String(deviceId).slice(0, 80);
        if (sessionId) doc.sessionId = String(sessionId).slice(0, 80);
        if (typeof durationMs === 'number' && durationMs >= 0 && durationMs < 6 * 60 * 60 * 1000) {
            doc.durationMs = Math.round(durationMs);
        }
        if (userId && mongoose.Types.ObjectId.isValid(userId)) doc.userId = userId;

        await AnalyticsEvent.create(doc);
        return res.status(204).end();
    } catch (err) {
        console.error('Analytics track error:', err.message);
        // Still 204 — a broken analytics call should never surface as an
        // error to the client or retry-loop.
        return res.status(204).end();
    }
});

// ---- ADMIN LOGIN (single password, checked against ADMIN_PASSWORD) ----
// In-memory lockout so the password can't just be brute-forced straight
// through — resets on server restart, which is fine here since this only
// protects the admin console, not user accounts.
let adminLoginAttempts = 0;
let adminLockedUntil = 0;
const ADMIN_MAX_ATTEMPTS = 5;
const ADMIN_LOCKOUT_MS = 10 * 60 * 1000;

function adminLockoutRemaining() {
    return Math.max(0, adminLockedUntil - Date.now());
}

// Single-step: verify the password and issue the admin JWT.
app.post('/admin/login', (req, res) => {
    const password = (req.body.password || '').trim();

    if (adminLockoutRemaining() > 0) {
        return res.status(429).json({ error: `Too many attempts. Try again in ${Math.ceil(adminLockoutRemaining() / 60000)}m.` });
    }

    if (!password || password !== ADMIN_PASSWORD) {
        adminLoginAttempts += 1;
        if (adminLoginAttempts >= ADMIN_MAX_ATTEMPTS) {
            adminLockedUntil = Date.now() + ADMIN_LOCKOUT_MS;
            adminLoginAttempts = 0;
            return res.status(429).json({ error: 'Too many incorrect attempts. Locked for 10 minutes.' });
        }
        return res.status(401).json({ error: 'Incorrect password' });
    }

    adminLoginAttempts = 0;
    const token = jwt.sign({ role: 'admin' }, JWT_SECRET, { expiresIn: '24h' });
    return res.json({ token });
});

// ---- ADMIN: Recent chats (protected) ----
app.get('/admin/chats', verifyAdminToken, async (req, res) => {
    try {
        const recent = await Chat.find().sort({ createdAt: -1 }).limit(100).populate('userId', 'name emailPhone chatHandle').lean();
        return res.json(recent);
    } catch (err) {
        console.error('Admin chats error:', err.message);
        return res.status(500).json({ error: 'Server error fetching admin chats' });
    }
});

// ---- ADMIN: All users (protected) ----
app.get('/admin/users', verifyAdminToken, async (req, res) => {
    try {
        const users = await User.find().sort({ createdAt: -1 }).select('name emailPhone region city chatHandle createdAt').lean();
        return res.json(users);
    } catch (err) {
        console.error('Admin users error:', err.message);
        return res.status(500).json({ error: 'Server error fetching users' });
    }
});

// ---- ADMIN: Delete chats (single or bulk) ----
app.delete('/admin/chats', verifyAdminToken, async (req, res) => {
    try {
        const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
        const validIds = ids.filter(id => mongoose.Types.ObjectId.isValid(id));

        if (validIds.length === 0) {
            return res.status(400).json({ error: 'No valid chat ids provided' });
        }

        const result = await Chat.deleteMany({ _id: { $in: validIds } });
        return res.json({ deletedCount: result.deletedCount || 0 });
    } catch (err) {
        console.error('Admin delete chats error:', err.message);
        return res.status(500).json({ error: 'Server error deleting chats' });
    }
});

// ---- ADMIN: Delete users (single or bulk) ----
app.delete('/admin/users', verifyAdminToken, async (req, res) => {
    try {
        const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
        const validIds = ids.filter(id => mongoose.Types.ObjectId.isValid(id));

        if (validIds.length === 0) {
            return res.status(400).json({ error: 'No valid user ids provided' });
        }

        const [usersResult, chatsResult, eventsResult, subsResult] = await Promise.all([
            User.deleteMany({ _id: { $in: validIds } }),
            Chat.deleteMany({ userId: { $in: validIds } }),
            LightStatusEvent.deleteMany({ userId: { $in: validIds } }),
            PushSubscription.deleteMany({ userId: { $in: validIds } })
        ]);

        return res.json({
            deletedUsers: usersResult.deletedCount || 0,
            deletedChats: chatsResult.deletedCount || 0,
            deletedEvents: eventsResult.deletedCount || 0,
            deletedSubscriptions: subsResult.deletedCount || 0
        });
    } catch (err) {
        console.error('Admin delete users error:', err.message);
        return res.status(500).json({ error: 'Server error deleting users' });
    }
});

// ---- ADMIN: Clear all light status reports (protected) ----
app.get('/admin/reports', verifyAdminToken, async (req, res) => {
    try {
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 200);
        const events = await LightStatusEvent.find().sort({ reportedAt: -1 }).limit(limit).lean();

        function titleCaseLocation(key) {
            return (key || 'unknown').split(',')[0]
                .split(' ')
                .map(word => word.charAt(0).toUpperCase() + word.slice(1))
                .join(' ');
        }

        const reports = events.map(event => {
            const locationName = titleCaseLocation(event.locationKey);
            const reporter = event.reportedBy === 'anonymous' ? 'A volunteer' : (event.reportedBy || 'A resident');
            const isOn = event.status === 'on';
            return {
                id: event._id,
                userId: event.userId ? event.userId.toString() : null,
                status: event.status,
                location: locationName,
                title: isOn ? `Light restored - ${locationName}` : `Outage reported - ${locationName}`,
                text: isOn
                    ? `${reporter} confirmed power is back on in ${locationName}.`
                    : `${reporter} reported the light is off in ${locationName}.`,
                reportedAt: event.reportedAt,
                type: isOn ? 'success' : 'warning'
            };
        });

        return res.json(reports);
    } catch (err) {
        console.error('Admin reports error:', err.message);
        return res.status(500).json({ error: 'Server error fetching reports' });
    }
});

app.delete('/admin/reports', verifyAdminToken, async (req, res) => {
    try {
        const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
        const validIds = ids.filter(id => mongoose.Types.ObjectId.isValid(id));

        const result = validIds.length > 0
            ? await LightStatusEvent.deleteMany({ _id: { $in: validIds } })
            : await LightStatusEvent.deleteMany({});

        return res.json({ deletedCount: result.deletedCount || 0 });
    } catch (err) {
        console.error('Admin clear reports error:', err.message);
        return res.status(500).json({ error: 'Server error clearing reports' });
    }
});

// ---- ADMIN: Summary stats (protected) ----
app.get('/admin/summary', verifyAdminToken, async (req, res) => {
    try {
        const now = new Date();
        const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

        // These four counts don't depend on each other — run them
        // concurrently instead of one at a time.
        const [userCount, newUsers24h, chatCount, newChats24h] = await Promise.all([
            User.countDocuments(),
            User.countDocuments({ createdAt: { $gte: oneDayAgo } }),
            Chat.countDocuments(),
            Chat.countDocuments({ createdAt: { $gte: oneDayAgo } })
        ]);

        // Real "active locations" count — union of everywhere a status has
        // been set, chatted about, or lived in, computed server-side.
        // (Previously the dashboard derived this only from whatever chats
        // happened to be loaded client-side, which undercounts locations
        // that have a status but no chat activity yet.)
        const [statusLocationKeys, chatLocationKeys, userCities] = await Promise.all([
            LightStatus.distinct('locationKey'),
            Chat.distinct('locationKey'),
            User.distinct('city')
        ]);
        const locationSet = new Set([
            ...statusLocationKeys,
            ...chatLocationKeys,
            ...userCities.map(c => normalizeLocation(c).split(',')[0].trim())
        ].filter(Boolean));

        return res.json({ userCount, newUsers24h, chatCount, newChats24h, locationsTracked: locationSet.size });
    } catch (err) {
        console.error('Admin summary error:', err.message);
        return res.status(500).json({ error: 'Server error fetching summary' });
    }
});

// ---- ANALYTICS HELPERS ----
// Small, dependency-free aggregation over AnalyticsEvent + LightStatusEvent.
// These pull the relevant window into memory and reduce in JS rather than
// leaning entirely on Mongo pipelines — simple to read and plenty fast at
// LightWatch's current (Kumasi-only) scale. If this ever needs to run over
// months of data, the day-bucketing here is the part to move into a
// pre-aggregated rollup collection instead.

function dayKey(date) {
    return new Date(date).toISOString().slice(0, 10); // "YYYY-MM-DD", UTC
}

function buildEmptyDaySeries(since, days, extraKeys = []) {
    const series = [];
    for (let i = 0; i < days; i++) {
        const d = new Date(since.getTime() + i * 86400000);
        const row = { date: dayKey(d) };
        extraKeys.forEach(k => { row[k] = 0; });
        series.push(row);
    }
    return series;
}

async function getTopSearchedAreas(since, limit = 10) {
    const results = await AnalyticsEvent.aggregate([
        { $match: { type: 'search', createdAt: { $gte: since } } },
        { $project: { area: { $ifNull: ['$locationKey', '$query'] } } },
        { $match: { area: { $ne: null } } },
        { $group: { _id: '$area', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: limit }
    ]);
    return results.map(r => ({ location: titleCaseLocation(r._id), count: r.count }));
}

async function getReportsPerDay(since, days) {
    const events = await LightStatusEvent.find({ reportedAt: { $gte: since } }).select('reportedAt').lean();
    const series = buildEmptyDaySeries(since, days, ['count']);
    const byDay = new Map(series.map(row => [row.date, row]));
    events.forEach(e => {
        const row = byDay.get(dayKey(e.reportedAt));
        if (row) row.count += 1;
    });
    return series;
}

async function getDailyReturningUsers(since, days) {
    // Look back further than the requested window so "returning" can be
    // judged against real history, not just the first day shown.
    const lookbackStart = new Date(since.getTime() - 60 * 24 * 60 * 60 * 1000);
    const events = await AnalyticsEvent.find({
        type: { $in: ['app_open', 'screen_view'] },
        createdAt: { $gte: lookbackStart }
    }).select('userId deviceId createdAt').lean();

    const actorFirstSeenDay = new Map(); // actor -> earliest day string seen in lookback
    const dayToActors = new Map();       // day string -> Set(actor)

    events.forEach(e => {
        const actor = e.userId ? String(e.userId) : (e.deviceId || null);
        if (!actor) return;
        const day = dayKey(e.createdAt);
        if (!actorFirstSeenDay.has(actor) || day < actorFirstSeenDay.get(actor)) {
            actorFirstSeenDay.set(actor, day);
        }
        if (!dayToActors.has(day)) dayToActors.set(day, new Set());
        dayToActors.get(day).add(actor);
    });

    const series = buildEmptyDaySeries(since, days, ['new', 'returning', 'total']);
    series.forEach(row => {
        const actorsToday = dayToActors.get(row.date) || new Set();
        actorsToday.forEach(actor => {
            if (actorFirstSeenDay.get(actor) === row.date) row.new += 1;
            else row.returning += 1;
        });
        row.total = actorsToday.size;
    });
    return series;
}

async function getScreenTimeStats(since) {
    const results = await AnalyticsEvent.aggregate([
        { $match: { type: 'screen_view', createdAt: { $gte: since }, durationMs: { $exists: true, $gt: 0 } } },
        { $group: { _id: '$screen', avgDurationMs: { $avg: '$durationMs' }, views: { $sum: 1 } } },
        { $match: { _id: { $ne: null } } },
        { $sort: { avgDurationMs: -1 } }
    ]);
    return results.map(r => ({
        screen: r._id,
        avgSeconds: Math.round((r.avgDurationMs / 1000) * 10) / 10,
        views: r.views
    }));
}

async function getDropOffScreens(since, limit = 8) {
    // Relies on the client firing an 'exit' event with the current screen
    // right before the tab/app closes (see analytics.js). Comes back empty
    // until a page is wired up to send that event.
    const results = await AnalyticsEvent.aggregate([
        { $match: { type: 'exit', createdAt: { $gte: since }, screen: { $exists: true, $ne: null } } },
        { $group: { _id: '$screen', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: limit }
    ]);
    const total = results.reduce((sum, r) => sum + r.count, 0) || 1;
    return results.map(r => ({ screen: r._id, count: r.count, pct: Math.round((r.count / total) * 1000) / 10 }));
}

// ---- ADMIN: Analytics overview (protected) ----
app.get('/admin/analytics/overview', verifyAdminToken, async (req, res) => {
    try {
        const days = Math.min(Math.max(parseInt(req.query.days, 10) || 14, 1), 60);
        const since = new Date();
        since.setUTCHours(0, 0, 0, 0);
        since.setUTCDate(since.getUTCDate() - (days - 1));

        const [topSearchedAreas, reportsPerDay, dailyReturningUsers, screenTime, dropOff] = await Promise.all([
            getTopSearchedAreas(since, 10),
            getReportsPerDay(since, days),
            getDailyReturningUsers(since, days),
            getScreenTimeStats(since),
            getDropOffScreens(since, 8)
        ]);

        return res.json({
            rangeDays: days,
            topSearchedAreas,
            reportsPerDay,
            dailyReturningUsers,
            screenTime,
            dropOff
        });
    } catch (err) {
        console.error('Admin analytics overview error:', err.message);
        return res.status(500).json({ error: 'Server error building analytics overview' });
    }
});

// ---- PUBLIC STATS ----
// Just a headline number for the sign-in page ("N registered users") —
// intentionally public and minimal, no auth needed since it reveals
// nothing except a count. (Separate from /admin/summary above, which
// requires an admin token and returns more detail.)
app.get('/stats', async (req, res) => {
    try {
        const userCount = await User.countDocuments();
        return res.json({ userCount });
    } catch (err) {
        console.error("Stats error:", err.message);
        return res.status(500).json({ error: "Could not load stats" });
    }
});

// ---- USER LOOKUP ----
app.get('/user/:id', async (req, res) => {
    const { id } = req.params;

    try {
        const user = await User.findById(id);

        if (!user) {
            return res.status(404).json({ error: "User not found" });
        }

        if (!user.chatHandle) {
            user.chatHandle = await generateUniqueChatHandle();
            await user.save();
        }

        const [chatCount, reportCount] = await Promise.all([
            Chat.countDocuments({ userId: user._id }),
            LightStatusEvent.countDocuments({ userId: user._id })
        ]);
        const userObj = user.toObject();
        userObj.chatCount = chatCount;
        userObj.reportCount = reportCount;

        return res.json(userObj);
    } catch (err) {
        console.error("User lookup error:", err.message);
        return res.status(404).json({ error: "User not found" });
    }
});

// ---- LIGHT STATUS ----

// GET /lightstatus?location=Bantama%2C+Ashanti
app.get('/lightstatus', async (req, res) => {
    const location = req.query.location;
    if (!location) return res.status(400).json({ error: 'location required' });
    try {
        const key = normalizeLocation(location).split(',')[0].trim();
        const keyTitle = titleCaseLocation(key);
        // record (current status) and stats (historical aggregation) are
        // independent reads — fetch them concurrently.
        const [record, stats] = await Promise.all([
            LightStatus.findOne({ locationKey: key }).lean(),
            getLightStatusStats(key)
        ]);
        return res.json({
            locationKey: key,
            status: record?.status || 'unknown',
            reportedBy: record?.reportedBy || null,
            reportedAt: record?.reportedAt || null,
            stats
        });
    } catch (err) {
        return res.status(500).json({ error: 'Server error' });
    }
});

// GET /areas/known — real towns/cities the app actually has data for
// (either someone signed up with that city, or a light status was ever
// reported there), instead of a fixed, hardcoded neighborhood list.
// Location.js's "Nearby Locations" panel and map pins use this to figure
// out which other areas to show alongside the signed-in user's own city,
// so newly added towns show up automatically instead of only the
// original hardcoded Kumasi set.
app.get('/areas/known', async (req, res) => {
    try {
        const [userCities, statusKeys] = await Promise.all([
            User.distinct('city'),
            LightStatus.distinct('locationKey')
        ]);
        const seen = new Map(); // normalized -> title-cased display name
        [...userCities, ...statusKeys].forEach(raw => {
            const normalized = normalizeLocation(raw).split(',')[0].trim();
            if (!normalized || normalized === 'global') return;
            if (!seen.has(normalized)) seen.set(normalized, titleCaseLocation(normalized));
        });
        return res.json({ areas: Array.from(seen.values()).sort((a, b) => a.localeCompare(b)) });
    } catch (err) {
        console.error('Known-areas lookup error:', err.message);
        return res.status(500).json({ error: 'Server error' });
    }
});

app.get('/reports', async (req, res) => {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 30, 1), 100);

    // Optional scoping — both additive, existing callers with no query
    // params keep getting the same global feed as before.
    const query = {};
    if (req.query.location) {
        query.locationKey = normalizeLocation(req.query.location).split(',')[0].trim();
    }
    // NOTE: deliberately not filtering LightStatusEvent by userId here.
    // userId is only relevant to the community/reply block below (which
    // has its own requestingUserId check) — an outage/restoration event
    // reported by someone else at your location is exactly what this
    // feed is supposed to surface. Filtering by userId here silently
    // hid every event you didn't report yourself, even at your own
    // location, even though the push notification for it still went
    // out correctly.

    // Opt-in only (?includeCommunity=1) — the Reports page passes this;
    // other existing callers (e.g. home.js's compact recentReportsList)
    // don't, and keep getting exactly the LightStatusEvent-only feed
    // they always have.
    const includeCommunity = ['1', 'true'].includes(String(req.query.includeCommunity || '').toLowerCase());

    function titleCaseLocation(key) {
        return key.split(',')[0]
            .split(' ')
            .map(word => word.charAt(0).toUpperCase() + word.slice(1))
            .join(' ');
    }

    // ── Community-report additions ──────────────────────────────────
    // Two kinds of chat activity belong in a user's report feed
    // alongside their light-status events:
    //   1. Other people's local-scope messages posted in the user's
    //      OWN location (fuzzy-matched the same way GET /chats
    //      matches a room), and
    //   2. Replies — from anyone, in any room — to a message THIS
    //      user posted, since a reply is relevant to them regardless
    //      of which location it happened in.
    // Both require userId (there's no "user's own location/messages"
    // without one), so this whole block is skipped if it's missing
    // even when includeCommunity=1 was passed.
    async function loadCommunityItems() {
        if (!(includeCommunity && req.query.userId)) return [];

        const requestingUserId = req.query.userId;
        const normalizedLocation = req.query.location ? normalizeLocation(req.query.location) : null;

        const [candidateLocationChats, ownChats] = await Promise.all([
            normalizedLocation
                ? Chat.find({ scope: 'local' }).sort({ createdAt: -1 }).limit(200).lean()
                : Promise.resolve([]),
            Chat.find({ userId: requestingUserId }).select('_id').lean()
        ]);

        const ownChatIdSet = new Set(ownChats.map(c => String(c._id)));

        const matchedLocationChats = normalizedLocation
            ? candidateLocationChats
                .filter(chat => {
                    if (String(chat.userId) === String(requestingUserId)) return false;
                    const chatLoc = normalizeLocation(chat.location || chat.locationKey || '');
                    return locationsFuzzyMatch(chatLoc, normalizedLocation);
                })
                .slice(0, limit)
            : [];

        const replyChats = ownChatIdSet.size
            ? await Chat.find({
                'replyTo.chatId': { $in: [...ownChatIdSet] },
                userId: { $ne: requestingUserId }
            }).sort({ createdAt: -1 }).limit(limit).lean()
            : [];

        const usedChatIds = new Set();
        const locationItems = matchedLocationChats.map(chat => {
            usedChatIds.add(String(chat._id));
            const locName = titleCaseLocation(normalizeLocation(chat.location || chat.locationKey || 'unknown'));
            return {
                id: `chat-${chat._id}`,
                location: locName,
                title: `New message in ${locName}`,
                text: `${chat.handle}: ${chat.text}`.slice(0, 220),
                reportedAt: chat.createdAt,
                type: 'chat',
                chatId: String(chat._id),
                chatScope: chat.scope || 'local',
                chatLocation: chat.location
            };
        });

        // A message can be both "in the user's location" AND "a reply
        // to them" — don't show it twice; the reply framing wins since
        // it's the more specific/relevant one.
        const replyItems = replyChats
            .filter(chat => !usedChatIds.has(String(chat._id)))
            .map(chat => ({
                id: `reply-${chat._id}`,
                location: titleCaseLocation(normalizeLocation(chat.location || chat.locationKey || 'unknown')),
                title: `${chat.handle} replied to your message`,
                text: chat.text.slice(0, 220),
                reportedAt: chat.createdAt,
                type: 'reply',
                chatId: String(chat._id),
                chatScope: chat.scope || 'local',
                chatLocation: chat.location,
                replyToChatId: chat.replyTo?.chatId || null
            }));

        return [...locationItems, ...replyItems];
    }

    try {
        // These three groups (light-status events, community chat items,
        // admin broadcasts) are entirely independent of each other — fetch
        // them concurrently instead of one after another.
        const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        const [events, communityItems, adminChats] = await Promise.all([
            LightStatusEvent.find(query).sort({ reportedAt: -1 }).limit(limit).lean(),
            loadCommunityItems(),
            // ── Admin broadcasts ────────────────────────────────────
            // Unlike community items, these are NOT gated behind
            // includeCommunity/userId/location — an admin broadcast (see
            // POST /admin/broadcast) is meant for every viewer of the
            // Reports feed, the same way a LightStatusEvent is.
            // Recent-only (7 days) so this can't grow into an unbounded
            // always-fetched list.
            Chat.find({ isAdmin: true, createdAt: { $gte: sevenDaysAgo } })
                .sort({ createdAt: -1 })
                .limit(20)
                .lean()
        ]);

        const reports = events.map(event => {
            const locationName = titleCaseLocation(event.locationKey || 'unknown');
            const reporter = event.reportedBy === 'anonymous' ? 'A volunteer' : event.reportedBy;
            const isOn = event.status === 'on';
            return {
                id: event._id,
                userId: event.userId ? event.userId.toString() : null,
                status: event.status,
                location: locationName,
                title: isOn ? `Light restored — ${locationName}` : `Outage reported — ${locationName}`,
                text: isOn
                    ? `${reporter} confirmed power is back on in ${locationName}.`
                    : `${reporter} reported the light is off in ${locationName}.`,
                reportedAt: event.reportedAt,
                type: isOn ? 'success' : 'warning'
            };
        });

        const adminItems = adminChats.map(chat => ({
            id: `admin-${chat._id}`,
            title: `📢 ${chat.handle || 'LightWatch Admin'}`,
            text: chat.text,
            reportedAt: chat.createdAt,
            type: 'admin',
            chatId: String(chat._id),
            chatScope: chat.scope || 'global',
            chatLocation: chat.location
        }));

        const merged = [...reports, ...communityItems, ...adminItems]
            .sort((a, b) => new Date(b.reportedAt) - new Date(a.reportedAt))
            .slice(0, limit);

        return res.json(merged);
    } catch (err) {
        console.error('Reports fetch error:', err.message);
        return res.status(500).json({ error: 'Server error fetching reports' });
    }
});

// ── Unified push sender — web-push (VAPID) for platform:'web' rows,
//    FCM for platform:'android' rows. Every existing call site that
//    used to call webpush.sendNotification(sub.subscription, payload)
//    directly now goes through this instead, so every push (chat,
//    status change, secondary-location, admin test/broadcast) reaches
//    both browser and native subscribers without duplicating the
//    platform-branch logic five times.
//
//    `notification` is a plain object: { title, body, url, tag,
//    requireInteraction, vibrate, status, tone }. Web-push gets the
//    whole thing JSON-stringified as-is (service-worker.js already
//    expects exactly that shape). FCM's `data` payload must be
//    flat string values only, so everything gets String()-coerced;
//    `notification.title`/`body` also go in FCM's native `notification`
//    block so Android shows a real system notification automatically
//    even while the app is backgrounded or killed — data fields ride
//    along for when the app is in the foreground and
//    notification.js's pushNotificationReceived listener wants them.
async function sendPushToSubscribers(subscribers, notification) {
    const results = await Promise.allSettled(subscribers.map(sub => sendPushToOne(sub, notification)));
    return results;
}

async function sendPushToOne(sub, notification) {
    if (sub.platform === 'android') {
        return sendFcmToOne(sub, notification);
    }
    return sendWebPushToOne(sub, notification);
}

async function sendWebPushToOne(sub, notification) {
    try {
        await webpush.sendNotification(sub.subscription, JSON.stringify(notification), {
            urgency: 'high',
            TTL: 60
        });
        return { ok: true };
    } catch (err) {
        if (err.statusCode === 410) {
            await PushSubscription.deleteOne({ _id: sub._id });
            console.log('Removed stale web-push subscription:', sub._id);
            return { ok: false, stale: true };
        }
        console.error('Web-push send error:', err.statusCode, err.body, err.message);
        return { ok: false, statusCode: err.statusCode || 500 };
    }
}

async function sendFcmToOne(sub, notification) {
    if (!fcmEnabled) return { ok: false, statusCode: 503 };
    if (!sub.fcmToken) return { ok: false, statusCode: 400 };

    // Maps to the channels created natively in MainActivity.java
    // (createNotificationChannels()) — each one has its own custom
    // sound baked in at creation time, so this is what makes a
    // power-on push actually ring differently from a power-off push
    // or a chat push, instead of Android's single default tone.
    // `sound` (the raw resource name, no extension) is the fallback
    // for Android <8 devices, which have no channel system at all —
    // channelId is silently ignored there and this is what applies
    // instead.
    let soundResource = 'lw_chat';
    if (notification.tone === 'power-on') soundResource = 'lw_power_on';
    else if (notification.tone === 'power-off') soundResource = 'lw_power_off';
    else if (notification.tone === 'chat') soundResource = 'lw_chat';
    const channelId = soundResource; // channel IDs in MainActivity.java match these 1:1

    try {
        await admin.messaging().send({
            token: sub.fcmToken,
            notification: {
                title: notification.title,
                body: notification.body
            },
            data: Object.fromEntries(
                Object.entries(notification)
                    .filter(([, v]) => v !== undefined && v !== null)
                    .map(([k, v]) => [k, Array.isArray(v) ? JSON.stringify(v) : String(v)])
            ),
            android: {
                priority: 'high',
                notification: {
                    tag: notification.tag || undefined,
                    channelId,
                    sound: soundResource
                }
            }
        });
        return { ok: true };
    } catch (err) {
        // Token is no longer valid (app uninstalled, data cleared, etc.)
        // — same cleanup role the web-push 410 branch plays above.
        if (err.code === 'messaging/registration-token-not-registered' ||
            err.code === 'messaging/invalid-registration-token') {
            await PushSubscription.deleteOne({ _id: sub._id });
            console.log('Removed stale FCM token:', sub._id);
            return { ok: false, stale: true };
        }
        console.error('FCM send error:', err.code || err.message);
        return { ok: false, statusCode: 500 };
    }
}

// ── Shared core of a light-status change: upsert LightStatus, log a
// LightStatusEvent, and push to every subscriber — used identically by
// the public user-report route below AND the admin push route, so an
// admin-set status shows up on users' home pages (poll + push) exactly
// the same way a real user report does. `reportedByOverride` lets the
// admin route label events as "LightWatch Admin" instead of a handle. ──
async function applyLightStatusUpdate(rawLocation, status, { userId = null, reportedByOverride = null } = {}) {
    const key = normalizeLocation(rawLocation).split(',')[0].trim();
    const keyTitle = titleCaseLocation(key);

    // The reporter's chatHandle lookup and the "what was the status
    // before this update" lookup don't depend on each other — fetch both
    // concurrently instead of waiting on one before starting the other.
    // (Captured before the upsert so we can tell whether this report
    // actually *changed* the status, vs. just re-confirming the same
    // one — secondary-location watchers should only be pinged on a
    // real flip, not on every single report.)
    const [user, previous] = await Promise.all([
        (!reportedByOverride && userId) ? User.findById(userId).select('chatHandle').lean() : Promise.resolve(null),
        LightStatus.findOne({ locationKey: key }).select('status').lean()
    ]);

    let reportedBy = reportedByOverride;
    if (!reportedBy) {
        reportedBy = user?.chatHandle || userId || 'anonymous';
    }

    const previousStatus = previous?.status || null;
    const statusChanged = previousStatus !== null && previousStatus !== status;

    const record = await LightStatus.findOneAndUpdate(
        { locationKey: key },
        { status, reportedBy, reportedAt: new Date() },
        { upsert: true, new: true }
    );

    await LightStatusEvent.create({
        locationKey: key,
        status,
        reportedBy,
        userId: userId || undefined,
        reportedAt: new Date()
    });

    console.log(`Light status updated: ${key} => ${status} (by ${reportedBy})`);

    // ── Send push notifications to all subscribers at this location ──
    // Was: both PushSubscription.find() calls below were awaited before
    // this function returned, so POST /lightstatus (and the admin
    // equivalent) sat waiting on those lookups even though `record` was
    // already final and ready to send back. sendPushToSubscribers()
    // itself was already fire-and-forget (not awaited) — only the
    // subscriber lookups were on the blocking path. Wrapped in an
    // un-awaited async IIFE so the caller gets `record` back immediately
    // and the lookups + pushes happen after.
    const emoji = status === 'on' ? '💡' : '🌑';
    (async () => {
        try {
            const payload = {
                title: `LightWatch — ${keyTitle}`,
                body: `${emoji} Light is now ${status.toUpperCase()} in ${keyTitle}.`,
                url: '/pages/home.html',
                tag: 'light-status',
                requireInteraction: status === 'off',
                vibrate: status === 'off' ? [300, 120, 300, 120, 300] : [180, 90, 180],
                status,
                tone: status === 'on' ? 'power-on' : 'power-off'
            };

            const subscribers = await PushSubscription.find({ location: key }).lean();
            console.log(`Sending push to ${subscribers.length} subscriber(s) at ${key}`);
            sendPushToSubscribers(subscribers, payload);

            // ── Send push to anyone watching this as a SECOND location ──
            // Only on a genuine change, and to a completely separate
            // subscriber set (secondaryLocationKey, not location) so someone
            // watching Bantama as their primary and Adum as their second gets
            // exactly one push per real event, worded appropriately for each.
            if (statusChanged) {
                const secondaryPayload = {
                    title: `Second location — ${keyTitle}`,
                    body: `${emoji} ${keyTitle} just changed to ${status.toUpperCase()}.`,
                    url: '/pages/home.html',
                    tag: 'secondary-light-status',
                    requireInteraction: status === 'off',
                    vibrate: status === 'off' ? [300, 120, 300, 120, 300] : [180, 90, 180],
                    status,
                    tone: status === 'on' ? 'power-on' : 'power-off'
                };

                const secondarySubscribers = await PushSubscription.find({ secondaryLocationKey: key }).lean();
                console.log(`Sending secondary-location push to ${secondarySubscribers.length} subscriber(s) watching ${key}`);

                sendPushToSubscribers(secondarySubscribers, secondaryPayload);
            }
        } catch (err) {
            console.error('Light-status notification error:', err.message);
        }
    })();

    return { record, key, keyTitle, statusChanged };
}

// POST /lightstatus  { location, status, userId }
app.post('/lightstatus', async (req, res) => {
    const { location, status, userId } = req.body;
    if (!location || !status) return res.status(400).json({ error: 'location and status required' });
    if (!['on', 'off'].includes(status)) return res.status(400).json({ error: 'status must be on or off' });

    try {
        const { record } = await applyLightStatusUpdate(location, status, { userId });
        return res.json(record);
    } catch (err) {
        console.error('Light status error:', err.message);
        return res.status(500).json({ error: 'Server error' });
    }
});

// ---- ADMIN: set/push a location's light status (protected) ----
// Goes through the exact same LightStatus/LightStatusEvent/push pipeline
// as a real user report, so it lands on users' home pages automatically
// (next poll of GET /lightstatus, plus an immediate push to subscribers)
// with no separate sync path for admin to keep in mind.
app.post('/admin/lightstatus', verifyAdminToken, async (req, res) => {
    const { location, status } = req.body;
    if (!location || !status) return res.status(400).json({ error: 'location and status required' });
    if (!['on', 'off'].includes(status)) return res.status(400).json({ error: 'status must be on or off' });

    try {
        const { record, keyTitle } = await applyLightStatusUpdate(location, status, { reportedByOverride: 'LightWatch Admin' });
        return res.json({ ...record.toObject(), locationLabel: keyTitle });
    } catch (err) {
        console.error('Admin light status error:', err.message);
        return res.status(500).json({ error: 'Server error updating light status' });
    }
});

// ---- ADMIN: known locations + current status (protected) ----
// Union of every location that already has a status record and every
// city a user actually lives in, so admin can push a status for a
// location that's never had a report yet, not just ones already seen.
app.get('/admin/locations', verifyAdminToken, async (req, res) => {
    try {
        const [statuses, userCities] = await Promise.all([
            LightStatus.find().lean(),
            User.distinct('city')
        ]);

        const map = new Map();
        statuses.forEach(s => {
            map.set(s.locationKey, {
                locationKey: s.locationKey,
                label: titleCaseLocation(s.locationKey),
                status: s.status,
                reportedBy: s.reportedBy || null,
                reportedAt: s.reportedAt || null
            });
        });
        userCities.forEach(city => {
            const key = normalizeLocation(city).split(',')[0].trim();
            if (key && !map.has(key)) {
                map.set(key, {
                    locationKey: key,
                    label: titleCaseLocation(key),
                    status: 'unknown',
                    reportedBy: null,
                    reportedAt: null
                });
            }
        });

        const locations = [...map.values()].sort((a, b) => a.label.localeCompare(b.label));
        return res.json(locations);
    } catch (err) {
        console.error('Admin locations error:', err.message);
        return res.status(500).json({ error: 'Server error fetching locations' });
    }
});

// ---- PUSH SUBSCRIPTION ----
app.post('/subscribe', async (req, res) => {
    const { userId, location, subscription } = req.body;

    if (!userId || !subscription || !location) {
        return res.status(400).json({ error: 'userId, location, and subscription required' });
    }

    try {
        const locationKey = normalizeLocation(location).split(',')[0].trim();

        await PushSubscription.findOneAndUpdate(
            { 'subscription.endpoint': subscription.endpoint },
            {
                userId,
                location: locationKey,
                platform: 'web',
                subscription,
                $setOnInsert: { muteGlobalChat: false }
            },
            { upsert: true, new: true }
        );

        return res.json({ success: true });
    } catch (err) {
        console.error('Subscribe error:', err.message);
        return res.status(500).json({ error: 'Server error saving subscription' });
    }
});

// POST /subscribe/fcm  { userId, location, fcmToken }
// Native-Android equivalent of POST /subscribe above — same upsert
// pattern, keyed on fcmToken instead of subscription.endpoint since
// there's no web-push subscription object on this platform at all
// (see notification.js's isNativeAndroidApp() branch for why).
app.post('/subscribe/fcm', async (req, res) => {
    const { userId, location, fcmToken } = req.body;

    if (!userId || !fcmToken || !location) {
        return res.status(400).json({ error: 'userId, location, and fcmToken required' });
    }

    try {
        const locationKey = normalizeLocation(location).split(',')[0].trim();

        await PushSubscription.findOneAndUpdate(
            { fcmToken },
            {
                userId,
                location: locationKey,
                platform: 'android',
                fcmToken,
                $setOnInsert: { muteGlobalChat: false }
            },
            { upsert: true, new: true }
        );

        return res.json({ success: true });
    } catch (err) {
        console.error('FCM subscribe error:', err.message);
        return res.status(500).json({ error: 'Server error saving FCM token' });
    }
});

app.get('/subscribe/preferences', async (req, res) => {
    const { userId, endpoint } = req.query;
    if (!userId || !endpoint) {
        return res.status(400).json({ error: 'userId and endpoint are required' });
    }

    try {
        const sub = await PushSubscription.findOne({
            userId,
            'subscription.endpoint': endpoint
        }).select('muteGlobalChat chatMentionsEnabled secondaryLocationKey secondaryLocationLabel').lean();

        if (!sub) {
            return res.status(404).json({ error: 'Subscription not found for this user/device' });
        }

        return res.json({
            muteGlobalChat: sub.muteGlobalChat === true,
            chatMentionsEnabled: sub.chatMentionsEnabled !== false,
            secondaryLocationKey: sub.secondaryLocationKey || null,
            secondaryLocationLabel: sub.secondaryLocationLabel || null
        });
    } catch (err) {
        console.error('Get subscribe preferences error:', err.message);
        return res.status(500).json({ error: 'Server error fetching preferences' });
    }
});

app.patch('/subscribe/preferences', async (req, res) => {
    const { userId, endpoint, muteGlobalChat, chatMentionsEnabled, secondaryLocation } = req.body;
    const hasMuteUpdate = typeof muteGlobalChat === 'boolean';
    const hasMentionsUpdate = typeof chatMentionsEnabled === 'boolean';
    // secondaryLocation is a tri-state: a non-empty string sets the watch,
    // null explicitly clears it, undefined means "not part of this update".
    const hasSecondaryUpdate = secondaryLocation !== undefined;

    if (!userId || !endpoint || (!hasMuteUpdate && !hasMentionsUpdate && !hasSecondaryUpdate)) {
        return res.status(400).json({ error: 'userId, endpoint, and at least one of muteGlobalChat/chatMentionsEnabled/secondaryLocation are required' });
    }

    const update = {};
    if (hasMuteUpdate) update.muteGlobalChat = muteGlobalChat;
    if (hasMentionsUpdate) update.chatMentionsEnabled = chatMentionsEnabled;
    if (hasSecondaryUpdate) {
        if (secondaryLocation) {
            update.secondaryLocationKey = normalizeLocation(secondaryLocation).split(',')[0].trim();
            update.secondaryLocationLabel = String(secondaryLocation).trim();
        } else {
            update.secondaryLocationKey = null;
            update.secondaryLocationLabel = null;
        }
    }

    try {
        const updated = await PushSubscription.findOneAndUpdate(
            {
                userId,
                'subscription.endpoint': endpoint
            },
            update,
            { new: true }
        );

        if (!updated) {
            return res.status(404).json({ error: 'Subscription not found for this user/device' });
        }

        return res.json({
            success: true,
            muteGlobalChat: updated.muteGlobalChat,
            chatMentionsEnabled: updated.chatMentionsEnabled,
            secondaryLocationKey: updated.secondaryLocationKey || null
        });
    } catch (err) {
        console.error('Subscribe preferences error:', err.message);
        return res.status(500).json({ error: 'Server error saving preferences' });
    }
});

app.patch('/user/:id/city', async (req, res) => {
    const { id } = req.params;
    const city = String(req.body?.city || '').trim();
    if (!city) {
        return res.status(400).json({ error: 'city is required' });
    }
    if (city.length < 2 || city.length > 60) {
        return res.status(400).json({ error: 'city must be between 2 and 60 characters' });
    }

    try {
        const user = await User.findById(id);
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        if (user.cityChangeLocked) {
            return res.status(409).json({ error: 'City/Town has already been changed and is now locked.' });
        }

        user.city = city;
        user.cityChangeLocked = true;
        user.cityChangedAt = new Date();
        await user.save();

        return res.json({
            success: true,
            user: {
                id: user._id,
                city: user.city,
                region: user.region,
                cityChangeLocked: true,
                cityChangedAt: user.cityChangedAt
            }
        });
    } catch (err) {
        console.error('City update error:', err.message);
        return res.status(500).json({ error: 'Server error updating city' });
    }
});

// PATCH /user/:id/profile  { chatHandle?, avatarImage? }
// Lets users customize their public identity used in community chat.
app.patch('/user/:id/profile', async (req, res) => {
    const { id } = req.params;
    const hasChatHandle = Object.prototype.hasOwnProperty.call(req.body || {}, 'chatHandle');
    const hasAvatarImage = Object.prototype.hasOwnProperty.call(req.body || {}, 'avatarImage');

    if (!hasChatHandle && !hasAvatarImage) {
        return res.status(400).json({ error: 'At least one of chatHandle or avatarImage is required' });
    }

    try {
        const user = await User.findById(id);
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        if (hasChatHandle) {
            const requestedHandle = sanitizeHandle(req.body.chatHandle);
            if (!isValidHandle(requestedHandle)) {
                return res.status(400).json({
                    error: 'Handle must be 3-24 chars, letters/numbers, and can include - or _ in the middle.'
                });
            }

            const taken = await User.findOne({
                _id: { $ne: user._id },
                chatHandle: new RegExp(`^${escapeRegex(requestedHandle)}$`, 'i')
            }).select('_id').lean();

            if (taken) {
                return res.status(409).json({ error: 'That chat handle is already in use.' });
            }

            user.chatHandle = requestedHandle;
        }

        if (hasAvatarImage) {
            const normalizedAvatar = sanitizeAvatarImageDataUrl(req.body.avatarImage);
            if (req.body.avatarImage && !normalizedAvatar) {
                return res.status(400).json({ error: 'Avatar must be a PNG, JPG, or WEBP image and within size limits.' });
            }
            user.avatarImage = normalizedAvatar;
        }

        await user.save();

        return res.json({
            success: true,
            user: {
                id: user._id,
                chatHandle: user.chatHandle,
                avatarImage: user.avatarImage || null
            }
        });
    } catch (err) {
        console.error('Profile update error:', err.message);
        return res.status(500).json({ error: 'Server error updating profile' });
    }
});

// PATCH /user/:id/secondary-location  { label, city, region }
// Adds or updates the user's one extra monitored location (e.g. "Work").
// Unlike the primary city, this can be edited any number of times.
app.patch('/user/:id/secondary-location', async (req, res) => {
    const { id } = req.params;
    const label  = String(req.body?.label || '').trim().slice(0, 40);
    const city   = String(req.body?.city || '').trim();
    const region = String(req.body?.region || '').trim();

    if (!city || !region) {
        return res.status(400).json({ error: 'city and region are required' });
    }
    if (city.length < 2 || city.length > 60) {
        return res.status(400).json({ error: 'city must be between 2 and 60 characters' });
    }

    try {
        const user = await User.findById(id);
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        user.secondaryLocation = {
            label: label || 'Second location',
            city,
            region
        };
        await user.save();

        return res.json({ success: true, secondaryLocation: user.secondaryLocation });
    } catch (err) {
        console.error('Secondary location update error:', err.message);
        return res.status(500).json({ error: 'Server error updating secondary location' });
    }
});

// DELETE /user/:id/secondary-location
app.delete('/user/:id/secondary-location', async (req, res) => {
    const { id } = req.params;
    try {
        const user = await User.findById(id);
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }
        user.secondaryLocation = { label: null, city: null, region: null };
        await user.save();
        return res.json({ success: true });
    } catch (err) {
        console.error('Secondary location delete error:', err.message);
        return res.status(500).json({ error: 'Server error removing secondary location' });
    }
});

// ── News system (news.js) — RSS + ECG-site fetcher, keyword
//    filter/dedupe, scheduled background refresh, and GET /news. Wired
//    in last, since it just needs app + the models/helpers already
//    defined above; see news.js's header comment for the full picture. ──
require('./news')(app, {
    mongoose,
    PushSubscription,
    User,
    sendPushToSubscribers,
    normalizeLocation,
    titleCaseLocation,
    escapeRegex,
    verifyAdminToken
});

// ---- HEALTH CHECK ----
app.get('/', (req, res) => {
    const dbState = mongoose.connection.readyState;
    const states = ['disconnected', 'connected', 'connecting', 'disconnecting'];
    res.json({
        status: "LightWatch backend is running",
        mongodb: states[dbState] || 'unknown'
    });
});

// SPA routing: serve index.html for all non-API routes
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '../frontend/index.html'));
});

// START
const PORT = process.env.PORT || 3000;

function startServer(port) {
    const server = app.listen(port, () => {
        console.log(`Server running on port ${port}`);
    });

    // Render's own front-end proxy keeps idle keep-alive connections open
    // longer than Node's default (server.keepAliveTimeout defaults to 5s).
    // When the proxy's idle timeout is longer than Node's, the proxy can
    // reuse a socket in the small window after Node has already decided to
    // close it, which the client experiences as an occasional slow/reset
    // request. Raising keepAliveTimeout past a typical proxy idle timeout
    // avoids that race. headersTimeout must stay a few seconds above
    // keepAliveTimeout (Node enforces this) so a slow client can still be
    // cut off. Purely a socket-handling change — no route behavior differs.
    server.keepAliveTimeout = Number(process.env.KEEP_ALIVE_TIMEOUT_MS) || 65000;
    server.headersTimeout = server.keepAliveTimeout + 5000;

    server.on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
            console.warn(`Port ${port} in use, trying ${port + 1}`);
            setTimeout(() => startServer(port + 1), 500);
        } else {
            console.error('Server error:', err);
            process.exit(1);
        }
    });
}

startServer(Number(PORT));

app.get('/admin/clear-subscriptions', verifyAdminToken, async (req, res) => {
    await PushSubscription.deleteMany({});
    res.json({ cleared: true });
});

// ---- ADMIN: PUSH TEST ----
app.post('/admin/push-test', verifyAdminToken, async (req, res) => {
    const {
        location,
        title,
        body,
        url,
        tag,
        requireInteraction,
        vibrate,
        image,
        icon,
        badge,
        tone
    } = req.body || {};

    if (!location) {
        return res.status(400).json({ error: 'location is required' });
    }

    try {
        const key = normalizeLocation(location).split(',')[0].trim();
        const subscribers = await PushSubscription.find({ location: key }).lean();

        if (!subscribers.length) {
            return res.status(404).json({ error: 'No subscribers found for this location' });
        }

        const keyTitle = titleCaseLocation(key);
        const payload = {
            title: title || `LightWatch test — ${keyTitle}`,
            body: body || 'Testing heads-up push behavior on this device.',
            url: url || '/pages/home.html',
            tag: tag || `test-${Date.now()}`,
            requireInteraction: typeof requireInteraction === 'boolean' ? requireInteraction : true,
            vibrate: Array.isArray(vibrate) ? vibrate : [300, 120, 300, 120, 300],
            image: image || undefined,
            icon: icon || undefined,
            badge: badge || undefined,
            tone: tone || undefined // 'power-on' | 'power-off' | 'chat' — omit to hear the legacy fallback tone
        };

        const pushPromises = subscribers.map(sub => sendPushToOne(sub, payload));

        const settled = await Promise.all(pushPromises);
        const sentCount = settled.filter(x => x.ok).length;
        const staleCount = settled.filter(x => x.stale).length;

        return res.json({
            location: key,
            subscribers: subscribers.length,
            sentCount,
            staleRemoved: staleCount
        });
    } catch (err) {
        console.error('Admin push-test route error:', err.message);
        return res.status(500).json({ error: 'Server error sending test push' });
    }
});

// ---- ADMIN: BROADCAST — push a message to every subscriber (or one
// location), post it into that audience's Community chat, and surface it
// in everyone's Reports feed ----
// If `location` is omitted/blank, this behaves as before: every
// PushSubscription in the collection gets the push, and the message is
// saved as a scope:'global' Chat (shows up in the "Community"/global
// chat tab for everyone). If `location` IS given, this instead targets
// only subscribers at that location (same lookup /admin/push-test uses)
// and saves the message as a scope:'local' Chat at that location (shows
// up in that location's own Community tab, same as a normal local chat
// message). Either way the saved Chat doc is flagged isAdmin: true, which
// is what makes GET /reports below always include it regardless of the
// requester's own location/userId.
app.post('/admin/broadcast', verifyAdminToken, async (req, res) => {
    const { title, body, url, location } = req.body || {};

    if (!body || !String(body).trim()) {
        return res.status(400).json({ error: 'Message text is required' });
    }

    const trimmedBody = String(body).trim();
    const trimmedTitle = title && String(title).trim() ? String(title).trim() : 'LightWatch Admin';
    const hasLocation = Boolean(location && String(location).trim());

    try {
        let subscribers, key, audienceTitle, savedLocation, normalizedLocation;

        if (hasLocation) {
            key = normalizeLocation(location).split(',')[0].trim();
            subscribers = await PushSubscription.find({ location: key }).lean();
            audienceTitle = titleCaseLocation(key);
            savedLocation = audienceTitle;
            normalizedLocation = key;
        } else {
            subscribers = await PushSubscription.find({}).lean();
            audienceTitle = 'Everyone';
            savedLocation = 'All areas';
            normalizedLocation = 'global';
        }

        console.log(`Broadcasting admin message to ${subscribers.length} subscriber(s) (${audienceTitle})`);

        const payload = {
            title: trimmedTitle,
            body: trimmedBody,
            url: url || '/pages/home.html',
            tag: `admin-broadcast-${Date.now()}`,
            requireInteraction: true,
            vibrate: [280, 120, 280, 120, 280],
            tone: 'chat'
        };

        const [settled, savedChat] = await Promise.all([
            Promise.all(subscribers.map(sub => sendPushToOne(sub, payload))),
            new Chat({
                handle: trimmedTitle,
                text: trimmedBody,
                scope: hasLocation ? 'local' : 'global',
                isAdmin: true,
                location: savedLocation,
                locationKey: normalizedLocation
            }).save()
        ]);

        const sentCount = settled.filter(x => x.ok).length;
        const staleCount = settled.filter(x => x.stale).length;

        return res.json({
            subscribers: subscribers.length,
            sentCount,
            staleRemoved: staleCount,
            location: hasLocation ? key : null,
            chatId: savedChat._id
        });
    } catch (err) {
        console.error('Admin broadcast route error:', err.message);
        return res.status(500).json({ error: 'Server error sending broadcast' });
    }
});