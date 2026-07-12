const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');

require('dotenv').config();
const mongoose = require('mongoose');
const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const webpush = require('web-push');

// MONGODB CONNECTION
const MONGO_URI = process.env.MONGODB_URI;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin123";
const JWT_SECRET = process.env.JWT_SECRET || "your-secret-key-change-this";

if (!MONGO_URI) {
    console.error("FATAL: MONGODB_URI environment variable is not set.");
    process.exit(1);
}

if (!process.env.JWT_SECRET) {
    console.warn("WARNING: JWT_SECRET not set in environment. Using default (insecure). Set it on Render.");
}
if (!process.env.ADMIN_PASSWORD) {
    console.warn("WARNING: ADMIN_PASSWORD not set in environment. Using default. Set it on Render.");
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

// Log a masked version of the URI so we can confirm which form is being used (no secrets printed)
try {
    const prefix = MONGO_URI.indexOf('://') !== -1 ? MONGO_URI.split('://')[0] + '://' : '';
    const hostPart = MONGO_URI.replace(/.*@/, '').slice(0, 40);
    console.log('Using MONGO_URI:', prefix + hostPart.replace(/:.*/, ':***'));
} catch (e) {
    console.log('Using MONGO_URI: (masked)');
}

mongoose.connect(MONGO_URI, {
    serverSelectionTimeoutMS: 10000,
    family: 4
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

// Enable mongoose debug output to see queries and connection activity in server logs
mongoose.set('debug', true);

// SCHEMAS / MODELS
const userSchema = new mongoose.Schema({
    name: { type: String, required: true },
    emailPhone: { type: String, required: true, unique: true },
    region: { type: String, required: true },
    city: { type: String, required: true },
    cityChangeLocked: { type: Boolean, default: false },
    cityChangedAt: { type: Date, default: null },
    chatHandle: { type: String },
    // Optional second monitored location (e.g. "Work") — separate from the
    // primary signup region/city above, which stays the account's home base.
    secondaryLocation: {
        label:  { type: String, default: null }, // "Work", "Family house", etc.
        city:   { type: String, default: null },
        region: { type: String, default: null }
    },
    createdAt: { type: Date, default: Date.now }
});

const chatSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    handle: { type: String, required: true },
    text: { type: String, required: true },
    scope: { type: String, enum: ['local', 'global'], default: 'local' },
    replyTo: {
        chatId: { type: String },
        handle: { type: String },
        text: { type: String }
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

// Push subscription — one per device, upserted on endpoint
const pushSubscriptionSchema = new mongoose.Schema({
    userId:       { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    location:     { type: String, required: true }, // normalised location key
    muteGlobalChat: { type: Boolean, default: false },
    chatMentionsEnabled: { type: Boolean, default: true },
    // Second location this device wants "status changed" alerts for.
    // null/unset = not watching a second location. Set/cleared from the
    // "Notify me here" toggle on the second-location panel (home.js) via
    // PATCH /subscribe/preferences. Looked up directly by the
    // POST /lightstatus handler whenever a location's status flips.
    secondaryLocationKey:   { type: String, default: null },
    secondaryLocationLabel: { type: String, default: null },
    subscription: { type: Object, required: true }, // full browser push subscription object
    createdAt:    { type: Date, default: Date.now }
});
pushSubscriptionSchema.index({ 'subscription.endpoint': 1 }, { unique: true });

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

app.use(cors());
app.use(express.json());

// Serves /public/logo.png etc. at https://<your-render-domain>/logo.png
// so it can be referenced by an absolute URL inside emails (Brevo needs
// a public URL for images — it does not support cid: inline images).
app.use(express.static('public'));

// Set this to your real Render URL (e.g. https://lightwatch-api.onrender.com)
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || 'https://lightwatch-backend.onrender.com';
const LOGO_URL = `${PUBLIC_BASE_URL}/logo.png`;

app.use((req, res, next) => {

    const noisyGetRoutes = [
        '/lightstatus',
        '/user/',
        '/chats'
    ];

    const isNoisyGet =
        req.method === 'GET' &&
        noisyGetRoutes.some(route => req.url.startsWith(route));

    // The typing heartbeat fires every ~2s per active typist in both
    // directions (POST to ping, DELETE to clear) — noisy the same way
    // the GET polls above are, just not a GET.
    const isTypingRoute = req.url.startsWith('/chats/typing');

    if (!isNoisyGet && !isTypingRoute) {
        console.log(req.method, req.url);
    }

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
const HANDLE_WORDS = [
    "fern", "river", "glow", "cedar", "amber", "quartz",
    "willow", "ember", "harbor", "maple", "drift", "stone"
];

async function generateUniqueChatHandle() {
    while (true) {
        const word = HANDLE_WORDS[Math.floor(Math.random() * HANDLE_WORDS.length)];
        const number = Math.floor(Math.random() * 900) + 100;
        const handle = `anon-${word}-${number}`;
        const existing = await User.findOne({ chatHandle: handle });
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

// ---------------------------------------------------------------------------
// ROUTES
// ---------------------------------------------------------------------------

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
        const exists = await User.findOne({ emailPhone });
        if (exists) {
            return res.status(400).json({ error: "Account already exists" });
        }

        const code = generateOtpCode();

        try {
            await sendOtp(emailPhone, code, name);
        } catch (sendErr) {
            console.error("Failed to send signup OTP:", sendErr.message);
            return res.status(500).json({ error: "Could not send verification code. Please try again." });
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

        const code = generateOtpCode();

        try {
            await sendOtp(emailPhone, code, foundUser.name);
        } catch (sendErr) {
            console.error("Failed to send signin OTP:", sendErr.message);
            return res.status(500).json({ error: "Could not send verification code. Please try again." });
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

    const code = generateOtpCode();

    // Same name the original code's email used — from the signup form
    // data still sitting on the pending doc, or looked back up for an
    // existing user signing in.
    let name;
    if (pending.type === 'signup') {
        name = pending.userData?.name;
    } else if (pending.type === 'signin') {
        const existingUser = await User.findById(pending.userId);
        name = existingUser?.name;
    }

    try {
        await sendOtp(emailPhone, code, name);
    } catch (sendErr) {
        console.error("Failed to resend OTP:", sendErr.message);
        return res.status(500).json({ error: "Could not send verification code. Please try again." });
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
        const allChats = await Chat.find().sort({ createdAt: -1 }).limit(500).lean();

        if (scope === 'global') {
            const globalChats = allChats.filter(chat => (chat.scope || 'local') === 'global');
            return res.json(globalChats);
        }

        const localChats = allChats.filter(chat => (chat.scope || 'local') !== 'global');

        if (location) {
            const normalizedLocation = normalizeLocation(location);
            const filtered = localChats.filter(chat => {
                const chatLoc = normalizeLocation(chat.location || chat.locationKey || '');
                return locationsFuzzyMatch(chatLoc, normalizedLocation);
            });
            return res.json(filtered);
        }

        return res.json(localChats);
    } catch (err) {
        console.error("Get chats error:", err.message);
        return res.status(500).json({ error: "Server error fetching chats" });
    }
});

app.post('/chats', async (req, res) => {
    const { userId, text, location, replyTo, scope } = req.body;
    const normalizedScope = (scope || 'local').toString().toLowerCase() === 'global' ? 'global' : 'local';
    if (!userId || !text || (normalizedScope === 'local' && !location)) {
        return res.status(400).json({ error: "Missing user, text, or location" });
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
            text,
            scope: normalizedScope,
            replyTo: replyTo ? {
                chatId: String(replyTo.chatId || ''),
                handle: String(replyTo.handle || '').slice(0, 80),
                text: String(replyTo.text || '').slice(0, 220)
            } : undefined,
            location: savedLocation,
            locationKey: normalizedLocation
        });
        const saved = await newChat.save();

        const chatObj = saved.toObject();
        chatObj.userId = chatObj.userId.toString();
        console.log('Chat saved:', { id: chatObj._id.toString(), handle: chatObj.handle, location: chatObj.location });
        const key = normalizeLocation(saved.location).split(',')[0].trim();
        const isGlobalChat = normalizedScope === 'global';
        const audienceTitle = isGlobalChat ? 'Everyone' : titleCaseLocation(key);
        const replyTargetChat = replyTo?.chatId
            ? await Chat.findById(replyTo.chatId).select('userId handle text').lean()
            : null;

        const subscribers = isGlobalChat
            ? await PushSubscription.find({})
            : await PushSubscription.find({ location: key });
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

            const payload = JSON.stringify({
                title: isPriorityMention
                    ? `Reply in ${audienceTitle}`
                    : `LightWatch chat — ${audienceTitle}`,
                body: isPriorityMention
                    ? `${saved.handle} replied to your message: ${saved.text}`
                    : `${saved.handle}: ${saved.text}`,
                url: `/pages/home.html?${deepLinkParams.toString()}`,
                tag: isPriorityMention ? 'chat-reply' : 'chat-message',
                requireInteraction: true,
                vibrate: isPriorityMention ? [280, 120, 280] : [240, 120, 240],
                chatScope: normalizedScope,
                isReply: isReplyForThisUser,
                isMention: isMentionForThisUser
            });

            try {
                await webpush.sendNotification(sub.subscription, payload, {
                    urgency: 'high',
                    TTL: 60
                });
            } catch (err) {
                if (err.statusCode === 410) {
                    await PushSubscription.deleteOne({ _id: sub._id });
                    console.log('Removed stale subscription:', sub._id);
                } else {
                    console.error('Chat push send error:', err.statusCode, err.body, err.message);
                }
            }
        });
        Promise.allSettled(pushPromises);
        return res.status(201).json(chatObj);
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

// ---- ADMIN LOGIN ----
app.post('/admin/login', (req, res) => {
    const { password } = req.body;
    if (!password || password !== ADMIN_PASSWORD) {
        return res.status(401).json({ error: "Incorrect password" });
    }
    const token = jwt.sign({ role: 'admin' }, JWT_SECRET, { expiresIn: '24h' });
    return res.json({ token });
});

// ---- ADMIN: Recent chats (protected) ----
app.get('/admin/chats', verifyAdminToken, async (req, res) => {
    try {
        const recent = await Chat.find().sort({ createdAt: -1 }).limit(100).populate('userId', 'name emailPhone chatHandle');
        return res.json(recent);
    } catch (err) {
        console.error('Admin chats error:', err.message);
        return res.status(500).json({ error: 'Server error fetching admin chats' });
    }
});

// ---- ADMIN: All users (protected) ----
app.get('/admin/users', verifyAdminToken, async (req, res) => {
    try {
        const users = await User.find().sort({ createdAt: -1 }).select('name emailPhone region city chatHandle createdAt');
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

        const userCount    = await User.countDocuments();
        const newUsers24h  = await User.countDocuments({ createdAt: { $gte: oneDayAgo } });
        const chatCount    = await Chat.countDocuments();
        const newChats24h  = await Chat.countDocuments({ createdAt: { $gte: oneDayAgo } });

        return res.json({ userCount, newUsers24h, chatCount, newChats24h });
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
        const record = await LightStatus.findOne({ locationKey: key });
        const stats = await getLightStatusStats(key);
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

app.get('/reports', async (req, res) => {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 30, 1), 100);

    // Optional scoping — both additive, existing callers with no query
    // params keep getting the same global feed as before.
    const query = {};
    if (req.query.location) {
        query.locationKey = normalizeLocation(req.query.location).split(',')[0].trim();
    }
    if (req.query.userId) {
        query.userId = req.query.userId;
    }

    try {
        const events = await LightStatusEvent.find(query).sort({ reportedAt: -1 }).limit(limit).lean();

        function titleCaseLocation(key) {
            return key.split(',')[0]
                .split(' ')
                .map(word => word.charAt(0).toUpperCase() + word.slice(1))
                .join(' ');
        }

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

        return res.json(reports);
    } catch (err) {
        console.error('Reports fetch error:', err.message);
        return res.status(500).json({ error: 'Server error fetching reports' });
    }
});

// POST /lightstatus  { location, status, userId }
app.post('/lightstatus', async (req, res) => {
    const { location, status, userId } = req.body;
    if (!location || !status) return res.status(400).json({ error: 'location and status required' });
    if (!['on', 'off'].includes(status)) return res.status(400).json({ error: 'status must be on or off' });

    try {
        const key = normalizeLocation(location).split(',')[0].trim();
        const keyTitle = titleCaseLocation(key);

        const user = userId ? await User.findById(userId).select('chatHandle') : null;
        const reportedBy = user?.chatHandle || userId || 'anonymous';

        // Captured before the upsert so we can tell whether this report
        // actually *changed* the status, vs. just re-confirming the same
        // one — secondary-location watchers should only be pinged on a
        // real flip, not on every single report.
        const previous = await LightStatus.findOne({ locationKey: key }).select('status').lean();
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

        console.log(`Light status updated: ${key} => ${status}`);

        // ── Send push notifications to all subscribers at this location ──
        const emoji = status === 'on' ? '💡' : '🌑';
        const payload = JSON.stringify({
            title: `LightWatch — ${keyTitle}`,
            body: `${emoji} Light is now ${status.toUpperCase()} in ${keyTitle}.`,
            url: '/pages/home.html',
            tag: 'light-status',
            requireInteraction: status === 'off',
            vibrate: status === 'off' ? [300, 120, 300, 120, 300] : [180, 90, 180]
        });

        const subscribers = await PushSubscription.find({ location: key });
        console.log(`Sending push to ${subscribers.length} subscriber(s) at ${key}`);

        const pushPromises = subscribers.map(async sub => {
            try {
                await webpush.sendNotification(sub.subscription, payload, {
                    urgency: 'high',
                    TTL: 60
                });
            } catch (err) {
                if (err.statusCode === 410) {
                    await PushSubscription.deleteOne({ _id: sub._id });
                    console.log('Removed stale subscription:', sub._id);
                } else {
                    console.error('Push send error:', err.statusCode, err.body, err.message);
                }
            }
        });

        // Don't block the response waiting for pushes
        Promise.allSettled(pushPromises);

        // ── Send push to anyone watching this as a SECOND location ──
        // Only on a genuine change, and to a completely separate
        // subscriber set (secondaryLocationKey, not location) so someone
        // watching Bantama as their primary and Adum as their second gets
        // exactly one push per real event, worded appropriately for each.
        if (statusChanged) {
            const secondaryEmoji = status === 'on' ? '💡' : '🌑';
            const secondaryPayload = JSON.stringify({
                title: `Second location — ${keyTitle}`,
                body: `${secondaryEmoji} ${keyTitle} just changed to ${status.toUpperCase()}.`,
                url: '/pages/home.html',
                tag: 'secondary-light-status',
                requireInteraction: status === 'off',
                vibrate: status === 'off' ? [300, 120, 300, 120, 300] : [180, 90, 180]
            });

            const secondarySubscribers = await PushSubscription.find({ secondaryLocationKey: key });
            console.log(`Sending secondary-location push to ${secondarySubscribers.length} subscriber(s) watching ${key}`);

            const secondaryPushPromises = secondarySubscribers.map(async sub => {
                try {
                    await webpush.sendNotification(sub.subscription, secondaryPayload, {
                        urgency: 'high',
                        TTL: 60
                    });
                } catch (err) {
                    if (err.statusCode === 410) {
                        await PushSubscription.deleteOne({ _id: sub._id });
                        console.log('Removed stale subscription:', sub._id);
                    } else {
                        console.error('Secondary-location push error:', err.statusCode, err.body, err.message);
                    }
                }
            });

            Promise.allSettled(secondaryPushPromises);
        }

        return res.json(record);
    } catch (err) {
        console.error('Light status error:', err.message);
        return res.status(500).json({ error: 'Server error' });
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

// ---- HEALTH CHECK ----
app.get('/', (req, res) => {
    const dbState = mongoose.connection.readyState;
    const states = ['disconnected', 'connected', 'connecting', 'disconnecting'];
    res.json({
        status: "LightWatch backend is running",
        mongodb: states[dbState] || 'unknown'
    });
});

// START
const PORT = process.env.PORT || 3000;

function startServer(port) {
    const server = app.listen(port, () => {
        console.log(`Server running on port ${port}`);
    });

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
        badge
    } = req.body || {};

    if (!location) {
        return res.status(400).json({ error: 'location is required' });
    }

    try {
        const key = normalizeLocation(location).split(',')[0].trim();
        const subscribers = await PushSubscription.find({ location: key });

        if (!subscribers.length) {
            return res.status(404).json({ error: 'No subscribers found for this location' });
        }

        const keyTitle = titleCaseLocation(key);
        const payload = JSON.stringify({
            title: title || `LightWatch test — ${keyTitle}`,
            body: body || 'Testing heads-up push behavior on this device.',
            url: url || '/pages/home.html',
            tag: tag || `test-${Date.now()}`,
            requireInteraction: typeof requireInteraction === 'boolean' ? requireInteraction : true,
            vibrate: Array.isArray(vibrate) ? vibrate : [300, 120, 300, 120, 300],
            image: image || undefined,
            icon: icon || undefined,
            badge: badge || undefined
        });

        const pushPromises = subscribers.map(async sub => {
            try {
                await webpush.sendNotification(sub.subscription, payload, {
                    urgency: 'high',
                    TTL: 60
                });
                return { ok: true };
            } catch (err) {
                if (err.statusCode === 410) {
                    await PushSubscription.deleteOne({ _id: sub._id });
                    return { ok: false, stale: true };
                }
                console.error('Admin push test error:', err.statusCode, err.body, err.message);
                return { ok: false, statusCode: err.statusCode || 500 };
            }
        });

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