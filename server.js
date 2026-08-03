require('dotenv').config();
require('newrelic');
const path = require('path');
const dns = require('dns');
const fs = require('fs');
const os = require('os');
dns.setDefaultResultOrder('ipv4first');

require('dotenv').config();
const mongoose = require('mongoose');
const express = require('express');
const cors = require('cors');
const compression = require('compression');
const jwt = require('jsonwebtoken');
const webpush = require('web-push');
const admin = require('firebase-admin');
const cloudinary = require('./cloudinary');
const multer = require('multer');
const { upload: genericUpload, uploadBufferToCloudinary } = require('./upload');

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
let DEV_LOGIN_EMAIL = (process.env.DEV_LOGIN_EMAIL || "").toLowerCase().trim();
let DEV_LOGIN_CODE  = (process.env.DEV_LOGIN_CODE || "").trim();
const DEFAULT_DEV_LOGIN_EMAIL = 'sarkdev@yahoo.com';
const DEFAULT_DEV_LOGIN_CODE = '123456';

if (!DEV_LOGIN_EMAIL && process.env.NODE_ENV !== 'production') {
    DEV_LOGIN_EMAIL = DEFAULT_DEV_LOGIN_EMAIL;
    console.warn(`DEV_LOGIN_EMAIL not set; using local default ${DEV_LOGIN_EMAIL}`);
}

if (!DEV_LOGIN_CODE && process.env.NODE_ENV !== 'production') {
    DEV_LOGIN_CODE = DEFAULT_DEV_LOGIN_CODE;
    console.warn(`DEV_LOGIN_CODE not set; using local default ${DEV_LOGIN_CODE}`);
}

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
    console.log("Firebase Admin (FCM) ready for native Android push delivery.");
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
    // NEW: serverSelectionTimeoutMS only covers picking a server for a
    // NEW operation — once a socket is established and in use, nothing
    // was bounding how long Mongoose would wait on it. Cloud networking
    // (Railway <-> Atlas, or any NAT/load-balancer in between) can leave
    // a connection "half-open" — no FIN, no RST, just silence — and
    // without socketTimeoutMS the driver just keeps waiting on that
    // read, sometimes for minutes, while still holding the connection
    // out of the pool. Every OTHER query then queues behind maxPoolSize
    // (10) for a connection that's never coming back. That's consistent
    // with what the logs showed: GET / (no DB call) stayed at ~1ms the
    // whole time, while every Mongo-touching route (GET /news, GET
    // /reports) simultaneously spiked to 80-160+ seconds, then
    // eventually recovered on its own once the dead socket finally
    // timed out. Setting an explicit bound here means a stalled
    // operation fails in ~20s with a clear Mongo error instead of
    // silently hanging the whole app for minutes.
    // UPDATED: the logs now show queries clocking in at ~20s/40s/60s/88s —
    // almost exactly multiples of the 20s value this was originally set
    // to. That's the driver retrying a failed operation against the same
    // degrading replica-set node (confirmed separately by the
    // [MONGO HEARTBEAT] logs showing rising latency to shard-00-02), each
    // retry burning another ~20s while still holding one of only
    // maxPoolSize connections. Tightened to 8s so a stuck operation fails
    // and releases its slot back to the pool much sooner — worse-case a
    // request now fails fast with a clear error instead of hanging for
    // over a minute, and fresh requests (like OTP's User.findOne) get a
    // real chance at an available connection instead of queuing behind
    // several minutes' worth of retries.
    socketTimeoutMS: 8000,
    connectTimeoutMS: 8000,
    family: 4,
    // UPDATED: Atlas confirmed only 17/500 connections in use (3%) — there
    // was no risk in the small pool from Atlas's side, it was purely a
    // self-imposed bottleneck. Raising it gives more requests room to get
    // a working connection concurrently while some are stuck retrying
    // against a degrading node.
    maxPoolSize: Number(process.env.MONGO_MAX_POOL_SIZE) || 25,
    minPoolSize: Number(process.env.MONGO_MIN_POOL_SIZE) || 1
})
.then(() => {
    console.log("MongoDB connected successfully");
})
.catch(err => {
    console.error("MongoDB connection error:", err.message);
});

// ================================================================
// ===== BEGIN DEBUG INSTRUMENTATION — safe to delete later =====
// Everything between here and the matching END marker below is
// diagnostic-only: it doesn't change app behavior, only what gets
// logged. To remove it later, delete this whole block plus the
// handful of `// DEBUG:`-marked lines further down in this file
// (grep for "DEBUG:" to find every one of them).
//
// Toggles (all optional, all default to something safe for prod):
//   DEBUG_MODE=true          → verbose request start/finish pairs,
//                               and switches Mongoose debug logging
//                               on regardless of NODE_ENV.
//   MONGOOSE_DEBUG=true      → verbose per-query logging only
//                               (same as before, kept for compat).
//   DEBUG_SLOW_QUERY_MS=500  → queries slower than this get logged
//                               with timing, always on by default
//                               since it's cheap and only fires on
//                               genuinely slow queries.
//   DEBUG_PING_MS=60000      → how often to ping Mongo + log
//                               readyState. Set to 0 to disable.
// ================================================================
const DEBUG_MODE = process.env.DEBUG_MODE === 'true';
const DEBUG_SLOW_QUERY_MS = Number(process.env.DEBUG_SLOW_QUERY_MS || 500);
const DEBUG_PING_MS = process.env.DEBUG_PING_MS === '0' ? 0 : Number(process.env.DEBUG_PING_MS || 60000);

// ---- 1. Connection lifecycle events ----
// 'error' was already handled before this block existed; extended
// here with the other lifecycle states so a disconnect/reconnect
// cycle shows up in the logs instead of just going silent.
mongoose.connection.on('connected', () => {
    console.log(`[MONGO] connected | readyState=${mongoose.connection.readyState}`);
});
mongoose.connection.on('disconnected', () => {
    console.warn(`[MONGO] disconnected | readyState=${mongoose.connection.readyState}`);
});
mongoose.connection.on('reconnected', () => {
    console.log(`[MONGO] reconnected | readyState=${mongoose.connection.readyState}`);
});
mongoose.connection.on('close', () => {
    console.warn('[MONGO] connection closed');
});
mongoose.connection.on('error', (err) => {
    console.error('[MONGO] runtime error:', err.message);
});

// ---- SDAM heartbeat monitoring ----
// This is the deepest visibility the driver exposes: every ~10s
// (heartbeatFrequencyMS) it pings each node in the replica set in the
// background to check it's alive, independent of any app query. If
// THESE start failing or getting slow before/during a stall, the
// problem is the network path to Atlas itself, not anything in this
// app's code — which is the single most useful signal for exactly
// the "connection N to X.X.X.X:27017 timed out" pattern you've been
// seeing, since it shows the node's health continuously instead of
// only when a real request happens to hit it.
mongoose.connection.once('connected', () => {
    const client = mongoose.connection.getClient();
    if (!client || typeof client.on !== 'function') return;
    client.on('serverHeartbeatSucceeded', (event) => {
        if (event.duration > 1000) {
            console.warn(`[MONGO HEARTBEAT] slow but ok: ${event.connectionId} took ${event.duration}ms`);
        }
    });
    client.on('serverHeartbeatFailed', (event) => {
        console.error(`[MONGO HEARTBEAT] FAILED: ${event.connectionId} after ${event.duration}ms — ${event.failure?.message || event.failure}`);
    });
    client.on('serverDescriptionChanged', (event) => {
        const prevType = event.previousDescription?.type;
        const newType = event.newDescription?.type;
        if (prevType !== newType) {
            console.warn(`[MONGO TOPOLOGY] ${event.address} changed: ${prevType} -> ${newType}`);
        }
    });
    // Connection-pool (CMAP) events — this is what directly answers "is the
    // pool actually getting exhausted?" A burst of connectionCreated events
    // followed by connectionClosed/poolCleared right as requests start
    // stacking up means the pool is genuinely churning through connections
    // faster than it can reuse them, rather than a handful of requests just
    // being individually slow.
    client.on('connectionPoolCleared', (event) => {
        console.error(`[MONGO POOL] cleared for ${event.address} — every pooled connection to this server was just discarded`);
    });
    client.on('connectionCheckOutFailed', (event) => {
        console.error(`[MONGO POOL] checkout FAILED for ${event.address}: ${event.reason}`);
    });
});

// ---- 4 & 7. Periodic ping health check + readyState ----
// Runs independently of any user traffic — if this starts showing
// slow/failed pings at the same time users report freezes, that
// confirms the DB link itself, not app code, ruling out routes.
if (DEBUG_PING_MS > 0) {
    setInterval(async () => {
        const readyState = mongoose.connection.readyState; // 0=disconnected 1=connected 2=connecting 3=disconnecting
        const start = process.hrtime.bigint();
        try {
            await mongoose.connection.db.admin().ping();
            const ms = Number(process.hrtime.bigint() - start) / 1e6;
            console.log(`[MONGO PING] ok ${ms.toFixed(1)}ms | readyState=${readyState}`);
        } catch (err) {
            const ms = Number(process.hrtime.bigint() - start) / 1e6;
            console.error(`[MONGO PING] FAILED after ${ms.toFixed(1)}ms | readyState=${readyState} | ${err.message}`);
        }
    }, DEBUG_PING_MS);
}

// ---- 1 (cont'd). Verbose per-query debug logging ----
// Kept the same MONGOOSE_DEBUG/NODE_ENV gate as before; DEBUG_MODE
// now also switches it on so you only need to set one env var during
// an active debugging session instead of two.
mongoose.set('debug', (collectionName, method, query, doc, options) => {
    console.log(`[MONGOOSE] ${collectionName}.${method}`, JSON.stringify(query), options && Object.keys(options).length ? JSON.stringify(options) : '');
});
if (!(DEBUG_MODE || process.env.MONGOOSE_DEBUG === 'true' || process.env.NODE_ENV === 'development')) {
    mongoose.set('debug', false);
}

// ---- 2 & 9. Global slow-query timing plugin ----
// Registered here, BEFORE any schema below is compiled into a model —
// mongoose.plugin() applies to every schema defined anywhere in the
// app from this point forward, including the News*/Chat/User/Report
// models defined later in this file AND the ones defined in news.js
// (required at the bottom of this file, well after this line runs).
// That means this one registration covers every collection without
// needing to touch each model individually. Only logs when a query
// actually exceeds DEBUG_SLOW_QUERY_MS, so it's safe to leave on
// permanently — it stays silent during normal operation and only
// speaks up exactly when something is worth looking at.
function slowQueryTimingPlugin(schema) {
    const timedOps = ['find', 'findOne', 'findOneAndUpdate', 'findOneAndDelete',
        'countDocuments', 'updateOne', 'updateMany', 'deleteOne', 'deleteMany', 'aggregate'];
    timedOps.forEach((op) => {
        schema.pre(op, function () { this.__debugStart = process.hrtime.bigint(); });
        schema.post(op, function () {
            if (!this.__debugStart) return;
            const ms = Number(process.hrtime.bigint() - this.__debugStart) / 1e6;
            if (ms >= DEBUG_SLOW_QUERY_MS) {
                const modelName = this.model?.modelName || this._model?.modelName || '?';
                const filter = typeof this.getQuery === 'function' ? this.getQuery() : (typeof this.getFilter === 'function' ? this.getFilter() : {});
                console.warn(`[SLOW QUERY] ${modelName}.${op} took ${ms.toFixed(1)}ms`, JSON.stringify(filter));
            }
        });
    });
}
mongoose.plugin(slowQueryTimingPlugin);

// ---- 6. External API call timing ----
// Thin wrapper used at each outbound-fetch call site below (search
// this file for "DEBUG:" to find every wrapped call). Logs how long
// the call took and whether it succeeded, so a hang in Brevo/Arkesel/
// FCM/Nominatim/Google Maps shows up distinctly from a Mongo hang.
async function timeExternalCall(label, fn) {
    const start = process.hrtime.bigint();
    try {
        const result = await fn();
        const ms = Number(process.hrtime.bigint() - start) / 1e6;
        console.log(`[EXTERNAL] ${label} ok ${ms.toFixed(1)}ms`);
        return result;
    } catch (err) {
        const ms = Number(process.hrtime.bigint() - start) / 1e6;
        console.error(`[EXTERNAL] ${label} FAILED after ${ms.toFixed(1)}ms: ${err.message}`);
        throw err;
    }
}
// ================================================================
// ===== END DEBUG INSTRUMENTATION =====
// ================================================================

// SCHEMAS / MODELS
const userSchema = new mongoose.Schema({
    name: { type: String, required: true },
    emailPhone: { type: String, required: true, unique: true },
    region: { type: String, required: true },
    city: { type: String, required: true },
    cityChangeLocked: { type: Boolean, default: false },
    cityChangedAt: { type: Date, default: null },
    // Real position for the primary city, set when the user picks a
    // result from the location search dropdown or taps "use my
    // location" on signup/account — see js/utils/location-picker.js.
    // Absent for anyone who just typed a name with no picker
    // confirmation; GET /locations/map falls back to
    // GHANA_TOWN_COORDS / Nominatim geocoding when this is null.
    lat: { type: Number, default: null },
    lng: { type: Number, default: null },
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
        kind: { type: String, enum: ['image', 'video'] },
        url: { type: String }
    },
    // Persisted like state so counts are shared across every user/device
    // instead of living only in that one browser tab's DOM (see POST
    // /chats/:chatId/like below). likedBy gates one like per user.
    likeCount: { type: Number, default: 0 },
    likedBy: { type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }], default: [] },
    // Same idea for reposts: repostCount is what every viewer sees on
    // the original post's Repost button. repostedBy stops a single user
    // from inflating it by reposting the same report more than once
    // (each repost still creates its own new top-level Chat doc, same
    // as before — this only guards the counter on the ORIGINAL).
    repostCount: { type: Number, default: 0 },
    repostedBy: { type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }], default: [] },
    // Quote-count tracking mirrors repost tracking so the original post
    // can surface how many quote posts have pointed back at it.
    quoteCount: { type: Number, default: 0 },
    quotedBy: { type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }], default: [] },
    location: { type: String, required: true },
    locationKey: { type: String, required: true },
    editedAt: { type: Date, default: null },
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
    reportedAt: { type: Date, default: Date.now },
    // Real device coordinates, opportunistically supplied by a reporting
    // client (see POST /lightstatus). Absent until the first geolocated
    // report for a location comes in — GET /locations/map falls back to
    // GHANA_TOWN_COORDS / approximateCoordsFor() until then. Once a real
    // fix lands here it takes priority over the approximation, so pin
    // accuracy improves organically as real reports accumulate.
    lat: { type: Number, default: null },
    lng: { type: Number, default: null }
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

// Persistent cache of real-world Nominatim geocoding results, keyed on
// the same normalized locationKey + region GHANA_TOWN_COORDS already
// uses. Without this, every restart (or every cold GHANA_TOWN_COORDS
// miss) would re-hit the Nominatim API for the same town repeatedly —
// this table makes that a one-time lookup per town/region pair, ever,
// and also gives resolveLocationCoords() something durable to check
// before it falls back to approximateCoordsFor()'s scatter position.
const geocodeCacheSchema = new mongoose.Schema({
    // e.g. "aputuogya|ashanti" — locationKey + normalized region, so
    // two differently-regioned towns that happen to share a bare name
    // (see GHANA_TOWN_COORDS's own comment about this) get separate
    // entries instead of colliding on the town name alone.
    cacheKey: { type: String, required: true, unique: true },
    locationKey: { type: String, required: true },
    region: { type: String, default: null },
    lat: { type: Number, required: true },
    lng: { type: Number, required: true },
    // Nominatim's own display_name for the match, kept for debugging/
    // admin visibility into what the geocoder actually resolved to.
    displayName: { type: String, default: null },
    geocodedAt: { type: Date, default: Date.now }
});

const User             = mongoose.model('User', userSchema);
const Chat             = mongoose.model('Chat', chatSchema);
const LightStatus      = mongoose.model('LightStatus', lightStatusSchema);
const LightStatusEvent = mongoose.model('LightStatusEvent', lightStatusEventSchema);
const PushSubscription = mongoose.model('PushSubscription', pushSubscriptionSchema);
const AdminLocation     = mongoose.model('AdminLocation', new mongoose.Schema({
    locationKey: { type: String, required: true, unique: true },
    label: { type: String, required: true },
    hidden: { type: Boolean, default: false },
    createdAt: { type: Date, default: Date.now }
}));
const AnalyticsEvent    = mongoose.model('AnalyticsEvent', analyticsEventSchema);
const GeocodeCache      = mongoose.model('GeocodeCache', geocodeCacheSchema);

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
// Default express.json() limit is 100kb, which silently rejected (413)
// any post carrying composer media (data URLs up to ~1.2MB, see
// sanitizeMediaImageDataUrl) or an avatar image (up to ~2MB, see
// sanitizeAvatarImageDataUrl). Raised so those requests actually reach
// the route handlers instead of failing before postChat() gets a response.
app.use(express.json({ limit: '6mb' }));

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

// Set this to your real Railway URL (e.g. https://lightwatch-backend-lightwatch-backend.up.railway.app)
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || 'https://lightwatch-backend-lightwatch-backend.up.railway.app';
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
    return req.method === 'GET' && NOISY_GET_ROUTES.some(route => req.url.startsWith(route));
}

if (PERF_LOGGING_ENABLED) {
    let __debugReqCounter = 0;
    app.use((req, res, next) => {
        const noisy = isNoisyRequest(req) && !DEBUG_MODE; // DEBUG: DEBUG_MODE also surfaces normally-noisy routes
        const startedAt = process.hrtime.bigint();

        // DEBUG: request-start line, only under DEBUG_MODE to avoid doubling
        // log volume during normal operation. reqId lets you match this
        // line to its corresponding finish line below when many requests
        // are interleaved (e.g. during a stall, to see what was already
        // in-flight when things started backing up).
        let reqId;
        if (DEBUG_MODE) {
            reqId = ++__debugReqCounter;
            console.log(`[REQ START ${reqId}] ${req.method} ${req.url}`);
        }

        // 'finish' fires once the response has actually been sent, so this
        // measures true end-to-end handler time (including any awaited DB
        // calls), not just the time to reach this middleware.
        res.on('finish', () => {
            if (noisy) return;
            const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
            const prefix = DEBUG_MODE ? `[REQ END ${reqId}] ` : '';
            console.log(`${prefix}${req.method} ${req.url} ${res.statusCode} ${durationMs.toFixed(1)}ms`);
        });

        next();
    });
}

const RECENT_REQUEST_LATENCY_BUFFER = 120;
const RECENT_SERVER_LOG_BUFFER = 50;
const recentRequestDurations = [];
const recentServerLogs = [];

function pushServerLog(entry) {
    const row = { time: new Date().toISOString(), entry: String(entry || '') };
    recentServerLogs.unshift(row);
    if (recentServerLogs.length > RECENT_SERVER_LOG_BUFFER) recentServerLogs.length = RECENT_SERVER_LOG_BUFFER;
}

app.use((req, res, next) => {
    const start = process.hrtime.bigint();
    res.on('finish', () => {
        const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
        recentRequestDurations.unshift(durationMs);
        if (recentRequestDurations.length > RECENT_REQUEST_LATENCY_BUFFER) recentRequestDurations.length = RECENT_REQUEST_LATENCY_BUFFER;
        pushServerLog(`${req.method} ${req.originalUrl} ${res.statusCode} ${durationMs.toFixed(1)}ms`);
    });
    next();
});

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

function sanitizeMediaDataUrl(raw, kind = 'image') {
    const value = String(raw || '').trim();
    if (!value) return null;
    const isVideo = kind === 'video';
    const matches = isVideo
        ? /^data:video\/(mp4|quicktime|webm|ogg|avi|mov);base64,/i.test(value)
        : /^data:image\/(png|jpe?g|webp|heic|heif);base64,/i.test(value);
    if (!matches) return null;
    // Smaller cap for in-feed media snapshots; video allows a larger
    // payload because it is commonly much larger than a still image.
    const maxLength = isVideo ? 20_000_000 : 1_200_000;
    if (value.length > maxLength) return null;
    return value;
}

// Uploads an already-validated media data URL to Cloudinary and
// returns the hosted secure_url, or null if there was nothing to upload.
// One upload failure must never 500 the whole request (a post/profile
// update shouldn't fail outright just because the media didn't make
// it) — callers treat a thrown error as "no media this time".
async function uploadMediaToCloudinary(dataUrl, kind, folder) {
    if (!dataUrl) return null;
    const result = await cloudinary.uploader.upload(dataUrl, {
        folder,
        resource_type: kind === 'video' ? 'video' : 'image'
    });
    return result.secure_url;
}

async function generateUniqueChatHandle() {
    // NOTE: this used to look up existing handles with a case-insensitive
    // regex (`new RegExp(..., 'i')`). There IS an index on chatHandle
    // (see userSchema.index above), but MongoDB can only use a standard
    // index for a regex when it's case-SENSITIVE — the 'i' flag forced a
    // full collection scan of the entire User collection. That was fixed
    // by switching to an exact-match lookup against the already-lowercase
    // handle. But this function runs on every first sign-in for any
    // account without a chatHandle yet AND on every single new signup
    // (see /verify's signup branch), and the exact-match fix alone still
    // left it checking candidates ONE AT A TIME, sequentially awaiting a
    // real network round-trip to MongoDB for each try, up to 200 times
    // before giving up. Each round-trip has real latency (Railway →
    // Atlas, or wherever the DB actually lives) — even a modest ~100ms
    // per hop turns "had to try 30 handles before finding a free one"
    // into a 3-second hang, and a worse run into the 20+ second hangs
    // that were showing up as silent, request-specific freezes (every
    // OTHER route kept responding fine the whole time — only the one
    // request stuck inside this loop looked frozen).
    //
    // Fix: generate a batch of candidates up front and check all of them
    // in ONE query via $in, instead of one query per candidate. One
    // network round-trip finds a free handle unless every single
    // candidate in the batch happens to collide, which the pool sizes
    // here make astronomically unlikely.
    const BATCH_SIZE = 40;
    const MAX_BATCHES = 5;

    for (let batch = 0; batch < MAX_BATCHES; batch += 1) {
        const candidates = [];
        const seenThisBatch = new Set();
        while (candidates.length < BATCH_SIZE) {
            const handle = sanitizeHandle(randomFrom(HANDLE_SHAPES)());
            if (!handle || seenThisBatch.has(handle)) continue;
            seenThisBatch.add(handle);
            candidates.push(handle);
        }

        const taken = await User.find({ chatHandle: { $in: candidates } }).select('chatHandle').lean();
        const takenSet = new Set(taken.map(u => u.chatHandle));
        const free = candidates.find(h => !takenSet.has(h));
        if (free) return free;
        // Whole batch collided (essentially never happens at these pool
        // sizes) — try another batch rather than give up.
    }

    // Very unlikely fallback: a short random suffix makes collision
    // essentially impossible, so this only ever needs one query.
    while (true) {
        const handle = sanitizeHandle(`${randomFrom(HANDLE_LEFT)}-${randomFrom(HANDLE_RIGHT)}-${Math.random().toString(36).slice(2, 6)}`);
        const existing = await User.findOne({ chatHandle: handle }).select('_id').lean();
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

// ── Coordinates for the Locations map (GET /locations/map) ───────────
// There's no geocoding persistence anywhere else in this codebase today
// — signup's /geocode/reverse only turns a GPS fix into a display string,
// it never saves lat/lng. This table is a best-effort stand-in so every
// monitored town still gets a real, plottable position on the map:
//   1. A real reported fix on the LightStatus doc (lat/lng saved by
//      POST /lightstatus when the reporting device supplied one) always
//      wins — see resolveLocationCoords() below.
//   2. Otherwise this curated table of known Ghanaian towns/cities.
//   3. Otherwise a deterministic (same name -> same spot every time)
//      fallback scattered across Ghana's bounding box, so an unrecognized
//      town still renders somewhere sane instead of being dropped or
//      stacking on top of another pin.
// Coordinates below are approximate town-centre fixes, not survey-grade —
// good enough for a country-level monitoring map, and every entry is
// superseded automatically the moment a real GPS-tagged report comes in
// for that location.
const GHANA_TOWN_COORDS = {
    accra: [5.6037, -0.1870], kumasi: [6.6885, -1.6244], tamale: [9.4034, -0.8424],
    sekonditakoradi: [4.9438, -1.7554], takoradi: [4.8956, -1.7554], sekondi: [4.9438, -1.7554],
    capecoast: [5.1053, -1.2466], sunyani: [7.3399, -2.3268], koforidua: [6.0940, -0.2591],
    ho: [6.6108, 0.4708], bolgatanga: [10.7854, -0.8513], wa: [10.0601, -2.5099],
    techiman: [7.5833, -1.9333], obuasi: [6.2020, -1.6700], tema: [5.6698, -0.0166],
    nsawam: [5.8083, -0.3500], winneba: [5.3511, -0.6231], akimoda: [5.9260, -0.9877],
    berekum: [7.4531, -2.5850], nkawkaw: [6.5500, -0.7667], dunkwa: [5.9667, -1.7833],
    yendi: [9.4427, -0.0093], bawku: [11.0575, -0.2417], navrongo: [10.8956, -1.0925],
    hohoe: [7.1517, 0.4747], kpando: [6.9922, 0.2919], keta: [5.9186, 0.9897],
    aflao: [6.1167, 1.1833], axim: [4.8667, -2.2333], elmina: [5.0836, -1.3506],
    tarkwa: [5.3006, -1.9931], prestea: [5.4333, -2.1500], halfassini: [5.0667, -2.8833],
    kintampo: [8.0561, -1.7306], salaga: [8.5539, -0.5186], damongo: [9.0833, -1.8167],
    bimbilla: [8.8489, -0.0500], nalerigu: [10.5333, -0.3667], jirapa: [10.5167, -2.7167],
    lawra: [10.6500, -2.9000], tumu: [10.8667, -1.9833], sefwiwiawso: [6.2167, -2.4833],
    goaso: [6.8022, -2.5164], konongo: [6.6167, -1.2167], mampong: [7.0625, -1.4006],
    ejura: [7.3833, -1.3667], effiduase: [6.9333, -1.2833], newedubiase: [6.1833, -1.4000],
    agonaswedru: [5.5333, -0.7000], kasoa: [5.5333, -0.4167], madina: [5.6833, -0.1667],
    ashaiman: [5.6947, -0.0328], nungua: [5.6000, -0.0667], teshie: [5.5833, -0.1000],
    dansoman: [5.5333, -0.2500], adenta: [5.7083, -0.1667], dome: [5.6333, -0.2167],
    kaneshie: [5.5500, -0.2333], osu: [5.5558, -0.1825], labadi: [5.5556, -0.1611],
    // Kumasi neighborhoods — this is the set location.js previously
    // hand-placed on the old static map image (MAP_POSITIONS).
    bantama: [6.7075, -1.6317], asokwa: [6.6650, -1.6100], adum: [6.6926, -1.6244],
    suame: [6.7239, -1.6367], ahodwo: [6.6650, -1.6350], nhyiaeso: [6.6733, -1.6067],
    tafo: [6.7264, -1.5850], knust: [6.6745, -1.5716], ejisu: [6.7333, -1.3667],
    kwadaso: [6.6975, -1.6600]
};

// Ghana's approximate bounding box, used only by approximateCoordsFor()'s
// fallback so an unrecognized name still lands inside the country.
const GHANA_BOUNDS = { latMin: 4.7, latMax: 11.2, lngMin: -3.3, lngMax: 1.3 };

function approximateCoordsFor(name) {
    let hash = 0;
    const str = String(name || '');
    for (let i = 0; i < str.length; i++) {
        hash = (hash * 31 + str.charCodeAt(i)) >>> 0;
    }
    const latSpan = GHANA_BOUNDS.latMax - GHANA_BOUNDS.latMin;
    const lngSpan = GHANA_BOUNDS.lngMax - GHANA_BOUNDS.lngMin;
    const lat = GHANA_BOUNDS.latMin + ((hash % 1000) / 1000) * latSpan;
    const lng = GHANA_BOUNDS.lngMin + (((hash >> 10) % 1000) / 1000) * lngSpan;
    return { lat, lng, approximate: true };
}

// ── Nominatim forward geocoding (OpenStreetMap) ─────────────────────
// Nominatim's usage policy caps this at 1 request/second and requires
// a real identifying User-Agent. geocodeChain below serializes every
// call through a single chain (with the delay applied AFTER each
// request finishes, success or failure) so however many towns
// GET /locations/map needs to look up in one pass — or however many
// requests land concurrently — they still go out no faster than one
// per second, no matter how many resolveLocationCoords() calls are
// in flight at once.
let geocodeChain = Promise.resolve();
const NOMINATIM_MIN_INTERVAL_MS = 1100;

function scheduleAfterPreviousGeocode(task) {
    const result = geocodeChain.then(() => task());
    geocodeChain = result.catch(() => {}).then(
        () => new Promise((resolve) => setTimeout(resolve, NOMINATIM_MIN_INTERVAL_MS))
    );
    return result;
}

// Region is included in the query string whenever we have one, since
// Ghana has multiple towns/suburbs that share a bare name (e.g. more
// than one "Aputuogya") — "<name>, <region>, Ghana" disambiguates the
// same way it would for a human searching a map by hand.
async function geocodeViaNominatim(name, region) {
    const query = region ? `${name}, ${region}, Ghana` : `${name}, Ghana`;
    const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=gh&q=${encodeURIComponent(query)}`;
    try {
        const response = await timeExternalCall(`Nominatim geocode (${query})`, () => fetch(url, {
            headers: {
                // Nominatim silently deprioritizes/blocks requests with a
                // generic or missing User-Agent — this identifies the app
                // per their usage policy.
                'User-Agent': 'LightWatch-Kumasi/1.0 (community power-outage tracker for Kumasi, Ghana)'
            }
        }));
        if (!response.ok) return null;
        const results = await response.json();
        const hit = Array.isArray(results) ? results[0] : null;
        if (!hit || typeof hit.lat === 'undefined' || typeof hit.lon === 'undefined') return null;
        const lat = parseFloat(hit.lat);
        const lng = parseFloat(hit.lon);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
        return { lat, lng, displayName: hit.display_name || null };
    } catch (err) {
        console.error('Nominatim geocoding error:', err.message);
        return null;
    }
}

// Checks the persistent cache first, geocodes via Nominatim (rate-limited)
// on a miss, and saves a hit before returning it — so any given
// locationKey/region pair only ever calls out to Nominatim once, ever.
async function geocodeWithCache(locationKey, displayLabel, region) {
    const normalizedRegion = normalizeLocation(region) || null;
    const cacheKey = `${locationKey}|${normalizedRegion || 'unknown'}`;
    try {
        const cached = await GeocodeCache.findOne({ cacheKey }).lean();
        if (cached) return { lat: cached.lat, lng: cached.lng };
    } catch (err) {
        console.error('GeocodeCache lookup error:', err.message);
    }

    const geocoded = await scheduleAfterPreviousGeocode(() => geocodeViaNominatim(displayLabel, region));
    if (!geocoded) return null;

    try {
        await GeocodeCache.findOneAndUpdate(
            { cacheKey },
            { cacheKey, locationKey, region: normalizedRegion, lat: geocoded.lat, lng: geocoded.lng, displayName: geocoded.displayName, geocodedAt: new Date() },
            { upsert: true }
        );
    } catch (err) {
        // A failed cache write shouldn't lose a perfectly good geocode result.
        console.error('GeocodeCache save error:', err.message);
    }
    return { lat: geocoded.lat, lng: geocoded.lng };
}

// Resolves the best coordinates available for a location, in order:
//   1. A real reported GPS fix on the LightStatus doc.
//   2. The curated GHANA_TOWN_COORDS table (instant, no network call).
//   3. A cached or fresh Nominatim geocode of the real place name
//      (+ region, when known) — so an unrecognized town gets its
//      actual position on the map instead of a random scattered one.
//   4. The deterministic scatter fallback, only if Nominatim has
//      nothing either (offline, unresolvable name, etc.).
// Now async because of step 3 — callers must await this.
async function resolveLocationCoords(locationKey, storedLat, storedLng, displayLabel, region) {
    if (typeof storedLat === 'number' && typeof storedLng === 'number') {
        return { lat: storedLat, lng: storedLng, approximate: false };
    }
    const tableHit = GHANA_TOWN_COORDS[String(locationKey || '').replace(/[^a-z0-9]/g, '')];
    if (tableHit) return { lat: tableHit[0], lng: tableHit[1], approximate: false };

    const geocoded = await geocodeWithCache(locationKey, displayLabel || locationKey, region);
    if (geocoded) return { lat: geocoded.lat, lng: geocoded.lng, approximate: false };

    return approximateCoordsFor(locationKey);
}

// NOTE: this fetches the location's ENTIRE reporting history, unbounded,
// every call — no .limit(), and it only grows over time. It's called once
// per known location inside GET /locations/map's Promise.all (so a
// single home/map load fans this out across every town in the app) and
// once per call from GET /lightstatus. Cheap today; worth capping to a
// rolling window (with totalChecks/uniqueContributors becoming
// "in that window" rather than all-time) once any location's history
// grows large — didn't change that here since it changes what those
// numbers mean, which felt like a product call rather than a pure
// perf fix. Trimmed the fetched fields in the meantime so at least each
// event only carries what's actually used below.
async function getLightStatusStats(locationKey) {
    // Bounded to a rolling 90 days. Every stat this function computes is
    // either "this week" (needs 7 days) or an outage-duration average
    // that's only meaningful using reasonably recent history — neither
    // needs a location's full lifetime history. This was previously an
    // unbounded find() (no .limit(), no date filter at all), which meant
    // this query — called on every GET /lightstatus, including the 45s
    // background poll every location/home screen runs — got slower
    // forever as a location's event history grew, with no ceiling.
    const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    const events = await LightStatusEvent.find({ locationKey, reportedAt: { $gte: ninetyDaysAgo } })
        .select('status reportedAt reportedBy')
        .sort({ reportedAt: 1 })
        .lean();
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
    const timeoutMs = Number(process.env.OTP_SEND_TIMEOUT_MS || 25000);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
        controller.abort();
        console.error(`[OTP] Email send timed out after ${timeoutMs}ms for ${email}`);
    }, timeoutMs);
    let response;
    try {
        response = await timeExternalCall(`Brevo OTP email (${email})`, () => fetch('https://api.brevo.com/v3/smtp/email', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'api-key': process.env.BREVO_API_KEY
            },
            signal: controller.signal,
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
        }));
    } catch (err) {
        if (err.name === 'AbortError') {
            throw new Error(`Email send timed out after ${timeoutMs}ms for ${email}`);
        }
        throw err;
    } finally {
        clearTimeout(timeoutId);
    }
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
    const timeoutMs = Number(process.env.OTP_SEND_TIMEOUT_MS || 25000);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
        controller.abort();
        console.error(`[OTP] SMS send timed out after ${timeoutMs}ms for ${phoneNumber}`);
    }, timeoutMs);
    let response;
    try {
        response = await timeExternalCall(`Arkesel OTP SMS (${phoneNumber})`, () => fetch('https://sms.arkesel.com/api/v2/sms/send', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'api-key': process.env.ARKESEL_API_KEY
            },
            signal: controller.signal,
            body: JSON.stringify({
                sender: process.env.ARKESEL_SENDER_ID || 'LightWatch',
                message: `Your LightWatch verification code is ${code}. It expires in 10 minutes.`,
                recipients: [phoneNumber]
            })
        }));
    } catch (err) {
        if (err.name === 'AbortError') {
            throw new Error(`SMS send timed out after ${timeoutMs}ms for ${phoneNumber}`);
        }
        throw err;
    } finally {
        clearTimeout(timeoutId);
    }
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
    const response = await timeExternalCall('Google Maps reverse geocode', () => fetch(url));
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
    // Optional — set when the person picked a location-search result or
    // used "use my location" on the signup form (see location-picker.js).
    // A hand-typed city with no picker confirmation just leaves these
    // null, same as before; /locations/map's resolveLocationCoords()
    // falls back to its table/geocoder in that case.
    const lat = Number.isFinite(Number(req.body.lat)) ? Number(req.body.lat) : null;
    const lng = Number.isFinite(Number(req.body.lng)) ? Number(req.body.lng) : null;

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

        // Same fix as /signin below: write the pending record and respond
        // first, send the actual OTP after, so the client isn't blocked on
        // Brevo/Arkesel's API round trip before it can move to the
        // verification screen.
        if (isDevLoginContact(emailPhone)) {
            console.log(`[DEV LOGIN BYPASS] Signup code for ${emailPhone} is ${code} — not actually sent.`);
        }

        await PendingVerification.findOneAndUpdate(
            { emailPhone },
            {
                type: 'signup',
                code,
                expiresAt: new Date(Date.now() + OTP_EXPIRY_MS),
                attempts: 0,
                userData: { name, emailPhone, region, city, lat, lng }
            },
            { upsert: true, new: true }
        );

        console.log(`Pending signup created for ${emailPhone}`);

        res.status(200).json({
            emailPhone,
            maskedContact: maskContact(emailPhone)
            // NOTE: the code itself is intentionally NOT included here —
            // it only goes out via the SMS/email send above.
        });

        if (!isDevLoginContact(emailPhone)) {
            sendOtp(emailPhone, code, name).catch(sendErr => {
                console.error(`[SIGNUP] OTP send failed for ${emailPhone}:`, sendErr.message);
            });
        }
        return;
    } catch (err) {
        console.error("Signup error:", err.message);
        return res.status(500).json({ error: "Server error during signup" });
    }
});

// ---- SIGN IN ----
app.post('/signin', async (req, res) => {
    const emailPhone = (req.body.emailPhone || "").toLowerCase().trim();
    console.log(`[SIGNIN] request received for ${emailPhone || '(empty)'}`);

    try {
        const foundUser = await User.findOne({ emailPhone });

        if (!foundUser) {
            console.warn(`[SIGNIN] no account found for ${emailPhone}`);
            return res.status(400).json({ error: "No account found" });
        }

        if (!foundUser.chatHandle) {
            foundUser.chatHandle = await generateUniqueChatHandle();
            await foundUser.save();
        }

        const code = isDevLoginContact(emailPhone) ? DEV_LOGIN_CODE : generateOtpCode();

        // Was: await sendOtp(...) here, BEFORE responding — the client's
        // fetch to /signin didn't resolve (and the frontend didn't route to
        // the verification screen) until Brevo/Arkesel's API round trip
        // finished, which is what the multi-second "delay when code was
        // requested and when new page was opened" was. The pending record
        // is written first (fast, local DB write) and the response goes out
        // immediately; the actual send happens after, without the user
        // waiting on it. The "Resend" flow already exists as the recovery
        // path if the send genuinely fails — see the catch below, which
        // just logs so a broken provider key doesn't fail silently.
        if (isDevLoginContact(emailPhone)) {
            console.log(`[DEV LOGIN BYPASS] Signin code for ${emailPhone} is ${code} — not actually sent.`);
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

        console.log(`[SIGNIN] pending verification created for ${emailPhone}`);

        res.json({
            userId: foundUser._id.toString(),
            maskedContact: maskContact(foundUser.emailPhone),
            chatHandle: foundUser.chatHandle
            // NOTE: the code itself is intentionally NOT included here —
            // it only goes out via the SMS/email send above.
        });

        if (!isDevLoginContact(emailPhone)) {
            sendOtp(emailPhone, code, foundUser.name)
                .then(() => console.log(`[SIGNIN] verification code sent for ${emailPhone}`))
                .catch(sendErr => {
                    console.error(`[SIGNIN] OTP send failed for ${emailPhone}:`, sendErr?.message || sendErr);
                });
        }
        return;
    } catch (err) {
        console.error(`[SIGNIN] unexpected failure for ${emailPhone}:`, err);
        return res.status(500).json({ error: `Server error during signin for ${maskContact(emailPhone)}` });
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
        let name, city, region;

        if (pending.type === 'signup') {
            const chatHandleValue = await generateUniqueChatHandle();
            const newUser = new User({
                ...pending.userData,
                chatHandle: chatHandleValue
            });
            await newUser.save();
            userId = newUser._id.toString();
            chatHandle = newUser.chatHandle;
            name = newUser.name;
            city = newUser.city;
            region = newUser.region;
            console.log("User saved to MongoDB:", newUser.emailPhone);
        } else if (pending.type === 'signin') {
            const existingUser = await User.findById(pending.userId);
            if (existingUser && !existingUser.chatHandle) {
                existingUser.chatHandle = await generateUniqueChatHandle();
                await existingUser.save();
            }
            userId = pending.userId;
            chatHandle = existingUser?.chatHandle;
            name = existingUser?.name;
            city = existingUser?.city;
            region = existingUser?.region;
        }

        await PendingVerification.deleteOne({ emailPhone });

        // name/city/region are included here (not just userId) so
        // verification.js can build its session `user` object straight from
        // this response instead of firing a second GET /user/:id round
        // trip — that second request also isn't cheap (it recomputes
        // chatCount/reportCount via two more DB queries this screen never
        // used), so this cuts real time off "verify & continue" too.
        return res.json({
            success: true,
            userId,
            maskedContact: maskContact(emailPhone),
            chatHandle,
            name,
            city,
            region
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
// Builds the same scope/location filter GET /chats and GET /chats/counts
// both need, so the two routes can never drift out of sync with each
// other. scope === 'global' → exact match. scope === 'local' → { $ne:
// 'global' } rather than { scope: 'local' }, so this still matches legacy
// Chat docs saved before the `scope` field existed (undefined scope was
// always treated as local by the old `(chat.scope || 'local')` fallback).
function buildChatsFilter(scope, location) {
    const scopeQuery = scope === 'global' ? { scope: 'global' } : { scope: { $ne: 'global' } };
    if (scope === 'global' || !location) return scopeQuery;

    // Same locationsFuzzyMatch() rule (exact match, or either string
    // containing the other), evaluated by Mongo per-document via
    // $expr/$indexOfCP instead of in JS after the fetch, so only
    // documents that actually match this location are ever read out of
    // the collection or sent over the wire.
    const normalizedLocation = normalizeLocation(location);
    return {
        ...scopeQuery,
        $expr: {
            $or: [
                { $gte: [{ $indexOfCP: ['$locationKey', normalizedLocation] }, 0] },
                { $gte: [{ $indexOfCP: [normalizedLocation, '$locationKey'] }, 0] }
            ]
        }
    };
}

app.get('/chats', async (req, res) => {
    const location = req.query.location;
    const scope = (req.query.scope || 'local').toString().toLowerCase() === 'global' ? 'global' : 'local';

    try {
        const filter = buildChatsFilter(scope, location);

        // Optional delta cursor: ?since=<ISO timestamp>. This is the
        // single hottest polling route in the app (it's in
        // NOISY_GET_ROUTES, and report.js's pollChatsOnce hits it every
        // 1.5s for as long as the Reports view is open) — and every doc
        // it returns can carry a full base64 avatarImage snapshot (up to
        // ~2MB) plus a base64 media image (up to ~1.1MB, see chatSchema).
        // Without `since`, every single poll re-fetched, re-serialized,
        // and re-gzipped up to 500 of those full documents even when
        // nothing new had actually been posted — that's the thing that
        // was quietly starving the whole process (event loop + the
        // shared Mongo connection pool) a few minutes into every
        // deploy, worse the more people had the Reports page open at
        // once. `since` lets the client ask for "just what's new since
        // I last checked" so a poll with nothing new costs almost
        // nothing, while first-load / scope-or-location switches (no
        // `since` sent) still get the full up-to-500 list exactly as
        // before. See GET /chats/counts below for how already-shown
        // messages get their like/reply counts refreshed WITHOUT
        // re-downloading any image data at all.
        const since = req.query.since ? new Date(req.query.since) : null;
        const query = (since && !isNaN(since.getTime())) ? { ...filter, createdAt: { $gt: since } } : filter;

        const chats = await Chat.find(query).sort({ createdAt: -1 }).limit(500).lean();
        return res.json(chats);
    } catch (err) {
        console.error("Get chats error:", err.message);
        return res.status(500).json({ error: "Server error fetching chats" });
    }
});

// Lightweight companion to GET /chats, purpose-built for the 1.5s poll's
// "keep every already-rendered bubble's like/reply count current" pass
// (see report.js's syncLiveStatCounts). That pass needs _id/likeCount/
// likedBy/replyTo.chatId for every message currently on screen, but has
// never needed avatarImage or media — so this route explicitly excludes
// both with .select(), which GET /chats can't do without breaking the
// image rendering that route is actually for. Same scope/location
// filter as GET /chats so the two stay in lockstep for a given view.
app.get('/chats/counts', async (req, res) => {
    const location = req.query.location;
    const scope = (req.query.scope || 'local').toString().toLowerCase() === 'global' ? 'global' : 'local';

    try {
        const filter = buildChatsFilter(scope, location);
        const counts = await Chat.find(filter)
            .select('likeCount likedBy replyTo.chatId createdAt')
            .sort({ createdAt: -1 })
            .limit(500)
            .lean();
        return res.json(counts);
    } catch (err) {
        console.error("Get chats/counts error:", err.message);
        return res.status(500).json({ error: "Server error fetching chat counts" });
    }
});

// POST /upload — general-purpose file upload endpoint (multipart/form-data,
// field name "file"). Uploads straight to Cloudinary and returns the
// hosted URL; nothing is saved to Mongo here — callers (a future route
// or the frontend) take the returned url/publicId and store it wherever
// it belongs (e.g. a Report doc, a new model, etc.). Kept separate from
// the base64-data-URL path used by avatars/chat media above.
app.post('/upload', genericUpload.single('file'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'No file received (expected multipart/form-data field "file")' });
    }
    try {
        const result = await uploadBufferToCloudinary(req.file.buffer, 'lightwatch/general');
        return res.status(201).json({
            url: result.secure_url,
            publicId: result.public_id,
            format: result.format,
            bytes: result.bytes
        });
    } catch (uploadErr) {
        console.error('Cloudinary generic upload error:', uploadErr.message);
        return res.status(502).json({ error: 'Could not upload file, please try again' });
    }
});

// Multer errors (file too large, etc.) throw before reaching the route
// handler above — this catches those so they come back as a normal
// JSON error response instead of an unhandled 500/crash.
app.use((err, req, res, next) => {
    if (err instanceof multer.MulterError) {
        return res.status(400).json({ error: `Upload error: ${err.message}` });
    }
    next(err);
});

app.post('/chats', async (req, res) => {
    const { userId, text, location, replyTo, repost, quote, media, scope } = req.body;
    const normalizedScope = (scope || 'local').toString().toLowerCase() === 'global' ? 'global' : 'local';
    const normalizedText = String(text || '').trim();
    const normalizedMediaKind = media?.kind === 'video' ? 'video' : 'image';
    const normalizedMedia = sanitizeMediaDataUrl(media?.url, normalizedMediaKind);
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

        let mediaUrl = null;
        if (normalizedMedia) {
            try {
                mediaUrl = await uploadMediaToCloudinary(normalizedMedia, normalizedMediaKind, 'lightwatch/chat-media');
            } catch (uploadErr) {
                console.error('Cloudinary chat media upload error:', uploadErr.message);
                return res.status(502).json({ error: 'Could not upload media, please try again' });
            }
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
            media: mediaUrl ? { kind: normalizedMediaKind, url: mediaUrl } : undefined,
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

        // Bump the original post's persisted repost count so every
        // viewer sees it, not just the reposting browser tab. $ne guard
        // means this only fires once per user per original post, even
        // if they somehow repost it again later.
        if (hasRepost && repost?.chatId && mongoose.Types.ObjectId.isValid(repost.chatId)) {
            Chat.updateOne(
                { _id: repost.chatId, repostedBy: { $ne: userId } },
                { $inc: { repostCount: 1 }, $addToSet: { repostedBy: userId } }
            ).catch(err => console.error('Repost count update error:', err.message));
        }

        // Quote posts need the same counted parent-reference behavior as
        // reposts: the original report keeps a shared quoteCount so other
        // people can see how many quote posts reference it.
        if (hasQuote && quote?.chatId && mongoose.Types.ObjectId.isValid(quote.chatId)) {
            Chat.updateOne(
                { _id: quote.chatId, quotedBy: { $ne: userId } },
                { $inc: { quoteCount: 1 }, $addToSet: { quotedBy: userId } }
            ).catch(err => console.error('Quote count update error:', err.message));
        }

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
                    // Keep push notifications as a signal only. The message
                    // body belongs in the thread, not in the browser/app
                    // notification surface.
                    body: isPriorityMention
                        ? 'New reply in the community'
                        : 'New community activity',
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

const CHAT_EDIT_DELETE_WINDOW_MS = 15 * 60 * 1000;

function canUserModifyChat(chat, userId) {
    if (!chat) return { allowed: false, status: 404, error: 'Post not found' };
    if (!userId || !mongoose.Types.ObjectId.isValid(userId)) {
        return { allowed: false, status: 400, error: 'Valid userId is required' };
    }

    if (!chat.userId || String(chat.userId) !== String(userId)) {
        return { allowed: false, status: 403, error: 'You can only modify your own posts' };
    }

    const createdAtMs = chat.createdAt ? new Date(chat.createdAt).getTime() : NaN;
    if (!Number.isFinite(createdAtMs)) {
        return { allowed: false, status: 400, error: 'Post timestamp is invalid' };
    }

    if ((Date.now() - createdAtMs) > CHAT_EDIT_DELETE_WINDOW_MS) {
        return { allowed: false, status: 403, error: 'Edit/delete allowed only within 15 minutes of posting' };
    }

    return { allowed: true };
}

// PATCH /chats/:chatId { userId, text }
// Owner-only and only within 15 minutes from createdAt.
app.patch('/chats/:chatId', async (req, res) => {
    const { chatId } = req.params;
    const { userId, text } = req.body || {};

    if (!mongoose.Types.ObjectId.isValid(chatId)) {
        return res.status(400).json({ error: 'Invalid chat id' });
    }

    try {
        const chat = await Chat.findById(chatId);
        const gate = canUserModifyChat(chat, userId);
        if (!gate.allowed) {
            return res.status(gate.status).json({ error: gate.error });
        }

        const normalizedText = String(text || '').trim();
        const canBeTextless = Boolean(chat.media?.url || chat.repost?.chatId || chat.quote?.chatId);
        if (!normalizedText && !canBeTextless) {
            return res.status(400).json({ error: 'Post text cannot be empty' });
        }

        chat.text = normalizedText;
        chat.editedAt = new Date();
        const saved = await chat.save();
        const chatObj = saved.toObject();
        chatObj.userId = chatObj.userId ? String(chatObj.userId) : null;
        return res.json(chatObj);
    } catch (err) {
        console.error('Edit chat error:', err.message);
        return res.status(500).json({ error: 'Server error editing post' });
    }
});

// DELETE /chats/:chatId { userId }
// Owner-only and only within 15 minutes from createdAt.
app.delete('/chats/:chatId', async (req, res) => {
    const { chatId } = req.params;
    const { userId } = req.body || {};

    if (!mongoose.Types.ObjectId.isValid(chatId)) {
        return res.status(400).json({ error: 'Invalid chat id' });
    }

    try {
        const chat = await Chat.findById(chatId);
        const gate = canUserModifyChat(chat, userId);
        if (!gate.allowed) {
            return res.status(gate.status).json({ error: gate.error });
        }

        await Chat.deleteOne({ _id: chatId });
        return res.json({ ok: true, deletedId: chatId });
    } catch (err) {
        console.error('Delete chat error:', err.message);
        return res.status(500).json({ error: 'Server error deleting post' });
    }
});

// POST /chats/:chatId/like { userId }
// Toggles the caller's like on/off (one like per user, persisted server
// side) and returns the up-to-date total so every viewer's like count
// stays in sync instead of living only in one browser's DOM.
app.post('/chats/:chatId/like', async (req, res) => {
    const { chatId } = req.params;
    const { userId } = req.body || {};

    if (!mongoose.Types.ObjectId.isValid(chatId)) {
        return res.status(400).json({ error: 'Invalid chat id' });
    }
    if (!userId || !mongoose.Types.ObjectId.isValid(userId)) {
        return res.status(400).json({ error: 'Valid userId is required' });
    }

    try {
        const chat = await Chat.findById(chatId).select('likedBy likeCount repost quote');
        if (!chat) {
            return res.status(404).json({ error: 'Post not found' });
        }

        const alreadyLiked = chat.likedBy.some(id => String(id) === String(userId));
        const update = alreadyLiked
            ? { $pull: { likedBy: userId }, $inc: { likeCount: -1 } }
            : { $addToSet: { likedBy: userId }, $inc: { likeCount: 1 } };

        const updated = await Chat.findByIdAndUpdate(chatId, update, { new: true }).select('likeCount');
        const likeCount = Math.max(0, updated?.likeCount || 0);

        const parentId = chat?.repost?.chatId || chat?.quote?.chatId;
        if (parentId && mongoose.Types.ObjectId.isValid(parentId)) {
            const parentSync = alreadyLiked
                ? { $pull: { likedBy: userId }, $inc: { likeCount: -1 } }
                : { $addToSet: { likedBy: userId }, $inc: { likeCount: 1 } };
            await Chat.updateOne(
                { _id: parentId },
                parentSync
            ).catch(err => console.error('Linked like count sync error:', err.message));
        }

        return res.json({ liked: !alreadyLiked, likeCount });
    } catch (err) {
        console.error('Like chat error:', err.message);
        return res.status(500).json({ error: 'Server error toggling like' });
    }
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
        const activeSince = new Date(Date.now() - 10 * 60 * 1000); // last 10 minutes
        const activeUsers = await AnalyticsEvent.aggregate([
            { $match: { type: { $in: ['app_open', 'screen_view'] }, createdAt: { $gte: activeSince }, userId: { $ne: null } } },
            { $group: { _id: '$userId', lastActiveAt: { $max: '$createdAt' } } }
        ]);
        const activeMap = new Map(activeUsers.map(a => [String(a._id), a.lastActiveAt]));

        const users = await User.find().sort({ createdAt: -1 }).select('name emailPhone region city chatHandle createdAt').lean();
        const results = users.map(u => ({
            ...u,
            isActive: activeMap.has(String(u._id)),
            lastActiveAt: activeMap.get(String(u._id)) || null
        }));
        return res.json(results);
    } catch (err) {
        console.error('Admin users error:', err.message);
        return res.status(500).json({ error: 'Server error fetching users' });
    }
});

// ---- ADMIN: Edit a user's primary location (protected) ----
app.patch('/admin/users/:id/location', verifyAdminToken, async (req, res) => {
    const { id } = req.params;
    const city = String(req.body?.city || '').trim();
    const region = String(req.body?.region || '').trim();
    const hasLat = Number.isFinite(Number(req.body?.lat));
    const hasLng = Number.isFinite(Number(req.body?.lng));
    const lat = hasLat ? Number(req.body.lat) : null;
    const lng = hasLng ? Number(req.body.lng) : null;

    if (!city) {
        return res.status(400).json({ error: 'City is required' });
    }
    if (!region) {
        return res.status(400).json({ error: 'Region is required' });
    }
    if (city.length < 2 || city.length > 60 || region.length < 2 || region.length > 60) {
        return res.status(400).json({ error: 'City and region must each be between 2 and 60 characters' });
    }

    try {
        const user = await User.findById(id);
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        user.city = city;
        user.region = region;
        user.cityChangeLocked = true;
        user.cityChangedAt = new Date();
        if (hasLat && hasLng) {
            user.lat = lat;
            user.lng = lng;
        }
        await user.save();

        return res.json({
            success: true,
            user: {
                id: user._id,
                name: user.name,
                emailPhone: user.emailPhone,
                region: user.region,
                city: user.city,
                chatHandle: user.chatHandle,
                createdAt: user.createdAt,
                cityChangeLocked: user.cityChangeLocked,
                cityChangedAt: user.cityChangedAt
            }
        });
    } catch (err) {
        console.error('Admin user location update error:', err.message);
        return res.status(500).json({ error: 'Server error updating user location' });
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

function maskUri(uri) {
    try {
        const parsed = new URL(uri);
        const host = parsed.host.replace(/:[0-9]+$/, '');
        return `${parsed.protocol}//${host}${parsed.pathname}`;
    } catch (err) {
        return String(uri).replace(/:[^:@/]+@/, ':***@').replace(/(\?.*)$/, '');
    }
}

app.get('/admin/health', verifyAdminToken, async (req, res) => {
    const dbState = mongoose.connection.readyState;
    const states = ['disconnected', 'connected', 'connecting', 'disconnecting'];
    let dbStatus = states[dbState] || 'unknown';
    let dbLatencyMs = null;
    try {
        const pingStart = process.hrtime.bigint();
        await mongoose.connection.db.admin().ping();
        dbLatencyMs = Number(process.hrtime.bigint() - pingStart) / 1e6;
    } catch (err) {
        dbStatus = 'error';
    }

    const cpuUsage = process.cpuUsage();
    const cpus = os.cpus().length || 1;
    const uptimeSec = process.uptime() || 1;
    const cpuPercent = Math.round(100 * ((cpuUsage.user + cpuUsage.system) / 1e6) / uptimeSec / cpus);
    const memory = process.memoryUsage();
    const totalRamMb = Math.round(os.totalmem() / 1024 / 1024);
    const usedRamMb = Math.round(memory.heapUsed / 1024 / 1024);
    const ramPercent = totalRamMb ? Math.round((usedRamMb / totalRamMb) * 100) : null;

    const avgApiLatencyMs = recentRequestDurations.length
        ? Math.round(recentRequestDurations.reduce((sum, v) => sum + v, 0) / recentRequestDurations.length)
        : null;

    const buildSettings = {
        maintenanceMode: process.env.MAINTENANCE_MODE === 'true',
        adminAccounts: {
            consoleLoginEnabled: !!ADMIN_PASSWORD,
            devLoginEnabled: !!DEV_LOGIN_EMAIL && !!DEV_LOGIN_CODE,
            devLoginEmail: DEV_LOGIN_EMAIL || null
        },
        notificationSettings: {
            webPushEnabled: !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY),
            fcmEnabled: !!fcmEnabled,
            emailOtpEnabled: !!process.env.BREVO_API_KEY,
            smsOtpEnabled: !!process.env.ARKESEL_API_KEY
        },
        newsFetchIntervalMs: Number(process.env.NEWS_FETCH_INTERVAL_MS) || 7 * 60 * 1000,
        apiKeys: {
            googleMaps: !!process.env.GOOGLE_MAPS_API_KEY,
            vapid: !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY),
            brevo: !!process.env.BREVO_API_KEY,
            arkesel: !!process.env.ARKESEL_API_KEY,
            firebase: !!process.env.FIREBASE_SERVICE_ACCOUNT_KEY
        },
        backupDatabase: {
            enabled: !!(process.env.DB_BACKUP_URL || process.env.DATABASE_BACKUP_URL),
            url: process.env.DB_BACKUP_URL ? maskUri(process.env.DB_BACKUP_URL) : process.env.DATABASE_BACKUP_URL ? maskUri(process.env.DATABASE_BACKUP_URL) : null
        }
    };

    return res.json({
        cpuPercent,
        cpuCores: cpus,
        loadAverage: os.loadavg()?.[0] ?? null,
        ramUsedMb: usedRamMb,
        ramTotalMb: totalRamMb,
        ramPercent,
        dbStatus,
        dbLatencyMs: dbLatencyMs == null ? null : Math.round(dbLatencyMs),
        avgApiLatencyMs,
        avgApiLatencySampleCount: recentRequestDurations.length,
        recentServerLogs: recentServerLogs.slice(0, 20),
        buildSettings,
        serverTime: new Date().toISOString(),
        uptimeSeconds: Math.round(process.uptime())
    });
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

// GET /locations/map — every monitored town/city in the database, each
// with resolved coordinates + current status + confidence, for the
// Mapbox locations map. Same "union of signed-up cities + ever-reported
// locations" set as /areas/known, but with the extra fields the map
// needs (and unlike /areas/known, this always returns a plottable
// position for every entry — see resolveLocationCoords()).
app.get('/locations/map', async (req, res) => {
    try {
        const [users, statuses] = await Promise.all([
            User.find().select('city region lat lng secondaryLocation').lean(),
            LightStatus.find().lean()
        ]);

        const statusByKey = new Map(statuses.map(s => [s.locationKey, s]));
        const keys = new Set(statusByKey.keys());
        // key -> { label, region, lat, lng } — carries the real place name +
        // region through to geocoding below (so Nominatim gets "Aputuogya,
        // Ashanti, Ghana" instead of just the bare, possibly ambiguous town
        // name), and a user-picker-confirmed lat/lng when one exists, so a
        // real position always wins over guessing.
        const metaByKey = new Map();
        const addKeyMeta = (rawCity, rawRegion, rawLat, rawLng) => {
            const key = normalizeLocation(rawCity).split(',')[0].trim();
            if (!key || key === 'global') return;
            keys.add(key);
            const existing = metaByKey.get(key);
            if (!existing) {
                metaByKey.set(key, { label: titleCaseLocation(rawCity), region: rawRegion || null, lat: rawLat ?? null, lng: rawLng ?? null });
            } else if ((existing.lat == null || existing.lng == null) && rawLat != null && rawLng != null) {
                // First entry for this key had no confirmed position (e.g. it
                // came in via secondaryLocation, which has none) — a later
                // user with a real picked fix for the same key fills it in.
                existing.lat = rawLat;
                existing.lng = rawLng;
            }
        };
        users.forEach(u => {
            addKeyMeta(u.city, u.region, u.lat, u.lng);
            if (u.secondaryLocation?.city) addKeyMeta(u.secondaryLocation.city, u.secondaryLocation.region, null, null);
        });

        const locations = await Promise.all(Array.from(keys).map(async (key) => {
            const record = statusByKey.get(key) || null;
            const meta = metaByKey.get(key) || null;
            const stats = await getLightStatusStats(key);
            const storedLat = record?.lat ?? meta?.lat ?? null;
            const storedLng = record?.lng ?? meta?.lng ?? null;
            const coords = await resolveLocationCoords(key, storedLat, storedLng, meta?.label, meta?.region);
            const reportedAt = record?.reportedAt || null;
            const minutesAgo = reportedAt ? Math.max(0, Math.round((Date.now() - new Date(reportedAt).getTime()) / 60000)) : null;

            return {
                name: titleCaseLocation(key),
                locationKey: key,
                lat: coords.lat,
                lng: coords.lng,
                coordsApproximate: coords.approximate,
                status: record?.status || 'unknown',
                reportedAt,
                minutesAgo,
                confirmations: stats.uniqueContributors,
                totalChecks: stats.totalChecks,
                confidence: stats.sourceConfidence
            };
        }));

        locations.sort((a, b) => a.name.localeCompare(b.name));
        return res.json({ locations });
    } catch (err) {
        console.error('Locations-map lookup error:', err.message);
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
        // req.query.userId comes straight from the client — if it's not a
        // real Mongo ObjectId (e.g. a stale/garbled session storing a
        // chatHandle-shaped string instead of the real _id), the queries
        // below throw an unhandled CastError instead of just finding no
        // rows. Treat "not a valid id" the same as "no id" rather than
        // 500ing the whole /reports response over it.
        if (!mongoose.Types.ObjectId.isValid(requestingUserId)) return [];

        const normalizedLocation = req.query.location ? normalizeLocation(req.query.location) : null;

        const [candidateLocationChats, ownChats] = await Promise.all([
            normalizedLocation
                // .select() here matters a lot more than it looks: Chat
                // documents can carry an avatarImage snapshot (up to ~2MB
                // base64) and/or a media image (up to ~1.1MB base64) — see
                // the chatSchema comments above. Nothing built below ever
                // reads either field, but without this, every call to this
                // route (including nav-badges.js's own 30s background
                // poll) was pulling full image blobs for up to 200
                // documents from Mongo just to immediately discard them —
                // real bandwidth/memory/CPU spent on data that was never
                // going to reach the client either way.
                ? Chat.find({ scope: 'local' })
                    .select('userId location locationKey handle text createdAt scope')
                    .sort({ createdAt: -1 })
                    .limit(200)
                    .lean()
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
            })
                .select('location locationKey handle text createdAt scope replyTo')
                .sort({ createdAt: -1 })
                .limit(limit)
                .lean()
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
                .select('handle text createdAt scope location')
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
        await timeExternalCall(`Web-push (${sub._id})`, () => webpush.sendNotification(sub.subscription, JSON.stringify(notification), {
            urgency: 'high',
            TTL: 60
        }));
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
    else if (notification.tone === 'news') soundResource = 'lw_news';
    const channelId = soundResource; // channel IDs in MainActivity.java match these 1:1

    try {
        await timeExternalCall(`FCM push (${sub._id})`, () => admin.messaging().send({
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
        }));
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
async function applyLightStatusUpdate(rawLocation, status, { userId = null, reportedByOverride = null, lat = null, lng = null } = {}) {
    const key = normalizeLocation(rawLocation).split(',')[0].trim();
    const keyTitle = titleCaseLocation(key);
    const hasFix = typeof lat === 'number' && typeof lng === 'number' && !Number.isNaN(lat) && !Number.isNaN(lng);

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
        { status, reportedBy, reportedAt: new Date(), ...(hasFix ? { lat, lng } : {}) },
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
    const { location, status, userId, lat, lng } = req.body;
    if (!location || !status) return res.status(400).json({ error: 'location and status required' });
    if (!['on', 'off'].includes(status)) return res.status(400).json({ error: 'status must be on or off' });

    try {
        // lat/lng are optional — sent by clients that had a GPS fix handy
        // when they reported (e.g. the map view's report action). They
        // refine that location's pin on GET /locations/map going forward;
        // a report with no fix just leaves the existing coordinates alone.
        const parsedLat = typeof lat === 'number' ? lat : parseFloat(lat);
        const parsedLng = typeof lng === 'number' ? lng : parseFloat(lng);
        const { record } = await applyLightStatusUpdate(location, status, {
            userId,
            lat: Number.isFinite(parsedLat) ? parsedLat : null,
            lng: Number.isFinite(parsedLng) ? parsedLng : null
        });
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
        const [statuses, userCities, adminLocations] = await Promise.all([
            LightStatus.find().lean(),
            User.distinct('city'),
            AdminLocation.find().lean()
        ]);

        const hiddenKeys = new Set(adminLocations.filter(l => l.hidden).map(l => l.locationKey));
        const map = new Map();

        statuses.forEach(s => {
            if (hiddenKeys.has(s.locationKey)) return;
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
            if (key && !hiddenKeys.has(key) && !map.has(key)) {
                map.set(key, {
                    locationKey: key,
                    label: titleCaseLocation(key),
                    status: 'unknown',
                    reportedBy: null,
                    reportedAt: null
                });
            }
        });
        adminLocations.filter(l => !l.hidden).forEach(l => {
            if (!map.has(l.locationKey)) {
                map.set(l.locationKey, {
                    locationKey: l.locationKey,
                    label: l.label || titleCaseLocation(l.locationKey),
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

app.post('/admin/locations', verifyAdminToken, async (req, res) => {
    const location = String(req.body?.location || '').trim();
    if (!location) {
        return res.status(400).json({ error: 'Location is required' });
    }
    const key = normalizeLocation(location).split(',')[0].trim();
    if (!key) {
        return res.status(400).json({ error: 'Invalid location' });
    }
    const label = String(req.body?.label || titleCaseLocation(key)).trim() || titleCaseLocation(key);

    try {
        const updated = await AdminLocation.findOneAndUpdate(
            { locationKey: key },
            { locationKey: key, label, hidden: false },
            { upsert: true, new: true }
        );
        return res.json({ locationKey: updated.locationKey, label: updated.label, hidden: updated.hidden });
    } catch (err) {
        console.error('Admin add location error:', err.message);
        return res.status(500).json({ error: 'Server error adding location' });
    }
});

app.delete('/admin/locations', verifyAdminToken, async (req, res) => {
    const locationKeys = Array.isArray(req.body?.locationKeys) ? req.body.locationKeys : [];
    const normalizedKeys = locationKeys
        .map(k => normalizeLocation(String(k || '')).split(',')[0].trim())
        .filter(Boolean);

    if (!normalizedKeys.length) {
        return res.status(400).json({ error: 'No valid location keys provided' });
    }

    try {
        await Promise.all(normalizedKeys.map(key => AdminLocation.findOneAndUpdate(
            { locationKey: key },
            { locationKey: key, label: titleCaseLocation(key), hidden: true },
            { upsert: true, new: true }
        )));
        return res.json({ hiddenCount: normalizedKeys.length });
    } catch (err) {
        console.error('Admin hide locations error:', err.message);
        return res.status(500).json({ error: 'Server error hiding locations' });
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
    // Optional — set when the person picked a location-search result or
    // used "use my location" on this form (see location-picker.js). A
    // hand-typed city with no picker confirmation just leaves these
    // unset, same as before.
    const hasLat = Number.isFinite(Number(req.body?.lat));
    const hasLng = Number.isFinite(Number(req.body?.lng));
    const lat = hasLat ? Number(req.body.lat) : null;
    const lng = hasLng ? Number(req.body.lng) : null;

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
        // Only overwrite existing coords if this save actually supplied a
        // fresh pair — a plain typed edit with no picker confirmation
        // shouldn't wipe out a previously-picked position.
        if (hasLat && hasLng) {
            user.lat = lat;
            user.lng = lng;
        }
        await user.save();

        return res.json({
            success: true,
            user: {
                id: user._id,
                city: user.city,
                region: user.region,
                lat: user.lat,
                lng: user.lng,
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

            // requestedHandle is already lowercase (sanitizeHandle above),
            // so an exact match hits the chatHandle index directly instead
            // of forcing a full collection scan — see the comment on
            // generateUniqueChatHandle() for why the case-insensitive
            // regex this replaced was a real performance bug, not just
            // theoretical.
            const taken = await User.findOne({
                _id: { $ne: user._id },
                chatHandle: requestedHandle
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
            if (normalizedAvatar) {
                try {
                    user.avatarImage = await uploadImageToCloudinary(normalizedAvatar, 'lightwatch/avatars');
                } catch (uploadErr) {
                    console.error('Cloudinary avatar upload error:', uploadErr.message);
                    return res.status(502).json({ error: 'Could not upload avatar, please try again' });
                }
            } else {
                // req.body.avatarImage was explicitly null/empty — clears the avatar.
                user.avatarImage = null;
            }
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

// This backend is API-only — the frontend deploys independently to
// Netlify (see the express.static comment above), so there is no
// index.html to serve here and there never will be. This used to try
// res.sendFile(path.join(__dirname, '../frontend/index.html')) as an
// SPA fallback for every unmatched request, with no error handling.
// That path never resolves on Render, so it failed on essentially
// every stray/bot/probe request that didn't match an API route —
// and each failed attempt queues an fs.stat on Node's shared libuv
// threadpool (default size 4), the SAME pool zlib uses for the
// compression() middleware wrapping every JSON response above. Enough
// of these piling up at once was starving that pool and stalling
// unrelated API responses for tens of seconds — the random
// across-every-endpoint slowness this was originally reported as.
// A plain, fast JSON 404 does no filesystem I/O at all, so it can't
// contend for that pool no matter how often it's hit.
app.get('*', (req, res) => {
    res.status(404).json({ error: 'Not found' });
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