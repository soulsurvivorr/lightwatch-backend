const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');

require('dotenv').config();
const mongoose = require('mongoose');
const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');

// ---------------------------------------------------------------------------
// MONGODB CONNECTION
// Reads from environment variable on Render. NEVER hardcode the URI here.
// In Render dashboard -> your service -> Environment -> add:
//   MONGODB_URI = mongodb+srv://...   (or the mongodb:// shard form you have)
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// SCHEMAS / MODELS
// ---------------------------------------------------------------------------
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

const User = mongoose.model('User', userSchema);
const Chat = mongoose.model('Chat', chatSchema);

console.log("MY SERVER FILE IS RUNNING");

// ---------------------------------------------------------------------------
// APP / MIDDLEWARE
// ---------------------------------------------------------------------------
const app = express();

app.use(cors());
app.use(express.json());

app.use((req, res, next) => {
    console.log(req.method, req.url);
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

// ---------------------------------------------------------------------------
// HELPERS
// ---------------------------------------------------------------------------
const HANDLE_WORDS = [
    "fern", "river", "glow", "cedar", "amber", "quartz",
    "willow", "ember", "harbor", "maple", "drift", "stone"
];

async function generateUniqueChatHandle() {
    while (true) {
        const word = HANDLE_WORDS[Math.floor(Math.random() * HANDLE_WORDS.length)];
        const number = Math.floor(Math.random() * 900) + 100; // 100-999
        const handle = `anon-${word}-${number}`;

        const existing = await User.findOne({ chatHandle: handle });
        if (!existing) {
            return handle;
        }
    }
}

function normalizeLocation(value) {
    if (!value) return "";
    return value.toString().trim().toLowerCase().replace(/\s+/g, ' ');
}

// In-memory pending verification store. This is fine to keep in memory
// (it's short-lived, single-use data) — it does NOT need to be in MongoDB.
// Keyed by emailPhone. Code is hardcoded '5687' for now.
const pendingVerifications = {};

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

    const { name, emailPhone, region, city } = req.body;

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

        pendingVerifications[emailPhone] = {
            type: 'signup',
            code: '5687',
            userData: { name, emailPhone, region, city }
        };

        console.log(`Pending signup created for ${emailPhone} (code: 5687)`);

        return res.status(200).json({
            emailPhone,
            maskedContact: maskContact(emailPhone),
            code: '5687'
        });
    } catch (err) {
        console.error("Signup error:", err.message);
        return res.status(500).json({ error: "Server error during signup" });
    }
});

// ---- SIGN IN ----
app.post('/signin', async (req, res) => {
    console.log("SIGNIN ROUTE HIT");
    const { emailPhone } = req.body;

    try {
        const foundUser = await User.findOne({ emailPhone });

        if (!foundUser) {
            return res.status(400).json({ error: "No account found" });
        }

        if (!foundUser.chatHandle) {
            foundUser.chatHandle = await generateUniqueChatHandle();
            await foundUser.save();
        }

        pendingVerifications[emailPhone] = {
            type: 'signin',
            code: '5687',
            userId: foundUser._id.toString()
        };

        console.log(`Pending signin created for ${emailPhone} (code: 5687)`);

        return res.json({
            userId: foundUser._id.toString(),
            maskedContact: maskContact(foundUser.emailPhone),
            chatHandle: foundUser.chatHandle,
            code: '5687'
        });
    } catch (err) {
        console.error("Signin error:", err.message);
        return res.status(500).json({ error: "Server error during signin" });
    }
});

// ---- VERIFY ----
app.post('/verify', async (req, res) => {
    const { emailPhone, code } = req.body;
    if (!emailPhone || !code) {
        return res.status(400).json({ error: "Email/phone and code are required" });
    }

    const pending = pendingVerifications[emailPhone];
    if (!pending || pending.code !== code) {
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

        delete pendingVerifications[emailPhone];
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

// ---- CHATS ----
app.get('/chats', async (req, res) => {
    const location = req.query.location;

    try {
        // Fetch chats and populate user info for richer client display
        let query = Chat.find().sort({ createdAt: -1 }).limit(500).populate('userId', 'name emailPhone chatHandle');
        const allChats = await query.exec();

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

        // populate user info for response and server logs
        await saved.populate('userId', 'name emailPhone chatHandle');

        console.log('Chat saved:', { id: saved._id.toString(), user: saved.userId.emailPhone, handle: saved.userId.chatHandle, location: saved.location });

        return res.status(201).json(saved);
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
        
        const userCount = await User.countDocuments();
        const newUsers24h = await User.countDocuments({ createdAt: { $gte: oneDayAgo } });
        const chatCount = await Chat.countDocuments();
        const newChats24h = await Chat.countDocuments({ createdAt: { $gte: oneDayAgo } });
        
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

        return res.json(user);
    } catch (err) {
        console.error("User lookup error:", err.message);
        return res.status(404).json({ error: "User not found" });
    }
});

// ---- HEALTH CHECK ----
// Useful to quickly verify the server + DB are alive from a browser.
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