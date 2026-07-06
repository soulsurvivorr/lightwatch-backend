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
    chatHandle: { type: String },
    createdAt: { type: Date, default: Date.now }
});

const chatSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    handle: { type: String, required: true },
    text: { type: String, required: true },
    location: { type: String, required: true },
    locationKey: { type: String, required: true },
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
    subscription: { type: Object, required: true }, // full browser push subscription object
    createdAt:    { type: Date, default: Date.now }
});
pushSubscriptionSchema.index({ 'subscription.endpoint': 1 }, { unique: true });

const User             = mongoose.model('User', userSchema);
const Chat             = mongoose.model('Chat', chatSchema);
const LightStatus      = mongoose.model('LightStatus', lightStatusSchema);
const LightStatusEvent = mongoose.model('LightStatusEvent', lightStatusEventSchema);
const PushSubscription = mongoose.model('PushSubscription', pushSubscriptionSchema);

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

    const noisyRoutes = [
        '/lightstatus',
        '/user/',
        '/chats'
    ];

    const isNoisyGet =
        req.method === 'GET' &&
        noisyRoutes.some(route => req.url.startsWith(route));

    if (!isNoisyGet) {
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
function buildOtpEmailHtml(code) {
    const year = new Date().getFullYear();
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
                  Hi there,
                </p>
                <p style="margin:0 0 24px 0; font-size:15px; line-height:1.6; color:#1f2430;">
                  Use the code below to verify your email and finish setting up your LightWatch account.
                </p>
              </td>
            </tr>

            <!-- OTP code -->
            <tr>
              <td align="center" style="padding:0 32px 24px 32px;">
                <div style="display:inline-block; padding:16px 32px; background:linear-gradient(135deg,#f4c95d,#5b8def); border-radius:10px;">
                  <span style="font-size:32px; font-weight:700; letter-spacing:8px; color:#0a0e1a;">
                    ${code}
                  </span>
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

async function sendOtpEmail(email, code) {
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
            htmlContent: buildOtpEmailHtml(code),
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
async function sendOtp(emailPhone, code) {
    const isEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailPhone);
    if (isEmail) {
        await sendOtpEmail(emailPhone, code);
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
            await sendOtp(emailPhone, code);
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
            await sendOtp(emailPhone, code);
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

    try {
        await sendOtp(emailPhone, code);
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

    try {
        const allChats = await Chat.find().sort({ createdAt: -1 }).limit(500).lean();

        if (location) {
            const normalizedLocation = normalizeLocation(location);
            const filtered = allChats.filter(chat => {
                const chatLoc = normalizeLocation(chat.location || chat.locationKey || '');
                if (!chatLoc) return false;
                return chatLoc === normalizedLocation || chatLoc.includes(normalizedLocation) || normalizedLocation.includes(chatLoc);
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
    const { userId, text, location } = req.body;
    if (!userId || !text || !location) {
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

        const normalizedLocation = normalizeLocation(location);
        const savedLocation = location.trim();

        const newChat = new Chat({
            userId,
            handle: user.chatHandle,
            text,
            location: savedLocation,
            locationKey: normalizedLocation
        });
        const saved = await newChat.save();

        const chatObj = saved.toObject();
        chatObj.userId = chatObj.userId.toString();
        console.log('Chat saved:', { id: chatObj._id.toString(), handle: chatObj.handle, location: chatObj.location });
        const key = normalizeLocation(saved.location).split(',')[0].trim();
        const payload = JSON.stringify({
            title: `LightWatch chat — ${key}`,
            body: `${saved.handle}: ${saved.text}`,
            url: '/pages/home.html',
            tag: 'chat-message'
        });

        const subscribers = await PushSubscription.find({ location: key });
        console.log(`Sending chat push to ${subscribers.length} subscriber(s) at ${key}`);

        const pushPromises = subscribers.map(async sub => {
            if (sub.userId && String(sub.userId) === String(userId)) {
                return;
            }
            try {
                await webpush.sendNotification(sub.subscription, payload);
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
        const users = await User.find().sort({ createdAt: -1 }).select('-_id name emailPhone region city chatHandle createdAt');
        return res.json(users);
    } catch (err) {
        console.error('Admin users error:', err.message);
        return res.status(500).json({ error: 'Server error fetching users' });
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
    try {
        const events = await LightStatusEvent.find().sort({ reportedAt: -1 }).limit(limit).lean();

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

        const user = userId ? await User.findById(userId).select('chatHandle') : null;
        const reportedBy = user?.chatHandle || userId || 'anonymous';

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
            title: `LightWatch — ${key}`,
            body: `${emoji} Light is now ${status.toUpperCase()} in ${key}.`,
            url: '/pages/home.html'
        });

        const subscribers = await PushSubscription.find({ location: key });
        console.log(`Sending push to ${subscribers.length} subscriber(s) at ${key}`);

        const pushPromises = subscribers.map(async sub => {
            try {
                await webpush.sendNotification(sub.subscription, payload);
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
            { userId, location: locationKey, subscription },
            { upsert: true, new: true }
        );

        return res.json({ success: true });
    } catch (err) {
        console.error('Subscribe error:', err.message);
        return res.status(500).json({ error: 'Server error saving subscription' });
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