// ============================================================
//  ECG-AUTH.JS — ECG staff identity & organization system
//
//  This is the foundation for the ECG-partnered side of LightWatch:
//  a completely separate identity system from the public User model
//  (users/signup/signin in server.js) and from the single-password
//  /admin/* super-admin panel. ECG staff are real named accounts,
//  invitation-only, scoped to an organization unit, with real
//  passwords and role-based permissions enforced ON THE SERVER for
//  every protected route below (never trust a hidden frontend button).
//
//  ORG HIERARCHY (OrgUnit, self-referential via parentUnitId):
//      headquarters  → regional        → district
//      (nationwide)    (one region)      (one station + coverage areas)
//
//  Staff (EcgStaff) belong to exactly one OrgUnit and hold one role:
//      hq_admin          — must belong to the (single) headquarters unit
//      regional_manager  — must belong to a 'regional' unit
//      district_manager  — must belong to a 'district' unit
//      station_operator  — must belong to a 'district' unit
//
//  NO PUBLIC SIGNUP. The only ways an EcgStaff row gets created:
//    1. POST /ecg/invitations/:token/accept — the invited person
//       completing an invitation an authorized manager already sent
//       (org unit + role are fixed by the invitation, not editable
//       by the invitee).
//    2. The one-time HQ bootstrap route, gated behind the existing
//       super-admin password (verifyAdminToken from server.js) —
//       see POST /ecg/bootstrap/hq. This exists purely to solve the
//       chicken-and-egg problem of "who invites the first HQ admin";
//       it still produces an invitation (not a direct account), so
//       even HQ's first user goes through the same accept flow.
//
//  BRANCH KEYS: every 'district' OrgUnit gets a private, random,
//  unpredictable branch key (never derived from the station name).
//  It is stored as a SHA-256 hash only — the plaintext is returned
//  to the caller exactly once, at creation or rotation time, and is
//  never persisted or retrievable again after that. It is never
//  included in any GET response, list, export, or public route.
//
//  Wired into server.js the same way as news.js / weather.js:
//      const ecgAuth = require('./ecg-auth')(app, {
//          mongoose, jwt, JWT_SECRET, verifyAdminToken
//      });
//  ecg-news.js (the ECG official-updates feed) is wired in AFTER
//  this file and reads the shared models/middleware this file
//  publishes on `app.locals.ecg` — see that file's header.
// ============================================================

const crypto = require('crypto');

module.exports = function setupEcgAuth(app, { mongoose, jwt, JWT_SECRET, verifyAdminToken }) {

    // ------------------------------------------------------------
    // Schemas
    // ------------------------------------------------------------
    const orgUnitSchema = new mongoose.Schema({
        name: { type: String, required: true, trim: true },
        type: { type: String, enum: ['headquarters', 'regional', 'district'], required: true },
        region: { type: String, default: null }, // set on regional + district units
        parentUnitId: { type: mongoose.Schema.Types.ObjectId, ref: 'EcgOrgUnit', default: null },
        coverageAreas: { type: [String], default: [] }, // district units: the actual towns/areas served
        active: { type: Boolean, default: true },
        // Branch key — district units only. Hash + metadata only, see header comment.
        branchKeyHash: { type: String, default: null, select: false },
        branchKeyCreatedAt: { type: Date, default: null },
        branchKeyRotatedAt: { type: Date, default: null },
        createdAt: { type: Date, default: Date.now },
        createdByStaffId: { type: mongoose.Schema.Types.ObjectId, ref: 'EcgStaff', default: null }
    });
    orgUnitSchema.index({ type: 1, region: 1 });
    orgUnitSchema.index({ parentUnitId: 1 });

    const ecgStaffSchema = new mongoose.Schema({
        name: { type: String, required: true, trim: true },
        email: { type: String, required: true, unique: true, lowercase: true, trim: true },
        passwordHash: { type: String, required: true, select: false },
        role: { type: String, enum: ['hq_admin', 'regional_manager', 'district_manager', 'station_operator'], required: true },
        orgUnitId: { type: mongoose.Schema.Types.ObjectId, ref: 'EcgOrgUnit', required: true },
        active: { type: Boolean, default: true },
        invitedByStaffId: { type: mongoose.Schema.Types.ObjectId, ref: 'EcgStaff', default: null },
        lastLoginAt: { type: Date, default: null },
        createdAt: { type: Date, default: Date.now }
    });
    ecgStaffSchema.index({ orgUnitId: 1 });

    const ecgInvitationSchema = new mongoose.Schema({
        tokenHash: { type: String, required: true, unique: true, select: false },
        email: { type: String, required: true, lowercase: true, trim: true },
        role: { type: String, enum: ['hq_admin', 'regional_manager', 'district_manager', 'station_operator'], required: true },
        orgUnitId: { type: mongoose.Schema.Types.ObjectId, ref: 'EcgOrgUnit', required: true },
        branchKeyRequired: { type: Boolean, default: false },
        createdByStaffId: { type: mongoose.Schema.Types.ObjectId, ref: 'EcgStaff', default: null },
        expiresAt: { type: Date, required: true },
        usedAt: { type: Date, default: null },
        revoked: { type: Boolean, default: false },
        createdAt: { type: Date, default: Date.now }
    });

    const ecgAuditLogSchema = new mongoose.Schema({
        staffId: { type: mongoose.Schema.Types.ObjectId, ref: 'EcgStaff', default: null },
        staffEmail: { type: String, default: null },
        staffRole: { type: String, default: null },
        orgUnitId: { type: mongoose.Schema.Types.ObjectId, ref: 'EcgOrgUnit', default: null },
        orgUnitName: { type: String, default: null },
        action: { type: String, required: true },
        details: { type: mongoose.Schema.Types.Mixed, default: null },
        ip: { type: String, default: null },
        createdAt: { type: Date, default: Date.now, expires: 60 * 60 * 24 * 400 } // 400-day TTL
    });

    const OrgUnit = mongoose.models.EcgOrgUnit || mongoose.model('EcgOrgUnit', orgUnitSchema);
    const EcgStaff = mongoose.models.EcgStaff || mongoose.model('EcgStaff', ecgStaffSchema);
    const EcgInvitation = mongoose.models.EcgInvitation || mongoose.model('EcgInvitation', ecgInvitationSchema);
    const EcgAuditLog = mongoose.models.EcgAuditLog || mongoose.model('EcgAuditLog', ecgAuditLogSchema);

    // ------------------------------------------------------------
    // Crypto helpers — no new npm dependency, Node's built-in
    // scrypt for passwords, sha256 for lookup-safe token/key hashes.
    // ------------------------------------------------------------
    function hashPassword(password) {
        const salt = crypto.randomBytes(16).toString('hex');
        const derived = crypto.scryptSync(String(password), salt, 64).toString('hex');
        return `scrypt:${salt}:${derived}`;
    }

    function verifyPassword(password, stored) {
        if (!stored || !stored.startsWith('scrypt:')) return false;
        const [, salt, hash] = stored.split(':');
        const derived = crypto.scryptSync(String(password), salt, 64).toString('hex');
        try {
            return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(derived, 'hex'));
        } catch {
            return false;
        }
    }

    function randomToken(bytes = 32) {
        return crypto.randomBytes(bytes).toString('hex');
    }

    function sha256(value) {
        return crypto.createHash('sha256').update(String(value)).digest('hex');
    }

    // Generates the human-shown branch key, e.g. "BANTAMA-ECG-7F3K9QLR".
    // The prefix is cosmetic only (derived loosely from the station
    // name so staff can eyeball which key belongs to which station on
    // the one-time reveal screen) — the actual secret is the random
    // suffix, never the name itself.
    function generateBranchKey(stationName) {
        const prefix = String(stationName || 'ECG')
            .toUpperCase()
            .replace(/[^A-Z0-9]+/g, '')
            .slice(0, 12) || 'ECG';
        const suffix = crypto.randomBytes(6).toString('hex').toUpperCase();
        return `${prefix}-ECG-${suffix}`;
    }

    function signStaffToken(staff) {
        return jwt.sign(
            { kind: 'ecg_staff', sub: String(staff._id), role: staff.role, orgUnitId: String(staff.orgUnitId) },
            JWT_SECRET,
            { expiresIn: '12h' }
        );
    }

    async function logAudit({ staff, orgUnit, action, details, req }) {
        try {
            await EcgAuditLog.create({
                staffId: staff ? staff._id : null,
                staffEmail: staff ? staff.email : null,
                staffRole: staff ? staff.role : null,
                orgUnitId: orgUnit ? orgUnit._id : (staff ? staff.orgUnitId : null),
                orgUnitName: orgUnit ? orgUnit.name : null,
                action,
                details: details || null,
                ip: req ? (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || null) : null
            });
        } catch (err) {
            console.error('[ecg-auth] audit log write failed:', err.message);
        }
    }

    // ------------------------------------------------------------
    // Org-tree scope helpers
    // ------------------------------------------------------------

    // All org unit IDs a given staff member is allowed to see/act on
    // (self + every descendant). HQ effectively gets everything.
    async function scopedUnitIds(staff) {
        const unit = await OrgUnit.findById(staff.orgUnitId).lean();
        if (!unit) return [];
        if (unit.type === 'headquarters') {
            const all = await OrgUnit.find({}, '_id').lean();
            return all.map(u => String(u._id));
        }
        if (unit.type === 'regional') {
            const districts = await OrgUnit.find({ parentUnitId: unit._id }, '_id').lean();
            return [String(unit._id), ...districts.map(d => String(d._id))];
        }
        // district / operator: self only
        return [String(unit._id)];
    }

    // Can `staff` manage (create/edit/invite into/deactivate) `targetUnit`?
    async function canManageUnit(staff, targetUnit) {
        if (!targetUnit) return false;
        const actorUnit = await OrgUnit.findById(staff.orgUnitId).lean();
        if (!actorUnit) return false;
        if (staff.role === 'hq_admin') return true;
        if (staff.role === 'regional_manager') {
            return String(targetUnit._id) === String(actorUnit._id) ||
                String(targetUnit.parentUnitId) === String(actorUnit._id);
        }
        if (staff.role === 'district_manager') {
            return String(targetUnit._id) === String(actorUnit._id);
        }
        return false; // station_operator manages nothing
    }

    function roleAllowedUnderUnitType(role, unitType) {
        if (unitType === 'headquarters') return role === 'hq_admin';
        if (unitType === 'regional') return role === 'regional_manager';
        if (unitType === 'district') return role === 'district_manager' || role === 'station_operator';
        return false;
    }

    // ------------------------------------------------------------
    // Middleware
    // ------------------------------------------------------------
    async function verifyEcgToken(req, res, next) {
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) return res.status(401).json({ error: 'Missing authorization token' });
        let decoded;
        try {
            decoded = jwt.verify(token, JWT_SECRET);
        } catch {
            return res.status(401).json({ error: 'Invalid or expired token' });
        }
        if (decoded.kind !== 'ecg_staff') return res.status(403).json({ error: 'Forbidden' });

        const staff = await EcgStaff.findById(decoded.sub);
        if (!staff || !staff.active) return res.status(401).json({ error: 'Account is no longer active' });

        const orgUnit = await OrgUnit.findById(staff.orgUnitId);
        if (!orgUnit || !orgUnit.active) return res.status(403).json({ error: 'Organization unit is inactive' });

        req.ecgStaff = staff;
        req.ecgOrgUnit = orgUnit;
        next();
    }

    function requireRole(...roles) {
        return (req, res, next) => {
            if (!req.ecgStaff || !roles.includes(req.ecgStaff.role)) {
                return res.status(403).json({ error: 'You do not have permission to perform this action' });
            }
            next();
        };
    }

    // ------------------------------------------------------------
    // Serialization helpers (never leak passwordHash / branchKeyHash)
    // ------------------------------------------------------------
    function publicStaff(staff) {
        return {
            id: staff._id,
            name: staff.name,
            email: staff.email,
            role: staff.role,
            orgUnitId: staff.orgUnitId,
            active: staff.active,
            lastLoginAt: staff.lastLoginAt,
            createdAt: staff.createdAt
        };
    }

    function publicOrgUnit(unit) {
        return {
            id: unit._id,
            name: unit.name,
            type: unit.type,
            region: unit.region,
            parentUnitId: unit.parentUnitId,
            coverageAreas: unit.coverageAreas,
            active: unit.active,
            hasBranchKey: unit.type === 'district' ? Boolean(unit.branchKeyHash) : undefined,
            branchKeyRotatedAt: unit.branchKeyRotatedAt,
            createdAt: unit.createdAt
        };
    }

    // ==============================================================
    // ROUTES
    // ==============================================================

    // ---- One-time-per-deploy bootstrap: create HQ + invite the first
    //      hq_admin. Gated by the EXISTING super-admin password, not a
    //      new secret, so nothing new needs to be memorized/rotated. ----
    app.post('/ecg/bootstrap/hq', verifyAdminToken, async (req, res) => {
        try {
            const { email, name } = req.body || {};
            if (!email || !name) return res.status(400).json({ error: 'name and email are required' });

            let hq = await OrgUnit.findOne({ type: 'headquarters' });
            if (!hq) {
                hq = await OrgUnit.create({ name: 'ECG Headquarters', type: 'headquarters' });
            }

            const existingStaffCount = await EcgStaff.countDocuments({ orgUnitId: hq._id, role: 'hq_admin' });
            if (existingStaffCount > 0) {
                return res.status(409).json({ error: 'HQ already has at least one admin. Use the invitations endpoint from an existing HQ admin account instead.' });
            }

            const token = randomToken();
            const invitation = await EcgInvitation.create({
                tokenHash: sha256(token),
                email: String(email).toLowerCase().trim(),
                role: 'hq_admin',
                orgUnitId: hq._id,
                branchKeyRequired: false,
                expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
            });

            await logAudit({ staff: null, orgUnit: hq, action: 'bootstrap_hq_invitation_created', details: { email, invitationId: invitation._id }, req });

            return res.json({
                success: true,
                orgUnit: publicOrgUnit(hq),
                invitationToken: token,
                acceptUrl: `/ecg-dashboard.html?invite=${token}`,
                expiresAt: invitation.expiresAt
            });
        } catch (err) {
            console.error('[ecg-auth] bootstrap error:', err.message);
            return res.status(500).json({ error: 'Server error during ECG bootstrap' });
        }
    });

    // ---- PUBLIC: look up an invitation (no sensitive data returned) ----
    app.get('/ecg/invitations/:token', async (req, res) => {
        try {
            const invitation = await EcgInvitation.findOne({ tokenHash: sha256(req.params.token) }).select('+tokenHash');
            if (!invitation) return res.status(404).json({ error: 'Invitation not found' });
            if (invitation.revoked) return res.status(410).json({ error: 'This invitation has been revoked' });
            if (invitation.usedAt) return res.status(410).json({ error: 'This invitation has already been used' });
            if (invitation.expiresAt < new Date()) return res.status(410).json({ error: 'This invitation has expired' });

            const orgUnit = await OrgUnit.findById(invitation.orgUnitId).lean();
            return res.json({
                email: invitation.email,
                role: invitation.role,
                requiresBranchKey: invitation.branchKeyRequired,
                organizationUnit: orgUnit ? { name: orgUnit.name, type: orgUnit.type, region: orgUnit.region } : null
            });
        } catch (err) {
            console.error('[ecg-auth] invitation lookup error:', err.message);
            return res.status(500).json({ error: 'Server error looking up invitation' });
        }
    });

    // ---- PUBLIC: accept an invitation → creates the EcgStaff account.
    //      Organization/region/station/role are NEVER accepted from the
    //      request body — they come only from the stored invitation. ----
    app.post('/ecg/invitations/:token/accept', async (req, res) => {
        try {
            const { password, branchKey } = req.body || {};
            if (!password || String(password).length < 10) {
                return res.status(400).json({ error: 'Password must be at least 10 characters' });
            }

            const invitation = await EcgInvitation.findOne({ tokenHash: sha256(req.params.token) }).select('+tokenHash');
            if (!invitation) return res.status(404).json({ error: 'Invitation not found' });
            if (invitation.revoked) return res.status(410).json({ error: 'This invitation has been revoked' });
            if (invitation.usedAt) return res.status(410).json({ error: 'This invitation has already been used' });
            if (invitation.expiresAt < new Date()) return res.status(410).json({ error: 'This invitation has expired' });

            const orgUnit = await OrgUnit.findById(invitation.orgUnitId).select('+branchKeyHash');
            if (!orgUnit || !orgUnit.active) return res.status(409).json({ error: 'The associated organization unit is no longer active' });

            if (invitation.branchKeyRequired) {
                if (!branchKey || !orgUnit.branchKeyHash || sha256(branchKey.trim()) !== orgUnit.branchKeyHash) {
                    return res.status(401).json({ error: 'Branch key is missing or incorrect. Contact your station manager.' });
                }
            }

            const existing = await EcgStaff.findOne({ email: invitation.email });
            if (existing) return res.status(409).json({ error: 'An ECG staff account already exists for this email' });

            const staff = await EcgStaff.create({
                name: req.body?.name?.trim() || invitation.email.split('@')[0],
                email: invitation.email,
                passwordHash: hashPassword(password),
                role: invitation.role,
                orgUnitId: invitation.orgUnitId,
                invitedByStaffId: invitation.createdByStaffId
            });

            invitation.usedAt = new Date();
            await invitation.save();

            await logAudit({ staff, orgUnit, action: 'invitation_accepted', details: { invitationId: invitation._id }, req });

            const authToken = signStaffToken(staff);
            return res.json({ token: authToken, staff: publicStaff(staff), organizationUnit: publicOrgUnit(orgUnit) });
        } catch (err) {
            console.error('[ecg-auth] invitation accept error:', err.message);
            return res.status(500).json({ error: 'Server error accepting invitation' });
        }
    });

    // ---- PUBLIC: staff login ----
    const loginAttempts = new Map(); // email -> { count, lockedUntil }
    app.post('/ecg/auth/login', async (req, res) => {
        try {
            const email = String(req.body?.email || '').toLowerCase().trim();
            const password = req.body?.password || '';
            if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });

            const attempt = loginAttempts.get(email) || { count: 0, lockedUntil: 0 };
            if (attempt.lockedUntil > Date.now()) {
                return res.status(429).json({ error: `Too many attempts. Try again in ${Math.ceil((attempt.lockedUntil - Date.now()) / 60000)}m.` });
            }

            const staff = await EcgStaff.findOne({ email }).select('+passwordHash');
            const passwordOk = staff && verifyPassword(password, staff.passwordHash);

            if (!staff || !passwordOk) {
                attempt.count += 1;
                if (attempt.count >= 5) {
                    attempt.lockedUntil = Date.now() + 10 * 60 * 1000;
                    attempt.count = 0;
                }
                loginAttempts.set(email, attempt);
                return res.status(401).json({ error: 'Incorrect email or password' });
            }
            if (!staff.active) return res.status(403).json({ error: 'This account has been deactivated' });

            loginAttempts.delete(email);
            staff.lastLoginAt = new Date();
            await staff.save();

            const orgUnit = await OrgUnit.findById(staff.orgUnitId);
            await logAudit({ staff, orgUnit, action: 'login', req });

            const token = signStaffToken(staff);
            return res.json({ token, staff: publicStaff(staff), organizationUnit: orgUnit ? publicOrgUnit(orgUnit) : null });
        } catch (err) {
            console.error('[ecg-auth] login error:', err.message);
            return res.status(500).json({ error: 'Server error during login' });
        }
    });

    // ---- PROTECTED: current staff profile + permissions summary ----
    app.get('/ecg/me', verifyEcgToken, async (req, res) => {
        const unitIds = await scopedUnitIds(req.ecgStaff);
        return res.json({
            staff: publicStaff(req.ecgStaff),
            organizationUnit: publicOrgUnit(req.ecgOrgUnit),
            permissions: {
                canManageOrgUnits: ['hq_admin', 'regional_manager'].includes(req.ecgStaff.role),
                canInviteStaff: ['hq_admin', 'regional_manager', 'district_manager'].includes(req.ecgStaff.role),
                canPublishEvents: true,
                canRotateBranchKeys: ['hq_admin', 'regional_manager', 'district_manager'].includes(req.ecgStaff.role),
                canViewAuditLog: true,
                scopedUnitCount: unitIds.length
            }
        });
    });

    app.post('/ecg/auth/logout', verifyEcgToken, async (req, res) => {
        await logAudit({ staff: req.ecgStaff, orgUnit: req.ecgOrgUnit, action: 'logout', req });
        return res.json({ success: true });
    });

    // ---- PROTECTED: org unit tree, scoped to what this staff can see ----
    app.get('/ecg/org-units', verifyEcgToken, async (req, res) => {
        const unitIds = await scopedUnitIds(req.ecgStaff);
        const units = await OrgUnit.find({ _id: { $in: unitIds } }).sort({ type: 1, name: 1 }).lean();
        return res.json(units.map(publicOrgUnit));
    });

    app.get('/ecg/org-units/:id', verifyEcgToken, async (req, res) => {
        const unitIds = await scopedUnitIds(req.ecgStaff);
        if (!unitIds.includes(req.params.id)) return res.status(403).json({ error: 'Forbidden' });
        const unit = await OrgUnit.findById(req.params.id).lean();
        if (!unit) return res.status(404).json({ error: 'Not found' });
        return res.json(publicOrgUnit(unit));
    });

    // ---- PROTECTED: create a new org unit (regional under HQ, district under regional) ----
    app.post('/ecg/org-units', verifyEcgToken, requireRole('hq_admin', 'regional_manager'), async (req, res) => {
        try {
            const { name, type, region, parentUnitId, coverageAreas } = req.body || {};
            if (!name || !type) return res.status(400).json({ error: 'name and type are required' });
            if (!['regional', 'district'].includes(type)) return res.status(400).json({ error: 'type must be regional or district (headquarters is singular and pre-existing)' });

            let parent = null;
            if (req.ecgStaff.role === 'regional_manager') {
                if (type !== 'district') return res.status(403).json({ error: 'Regional managers can only create district/local stations under their own region' });
                parent = req.ecgOrgUnit; // force-scope: always under the caller's own regional unit
            } else {
                if (!parentUnitId) return res.status(400).json({ error: 'parentUnitId is required' });
                parent = await OrgUnit.findById(parentUnitId);
                if (!parent) return res.status(404).json({ error: 'Parent organization unit not found' });
                if (type === 'regional' && parent.type !== 'headquarters') return res.status(400).json({ error: 'A regional office must be created under headquarters' });
                if (type === 'district' && parent.type !== 'regional') return res.status(400).json({ error: 'A district/local station must be created under a regional office' });
            }

            const unit = await OrgUnit.create({
                name: name.trim(),
                type,
                region: type === 'district' ? parent.region : (region ? String(region).trim() : name.trim()),
                parentUnitId: parent._id,
                coverageAreas: Array.isArray(coverageAreas) ? coverageAreas.map(a => String(a).trim()).filter(Boolean) : [],
                createdByStaffId: req.ecgStaff._id
            });

            let branchKeyPlaintext = null;
            if (type === 'district') {
                branchKeyPlaintext = generateBranchKey(unit.name);
                unit.branchKeyHash = sha256(branchKeyPlaintext);
                unit.branchKeyCreatedAt = new Date();
                await unit.save();
            }

            await logAudit({ staff: req.ecgStaff, orgUnit: req.ecgOrgUnit, action: 'org_unit_created', details: { newUnitId: unit._id, name: unit.name, type: unit.type }, req });

            const response = publicOrgUnit(unit);
            if (branchKeyPlaintext) response.branchKey = branchKeyPlaintext; // shown exactly once
            return res.status(201).json(response);
        } catch (err) {
            console.error('[ecg-auth] create org unit error:', err.message);
            return res.status(500).json({ error: 'Server error creating organization unit' });
        }
    });

    // ---- PROTECTED: update name / coverage areas / active status ----
    app.patch('/ecg/org-units/:id', verifyEcgToken, async (req, res) => {
        try {
            const unit = await OrgUnit.findById(req.params.id);
            if (!unit) return res.status(404).json({ error: 'Not found' });
            if (!(await canManageUnit(req.ecgStaff, unit))) return res.status(403).json({ error: 'Forbidden' });

            const { name, coverageAreas, active } = req.body || {};
            if (name !== undefined) unit.name = String(name).trim();
            if (coverageAreas !== undefined) unit.coverageAreas = Array.isArray(coverageAreas) ? coverageAreas.map(a => String(a).trim()).filter(Boolean) : unit.coverageAreas;
            if (active !== undefined && ['hq_admin', 'regional_manager'].includes(req.ecgStaff.role)) unit.active = Boolean(active);
            await unit.save();

            await logAudit({ staff: req.ecgStaff, orgUnit: req.ecgOrgUnit, action: 'org_unit_updated', details: { unitId: unit._id, changes: req.body }, req });
            return res.json(publicOrgUnit(unit));
        } catch (err) {
            console.error('[ecg-auth] update org unit error:', err.message);
            return res.status(500).json({ error: 'Server error updating organization unit' });
        }
    });

    // ---- PROTECTED: rotate a district's branch key (shown once) ----
    app.post('/ecg/org-units/:id/rotate-key', verifyEcgToken, requireRole('hq_admin', 'regional_manager', 'district_manager'), async (req, res) => {
        try {
            const unit = await OrgUnit.findById(req.params.id).select('+branchKeyHash');
            if (!unit) return res.status(404).json({ error: 'Not found' });
            if (unit.type !== 'district') return res.status(400).json({ error: 'Only district/local station units have branch keys' });
            if (!(await canManageUnit(req.ecgStaff, unit))) return res.status(403).json({ error: 'Forbidden' });

            const branchKeyPlaintext = generateBranchKey(unit.name);
            unit.branchKeyHash = sha256(branchKeyPlaintext);
            unit.branchKeyRotatedAt = new Date();
            await unit.save();

            await logAudit({ staff: req.ecgStaff, orgUnit: req.ecgOrgUnit, action: 'branch_key_rotated', details: { unitId: unit._id }, req });
            return res.json({ success: true, branchKey: branchKeyPlaintext, rotatedAt: unit.branchKeyRotatedAt });
        } catch (err) {
            console.error('[ecg-auth] rotate key error:', err.message);
            return res.status(500).json({ error: 'Server error rotating branch key' });
        }
    });

    // ---- PROTECTED: staff list, scoped ----
    // Includes orgUnitName/orgUnitType alongside each staff row — this is
    // what lets a manager visually confirm "this account is assigned to
    // the station/region I meant it to be" instead of just seeing a role.
    app.get('/ecg/staff', verifyEcgToken, async (req, res) => {
        const unitIds = await scopedUnitIds(req.ecgStaff);
        const staff = await EcgStaff.find({ orgUnitId: { $in: unitIds } }).sort({ createdAt: -1 }).lean();
        const units = await OrgUnit.find({ _id: { $in: [...new Set(staff.map(s => String(s.orgUnitId)))] } }, 'name type region').lean();
        const unitById = new Map(units.map(u => [String(u._id), u]));
        return res.json(staff.map(s => {
            const unit = unitById.get(String(s.orgUnitId));
            return {
                ...publicStaff(s),
                orgUnitName: unit ? unit.name : null,
                orgUnitType: unit ? unit.type : null,
                orgUnitRegion: unit ? unit.region : null
            };
        }));
    });

    // ---- PROTECTED: activate/deactivate/edit a staff member ----
    app.patch('/ecg/staff/:id', verifyEcgToken, async (req, res) => {
        try {
            const target = await EcgStaff.findById(req.params.id);
            if (!target) return res.status(404).json({ error: 'Not found' });
            const targetUnit = await OrgUnit.findById(target.orgUnitId);
            if (!(await canManageUnit(req.ecgStaff, targetUnit))) return res.status(403).json({ error: 'Forbidden' });
            if (String(target._id) === String(req.ecgStaff._id)) return res.status(400).json({ error: 'Use your own profile settings to change your own account' });

            const { active, name } = req.body || {};
            if (active !== undefined) target.active = Boolean(active);
            if (name !== undefined) target.name = String(name).trim();
            await target.save();

            await logAudit({ staff: req.ecgStaff, orgUnit: req.ecgOrgUnit, action: active === false ? 'staff_deactivated' : 'staff_updated', details: { targetStaffId: target._id }, req });
            return res.json(publicStaff(target));
        } catch (err) {
            console.error('[ecg-auth] update staff error:', err.message);
            return res.status(500).json({ error: 'Server error updating staff' });
        }
    });

    // ---- PROTECTED: create an invitation (org unit + role fixed server-side by scope) ----
    app.post('/ecg/invitations', verifyEcgToken, requireRole('hq_admin', 'regional_manager', 'district_manager'), async (req, res) => {
        try {
            const { email, role, orgUnitId } = req.body || {};
            if (!email || !role) return res.status(400).json({ error: 'email and role are required' });

            const targetUnitId = orgUnitId || req.ecgStaff.orgUnitId;
            const targetUnit = await OrgUnit.findById(targetUnitId);
            if (!targetUnit) return res.status(404).json({ error: 'Organization unit not found' });
            if (!(await canManageUnit(req.ecgStaff, targetUnit))) return res.status(403).json({ error: 'You cannot invite staff into that organization unit' });
            if (!roleAllowedUnderUnitType(role, targetUnit.type)) return res.status(400).json({ error: `Role "${role}" is not valid for a ${targetUnit.type} unit` });

            // district_manager may only invite station_operator, never another district_manager
            if (req.ecgStaff.role === 'district_manager' && role !== 'station_operator') {
                return res.status(403).json({ error: 'District managers may only invite station operators' });
            }

            const existingStaff = await EcgStaff.findOne({ email: String(email).toLowerCase().trim() });
            if (existingStaff) return res.status(409).json({ error: 'An ECG staff account already exists for this email' });

            const token = randomToken();
            const invitation = await EcgInvitation.create({
                tokenHash: sha256(token),
                email: String(email).toLowerCase().trim(),
                role,
                orgUnitId: targetUnit._id,
                branchKeyRequired: targetUnit.type === 'district',
                createdByStaffId: req.ecgStaff._id,
                expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
            });

            await logAudit({ staff: req.ecgStaff, orgUnit: req.ecgOrgUnit, action: 'invitation_created', details: { invitationId: invitation._id, email, role, orgUnitId: targetUnit._id }, req });

            return res.status(201).json({
                id: invitation._id,
                email: invitation.email,
                role: invitation.role,
                organizationUnit: publicOrgUnit(targetUnit),
                invitationToken: token, // shown once — send this to the invitee out-of-band
                acceptUrl: `/ecg-dashboard.html?invite=${token}`,
                expiresAt: invitation.expiresAt
            });
        } catch (err) {
            console.error('[ecg-auth] create invitation error:', err.message);
            return res.status(500).json({ error: 'Server error creating invitation' });
        }
    });

    // Same visual-confirmation fix as GET /ecg/staff above, applied to
    // pending invitations — so you can see exactly where an invite will
    // land before (and after) it's accepted, not just who it's for.
    app.get('/ecg/invitations', verifyEcgToken, async (req, res) => {
        const unitIds = await scopedUnitIds(req.ecgStaff);
        const invitations = await EcgInvitation.find({ orgUnitId: { $in: unitIds }, usedAt: null, revoked: false })
            .sort({ createdAt: -1 }).lean();
        const units = await OrgUnit.find({ _id: { $in: [...new Set(invitations.map(i => String(i.orgUnitId)))] } }, 'name type region').lean();
        const unitById = new Map(units.map(u => [String(u._id), u]));
        return res.json(invitations.map(inv => {
            const unit = unitById.get(String(inv.orgUnitId));
            return {
                id: inv._id, email: inv.email, role: inv.role, orgUnitId: inv.orgUnitId,
                orgUnitName: unit ? unit.name : null,
                orgUnitType: unit ? unit.type : null,
                expiresAt: inv.expiresAt, createdAt: inv.createdAt
            };
        }));
    });

    app.delete('/ecg/invitations/:id', verifyEcgToken, async (req, res) => {
        const invitation = await EcgInvitation.findById(req.params.id);
        if (!invitation) return res.status(404).json({ error: 'Not found' });
        const unit = await OrgUnit.findById(invitation.orgUnitId);
        if (!(await canManageUnit(req.ecgStaff, unit))) return res.status(403).json({ error: 'Forbidden' });
        invitation.revoked = true;
        await invitation.save();
        await logAudit({ staff: req.ecgStaff, orgUnit: req.ecgOrgUnit, action: 'invitation_revoked', details: { invitationId: invitation._id }, req });
        return res.json({ success: true });
    });

    // ---- PROTECTED: audit log, scoped ----
    app.get('/ecg/audit-log', verifyEcgToken, async (req, res) => {
        const unitIds = await scopedUnitIds(req.ecgStaff);
        const limit = Math.min(Number(req.query.limit) || 100, 500);
        const entries = await EcgAuditLog.find({ orgUnitId: { $in: unitIds } }).sort({ createdAt: -1 }).limit(limit).lean();
        return res.json(entries);
    });

    // Publish shared internals for ecg-news.js (and any future ecg-*.js module)
    app.locals.ecg = {
        models: { OrgUnit, EcgStaff, EcgInvitation, EcgAuditLog },
        middleware: { verifyEcgToken, requireRole },
        helpers: { scopedUnitIds, canManageUnit, logAudit, publicOrgUnit, publicStaff }
    };

    console.log('[ecg-auth] ECG staff auth & organization routes mounted at /ecg/*');

    return app.locals.ecg;
};