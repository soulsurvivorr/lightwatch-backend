// ============================================================
//  ECG-AUTH.JS — ECG staff identity, organization & permission system
//
//  This is the foundation for the ECG-partnered side of LightWatch:
//  a completely separate identity system from the public User model
//  (users/signup/signin in server.js) and from the single-password
//  /admin/* super-admin panel. ECG staff are real named accounts,
//  invitation-only, scoped to an organization unit, with real
//  passwords and role-based + explicit-permission access enforced ON
//  THE SERVER for every protected route below (never trust a hidden
//  frontend button — see the security note at the bottom of this file).
//
//  ORG HIERARCHY (OrgUnit, self-referential via parentUnitId):
//      headquarters  → regional        → district
//      (nationwide)    (one region)      (one station + coverage areas)
//
//  ROLES per unit type (three tiers at every level, same shape):
//      headquarters : hq_super_admin, hq_manager, hq_staff
//      regional     : regional_manager, regional_staff
//      district     : station_manager, station_operator
//
//  Headquarters is NOT limited to one account. The hq_super_admin is
//  the single highest-authority tier (kept intentionally rare / hard
//  to grant — see canGrantRole below); hq_manager and hq_staff let
//  ECG bring on as many Headquarters employees as needed without
//  handing every one of them full administrative control.
//
//  PERMISSIONS: access is Organization Unit + Role + Permissions, not
//  role alone. Each role has a sensible default permission set
//  (ROLE_DEFAULT_PERMISSIONS below); an inviter can also grant a
//  specific invitee additional permissions from the ALL_PERMISSIONS
//  catalog, but ONLY permissions the inviter themselves currently
//  holds, and never a permission that would let the invitee out-rank
//  the inviter's own role tier. Effective permissions for a staff
//  member = role defaults ∪ their explicit `permissions` grants.
//
//  NO PUBLIC SIGNUP. The only ways an EcgStaff row gets created:
//    1. POST /ecg/invitations/:token/accept — the invited person
//       completing an invitation an authorized manager already sent
//       (org unit + role + permissions are fixed by the invitation,
//       not editable by the invitee).
//    2. The one-time HQ bootstrap route, gated behind the existing
//       super-admin password (verifyAdminToken from server.js) —
//       see POST /ecg/bootstrap/hq. This exists purely to solve the
//       chicken-and-egg problem of "who invites the first HQ Super
//       Admin"; it still produces an invitation (not a direct
//       account), so even HQ's first user goes through the accept flow.
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
//  ecg-news.js (official updates) and ecg-power.js (grid-status
//  toggles) are wired in AFTER this file and read the shared
//  models/middleware/helpers this file publishes on app.locals.ecg —
//  see each file's own header.
// ============================================================

const crypto = require('crypto');

module.exports = function setupEcgAuth(app, { mongoose, jwt, JWT_SECRET, verifyAdminToken }) {

    // ------------------------------------------------------------
    // Roles & permission catalog
    // ------------------------------------------------------------
    const ROLES = [
        'hq_super_admin', 'hq_manager', 'hq_staff',
        'regional_manager', 'regional_staff',
        'station_manager', 'station_operator'
    ];

    // Rank within a unit's tier — used to stop a manager granting a
    // permission/role that would out-rank (or match) themselves.
    const ROLE_TIER = {
        hq_super_admin: 3, hq_manager: 2, hq_staff: 1,
        regional_manager: 2, regional_staff: 1,
        station_manager: 2, station_operator: 1
    };

    const UNIT_ROLES = {
        headquarters: ['hq_super_admin', 'hq_manager', 'hq_staff'],
        regional: ['regional_manager', 'regional_staff'],
        district: ['station_manager', 'station_operator']
    };

    function roleAllowedUnderUnitType(role, unitType) {
        return (UNIT_ROLES[unitType] || []).includes(role);
    }

    const ALL_PERMISSIONS = [
        // Visibility
        'view_nationwide_status', 'view_all_regions', 'view_community_reports',
        'view_outages', 'monitor_stations', 'view_audit_log',
        // Communications / operations
        'publish_updates', 'manage_events',
        // Power / grid-status toggles (see ecg-power.js)
        'control_nationwide_power', 'control_regional_power', 'control_district_power',
        // People & org management
        'invite_staff', 'assign_roles', 'manage_staff',
        'manage_org_units', 'manage_regional_offices', 'manage_local_stations',
        'delete_org_units',
        // Sensitive / system-level
        'manage_branch_keys', 'manage_operational_permissions', 'manage_ecg_config',
        // Assets & announcements (see ecg-ops.js)
        'manage_power_plants', 'manage_transmission', 'manage_announcements', 'manage_integrations'
    ];

    // Everything HQ Super Admin gets, always, non-negotiable.
    const SUPER_ADMIN_PERMISSIONS = [...ALL_PERMISSIONS];

    const ROLE_DEFAULT_PERMISSIONS = {
        hq_super_admin: SUPER_ADMIN_PERMISSIONS,
        hq_manager: [
            'view_nationwide_status', 'view_all_regions', 'view_community_reports',
            'view_outages', 'monitor_stations', 'view_audit_log',
            'publish_updates', 'manage_events', 'invite_staff',
            'manage_power_plants', 'manage_transmission', 'manage_announcements'
            // Deliberately excluded: assign_roles beyond hq_staff, manage_staff over
            // peers/super admin, manage_org_units, delete_org_units, manage_branch_keys,
            // manage_operational_permissions, manage_ecg_config, manage_integrations,
            // control_nationwide_power. These require an explicit grant from an HQ
            // Super Admin (see canGrantRole / invitation permission checks below) —
            // never assumed by the hq_manager role.
        ],
        hq_staff: [
            'view_nationwide_status', 'view_outages', 'view_community_reports', 'monitor_stations'
        ],
        regional_manager: [
            'view_nationwide_status', 'view_all_regions', 'view_community_reports',
            'view_outages', 'monitor_stations', 'publish_updates', 'manage_events',
            'invite_staff', 'manage_local_stations', 'control_regional_power',
            'manage_power_plants', 'manage_transmission', 'manage_announcements'
        ],
        regional_staff: [
            'view_nationwide_status', 'view_community_reports', 'view_outages',
            'monitor_stations', 'control_regional_power'
        ],
        station_manager: [
            'view_community_reports', 'view_outages', 'monitor_stations',
            'publish_updates', 'manage_events', 'invite_staff', 'control_district_power',
            'manage_transmission', 'manage_announcements'
        ],
        station_operator: [
            'view_community_reports', 'view_outages', 'monitor_stations', 'control_district_power'
        ]
    };

    function effectivePermissions(staff) {
        const defaults = ROLE_DEFAULT_PERMISSIONS[staff.role] || [];
        const explicit = Array.isArray(staff.permissions) ? staff.permissions : [];
        return [...new Set([...defaults, ...explicit])];
    }

    function hasPermission(staff, permission) {
        if (staff.role === 'hq_super_admin') return true; // always all-permissions
        return effectivePermissions(staff).includes(permission);
    }

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
        createdByStaffId: { type: mongoose.Schema.Types.ObjectId, ref: 'EcgStaff', default: null },
        deletedAt: { type: Date, default: null } // soft-delete marker, see DELETE route
    });
    orgUnitSchema.index({ type: 1, region: 1 });
    orgUnitSchema.index({ parentUnitId: 1 });

    const ecgStaffSchema = new mongoose.Schema({
        name: { type: String, required: true, trim: true },
        email: { type: String, required: true, unique: true, lowercase: true, trim: true },
        passwordHash: { type: String, required: true, select: false },
        role: { type: String, enum: ROLES, required: true },
        orgUnitId: { type: mongoose.Schema.Types.ObjectId, ref: 'EcgOrgUnit', required: true },
        // Explicit extra permissions granted on top of the role's defaults —
        // e.g. one HQ Staff member given `manage_events` without becoming a
        // manager. Never used to grant a permission the granter lacked.
        permissions: { type: [String], default: [] },
        active: { type: Boolean, default: true },
        invitedByStaffId: { type: mongoose.Schema.Types.ObjectId, ref: 'EcgStaff', default: null },
        lastLoginAt: { type: Date, default: null },
        createdAt: { type: Date, default: Date.now }
    });
    ecgStaffSchema.index({ orgUnitId: 1 });

    const ecgInvitationSchema = new mongoose.Schema({
        tokenHash: { type: String, required: true, unique: true, select: false },
        email: { type: String, required: true, lowercase: true, trim: true },
        role: { type: String, enum: ROLES, required: true },
        orgUnitId: { type: mongoose.Schema.Types.ObjectId, ref: 'EcgOrgUnit', required: true },
        permissions: { type: [String], default: [] },
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
        target: { type: String, default: null }, // human-readable target/resource label
        details: { type: mongoose.Schema.Types.Mixed, default: null },
        ip: { type: String, default: null },
        userAgent: { type: String, default: null },
        createdAt: { type: Date, default: Date.now, expires: 60 * 60 * 24 * 400 } // 400-day TTL
    });
    ecgAuditLogSchema.index({ createdAt: -1 });
    ecgAuditLogSchema.index({ orgUnitId: 1, createdAt: -1 });

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

    async function logAudit({ staff, orgUnit, action, target, details, req }) {
        try {
            await EcgAuditLog.create({
                staffId: staff ? staff._id : null,
                staffEmail: staff ? staff.email : null,
                staffRole: staff ? staff.role : null,
                orgUnitId: orgUnit ? orgUnit._id : (staff ? staff.orgUnitId : null),
                orgUnitName: orgUnit ? orgUnit.name : null,
                action,
                target: target || null,
                details: details || null,
                ip: req ? (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || null) : null,
                userAgent: req ? (req.headers['user-agent'] || null) : null
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
            const all = await OrgUnit.find({ deletedAt: null }, '_id').lean();
            return all.map(u => String(u._id));
        }
        if (unit.type === 'regional') {
            const districts = await OrgUnit.find({ parentUnitId: unit._id, deletedAt: null }, '_id').lean();
            return [String(unit._id), ...districts.map(d => String(d._id))];
        }
        // district / operator: self only
        return [String(unit._id)];
    }

    // Can `staff` manage (create/edit/invite into/deactivate/delete) `targetUnit`?
    async function canManageUnit(staff, targetUnit) {
        if (!targetUnit) return false;
        const actorUnit = await OrgUnit.findById(staff.orgUnitId).lean();
        if (!actorUnit) return false;
        if (staff.role === 'hq_super_admin') return true;
        if (staff.role === 'hq_manager') {
            // HQ Manager needs the explicit permission to touch org structure at all.
            return hasPermission(staff, 'manage_org_units');
        }
        if (staff.role === 'regional_manager') {
            return String(targetUnit._id) === String(actorUnit._id) ||
                String(targetUnit.parentUnitId) === String(actorUnit._id);
        }
        if (staff.role === 'station_manager') {
            return String(targetUnit._id) === String(actorUnit._id);
        }
        return false; // *_staff / station_operator manage no org units by default
    }

    // Can `granter` invite someone into `role`, and hand them `requestedPermissions`?
    // Enforces: role must fit the target unit's tier; the invited role can never
    // out-rank (or match, except HQ Super Admin inviting another HQ Super Admin is
    // allowed, deliberately, since only a Super Admin can ever do this) the
    // granter's own tier within that unit type; and every requested permission
    // must already be one the granter effectively holds.
    function canGrantRoleAndPermissions(granter, targetUnitType, role, requestedPermissions) {
        if (!roleAllowedUnderUnitType(role, targetUnitType)) {
            return { ok: false, error: `Role "${role}" is not valid for a ${targetUnitType} unit` };
        }
        if (granter.role !== 'hq_super_admin') {
            const granterTier = ROLE_TIER[granter.role] || 0;
            const targetTier = ROLE_TIER[role] || 0;
            if (targetTier >= granterTier) {
                return { ok: false, error: 'You cannot invite someone into a role equal to or higher than your own' };
            }
        }
        const granterPerms = new Set(effectivePermissions(granter));
        const bad = (requestedPermissions || []).filter(p => !granterPerms.has(p) && granter.role !== 'hq_super_admin');
        if (bad.length > 0) {
            return { ok: false, error: `You cannot grant permissions you don't have: ${bad.join(', ')}` };
        }
        const unknown = (requestedPermissions || []).filter(p => !ALL_PERMISSIONS.includes(p));
        if (unknown.length > 0) {
            return { ok: false, error: `Unknown permission(s): ${unknown.join(', ')}` };
        }
        return { ok: true };
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
        if (!orgUnit || !orgUnit.active || orgUnit.deletedAt) return res.status(403).json({ error: 'Organization unit is inactive' });

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

    // Every route that changes something sensitive should be gated by the
    // permission it actually requires, not just a role name — this is what
    // lets an org grant/withhold a capability per-employee (see header).
    function requirePermission(...permissions) {
        return (req, res, next) => {
            if (!req.ecgStaff || !permissions.every(p => hasPermission(req.ecgStaff, p))) {
                return res.status(403).json({ error: 'You do not have the required permission for this action' });
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
            permissions: effectivePermissions(staff),
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
    //      hq_super_admin. Gated by the EXISTING super-admin password,
    //      not a new secret, so nothing new needs to be memorized/rotated. ----
    app.post('/ecg/bootstrap/hq', verifyAdminToken, async (req, res) => {
        try {
            const existingHq = await OrgUnit.findOne({ type: 'headquarters', deletedAt: null });
            let hq = existingHq;
            if (!hq) {
                hq = await OrgUnit.create({ name: 'ECG Headquarters', type: 'headquarters', region: null, parentUnitId: null });
            }

            const { email } = req.body || {};
            if (!email) return res.status(400).json({ error: 'email is required' });

            const existingStaff = await EcgStaff.findOne({ email: String(email).toLowerCase().trim() });
            if (existingStaff) return res.status(409).json({ error: 'An ECG staff account already exists for this email' });

            const token = randomToken();
            const invitation = await EcgInvitation.create({
                tokenHash: sha256(token),
                email: String(email).toLowerCase().trim(),
                role: 'hq_super_admin',
                orgUnitId: hq._id,
                permissions: [],
                expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
            });

            return res.status(201).json({
                organizationUnit: publicOrgUnit(hq),
                invitationToken: token, // shown once — send this to the first HQ Super Admin out-of-band
                acceptUrl: `/ecg-dashboard.html?invite=${token}`,
                expiresAt: invitation.expiresAt
            });
        } catch (err) {
            console.error('[ecg-auth] bootstrap error:', err.message);
            return res.status(500).json({ error: 'Server error bootstrapping ECG Headquarters' });
        }
    });

    // ---- PUBLIC: look up an invitation by token (for the accept-invite screen) ----
    app.get('/ecg/invitations/lookup', async (req, res) => {
        const token = req.query.token;
        if (!token) return res.status(400).json({ error: 'token is required' });
        const invitation = await EcgInvitation.findOne({ tokenHash: sha256(token) });
        if (!invitation || invitation.revoked || invitation.usedAt || invitation.expiresAt < new Date()) {
            return res.status(404).json({ error: 'This invitation is invalid or has expired' });
        }
        const unit = await OrgUnit.findById(invitation.orgUnitId).lean();
        return res.json({
            email: invitation.email,
            role: invitation.role,
            organizationUnit: unit ? publicOrgUnit(unit) : null,
            branchKeyRequired: invitation.branchKeyRequired
        });
    });

    // ---- PUBLIC: accept an invitation and set a password. Org unit, role,
    //      and permissions are taken ENTIRELY from the invitation — nothing
    //      in the request body can change them. ----
    app.post('/ecg/invitations/:token/accept', async (req, res) => {
        try {
            const invitation = await EcgInvitation.findOne({ tokenHash: sha256(req.params.token) });
            if (!invitation || invitation.revoked || invitation.usedAt || invitation.expiresAt < new Date()) {
                return res.status(404).json({ error: 'This invitation is invalid or has expired' });
            }
            const { name, password, branchKey } = req.body || {};
            if (!name || !password || String(password).length < 10) {
                return res.status(400).json({ error: 'Full name and a password of at least 10 characters are required' });
            }

            const unit = await OrgUnit.findById(invitation.orgUnitId).select('+branchKeyHash');
            if (!unit || unit.deletedAt) return res.status(404).json({ error: 'Organization unit no longer exists' });

            if (invitation.branchKeyRequired) {
                if (!branchKey || sha256(String(branchKey).trim()) !== unit.branchKeyHash) {
                    return res.status(403).json({ error: 'Incorrect branch access key for this station' });
                }
            }

            const staff = await EcgStaff.create({
                name: String(name).trim(),
                email: invitation.email,
                passwordHash: hashPassword(password),
                role: invitation.role,
                orgUnitId: unit._id,
                permissions: invitation.permissions || [],
                invitedByStaffId: invitation.createdByStaffId
            });

            invitation.usedAt = new Date();
            await invitation.save();

            await logAudit({ staff, orgUnit: unit, action: 'invitation_accepted', target: staff.email, req });

            const token = signStaffToken(staff);
            return res.status(201).json({ token, staff: publicStaff(staff), organizationUnit: publicOrgUnit(unit) });
        } catch (err) {
            console.error('[ecg-auth] accept invitation error:', err.message);
            return res.status(500).json({ error: 'Server error accepting invitation' });
        }
    });

    // ---- PUBLIC: staff login ----
    const loginAttempts = new Map(); // email -> { count, lockedUntil } — simple in-memory throttle
    app.post('/ecg/auth/login', async (req, res) => {
        try {
            const email = String(req.body?.email || '').toLowerCase().trim();
            const password = req.body?.password || '';
            if (!email || !password) return res.status(400).json({ error: 'email and password are required' });

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
            if (!orgUnit || orgUnit.deletedAt) return res.status(403).json({ error: 'Your organization unit is no longer active' });
            await logAudit({ staff, orgUnit, action: 'login', req });

            const token = signStaffToken(staff);
            return res.json({ token, staff: publicStaff(staff), organizationUnit: publicOrgUnit(orgUnit) });
        } catch (err) {
            console.error('[ecg-auth] login error:', err.message);
            return res.status(500).json({ error: 'Server error during login' });
        }
    });

    // ---- PROTECTED: current staff profile + permissions summary ----
    app.get('/ecg/me', verifyEcgToken, async (req, res) => {
        const unitIds = await scopedUnitIds(req.ecgStaff);
        const perms = effectivePermissions(req.ecgStaff);
        const has = p => perms.includes(p);
        return res.json({
            staff: publicStaff(req.ecgStaff),
            organizationUnit: publicOrgUnit(req.ecgOrgUnit),
            permissions: {
                list: perms,
                canManageOrgUnits: has('manage_org_units') || req.ecgStaff.role === 'regional_manager' || req.ecgStaff.role === 'hq_super_admin',
                canDeleteOrgUnits: has('delete_org_units'),
                canInviteStaff: has('invite_staff'),
                canAssignRoles: has('assign_roles') || req.ecgStaff.role === 'hq_super_admin',
                canPublishEvents: has('publish_updates'),
                canManageEvents: has('manage_events'),
                canRotateBranchKeys: has('manage_branch_keys') || ['hq_super_admin', 'regional_manager', 'station_manager'].includes(req.ecgStaff.role),
                canViewAuditLog: has('view_audit_log'),
                canControlNationwidePower: has('control_nationwide_power'),
                canControlRegionalPower: has('control_regional_power'),
                canControlDistrictPower: has('control_district_power'),
                canManageStaff: has('manage_staff') || ['hq_super_admin', 'regional_manager', 'station_manager'].includes(req.ecgStaff.role),
                canManageOperationalPermissions: has('manage_operational_permissions'),
                canManageEcgConfig: has('manage_ecg_config'),
                canManagePowerPlants: has('manage_power_plants'),
                canManageTransmission: has('manage_transmission'),
                canManageAnnouncements: has('manage_announcements'),
                canManageIntegrations: has('manage_integrations'),
                canViewRegionsOverview: req.ecgOrgUnit.type === 'headquarters',
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
        const units = await OrgUnit.find({ _id: { $in: unitIds }, deletedAt: null }).sort({ type: 1, name: 1 }).lean();
        return res.json(units.map(publicOrgUnit));
    });

    app.get('/ecg/org-units/:id', verifyEcgToken, async (req, res) => {
        const unitIds = await scopedUnitIds(req.ecgStaff);
        if (!unitIds.includes(req.params.id)) return res.status(403).json({ error: 'Forbidden' });
        const unit = await OrgUnit.findById(req.params.id).lean();
        if (!unit || unit.deletedAt) return res.status(404).json({ error: 'Not found' });
        return res.json(publicOrgUnit(unit));
    });

    // ---- PROTECTED: create a new org unit (regional under HQ, district under regional) ----
    app.post('/ecg/org-units', verifyEcgToken, async (req, res) => {
        try {
            const { name, type, region, parentUnitId, coverageAreas } = req.body || {};
            if (!name || !type) return res.status(400).json({ error: 'name and type are required' });
            if (!['regional', 'district'].includes(type)) return res.status(400).json({ error: 'type must be regional or district (headquarters is singular and pre-existing)' });

            const canCreate = req.ecgStaff.role === 'hq_super_admin' ||
                (req.ecgStaff.role === 'hq_manager' && hasPermission(req.ecgStaff, 'manage_org_units')) ||
                req.ecgStaff.role === 'regional_manager';
            if (!canCreate) return res.status(403).json({ error: 'You do not have permission to create organization units' });

            let parent = null;
            if (req.ecgStaff.role === 'regional_manager') {
                if (type !== 'district') return res.status(403).json({ error: 'Regional managers can only create district/local stations under their own region' });
                if (!hasPermission(req.ecgStaff, 'manage_local_stations')) return res.status(403).json({ error: 'Missing manage_local_stations permission' });
                parent = req.ecgOrgUnit; // force-scope: always under the caller's own regional unit
            } else {
                if (!parentUnitId) return res.status(400).json({ error: 'parentUnitId is required' });
                parent = await OrgUnit.findById(parentUnitId);
                if (!parent || parent.deletedAt) return res.status(404).json({ error: 'Parent organization unit not found' });
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

            await logAudit({ staff: req.ecgStaff, orgUnit: req.ecgOrgUnit, action: 'org_unit_created', target: unit.name, details: { newUnitId: unit._id, name: unit.name, type: unit.type }, req });

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
            if (!unit || unit.deletedAt) return res.status(404).json({ error: 'Not found' });
            if (!(await canManageUnit(req.ecgStaff, unit))) return res.status(403).json({ error: 'Forbidden' });

            const { name, coverageAreas, active } = req.body || {};
            if (name !== undefined) unit.name = String(name).trim();
            if (coverageAreas !== undefined) unit.coverageAreas = Array.isArray(coverageAreas) ? coverageAreas.map(a => String(a).trim()).filter(Boolean) : unit.coverageAreas;
            if (active !== undefined && (req.ecgStaff.role === 'hq_super_admin' || (req.ecgStaff.role === 'hq_manager' && hasPermission(req.ecgStaff, 'manage_org_units')) || req.ecgStaff.role === 'regional_manager')) {
                unit.active = Boolean(active);
            }
            await unit.save();

            await logAudit({ staff: req.ecgStaff, orgUnit: req.ecgOrgUnit, action: 'org_unit_updated', target: unit.name, details: { unitId: unit._id, changes: req.body }, req });
            return res.json(publicOrgUnit(unit));
        } catch (err) {
            console.error('[ecg-auth] update org unit error:', err.message);
            return res.status(500).json({ error: 'Server error updating organization unit' });
        }
    });

    // ---- PROTECTED: delete an org unit. Requires delete_org_units (HQ Super
    //      Admin has it by default; anyone else needs an explicit grant).
    //      Headquarters itself can never be deleted. A unit with active child
    //      units or active staff cannot be deleted until those are moved out
    //      or deactivated first — this is a deliberate, hard safety check, not
    //      just a UI confirmation, since deleting an org unit also orphans its
    //      staff and (for districts) permanently loses the branch key. ----
    app.delete('/ecg/org-units/:id', verifyEcgToken, requirePermission('delete_org_units'), async (req, res) => {
        try {
            const unit = await OrgUnit.findById(req.params.id);
            if (!unit || unit.deletedAt) return res.status(404).json({ error: 'Not found' });
            if (!(await canManageUnit(req.ecgStaff, unit))) return res.status(403).json({ error: 'Forbidden' });
            if (unit.type === 'headquarters') return res.status(400).json({ error: 'ECG Headquarters cannot be deleted' });

            const childCount = await OrgUnit.countDocuments({ parentUnitId: unit._id, deletedAt: null });
            if (childCount > 0) {
                return res.status(400).json({ error: `This unit still has ${childCount} active sub-unit(s). Delete or reassign those first.` });
            }
            const staffCount = await EcgStaff.countDocuments({ orgUnitId: unit._id, active: true });
            if (staffCount > 0 && req.query.force !== 'true') {
                return res.status(400).json({ error: `This unit still has ${staffCount} active staff account(s). Deactivate them first, or resend with ?force=true to deactivate them automatically.` });
            }
            if (staffCount > 0 && req.query.force === 'true') {
                await EcgStaff.updateMany({ orgUnitId: unit._id }, { active: false });
            }

            unit.deletedAt = new Date();
            unit.active = false;
            await unit.save();

            await logAudit({ staff: req.ecgStaff, orgUnit: req.ecgOrgUnit, action: 'org_unit_deleted', target: unit.name, details: { unitId: unit._id, type: unit.type }, req });
            return res.json({ success: true });
        } catch (err) {
            console.error('[ecg-auth] delete org unit error:', err.message);
            return res.status(500).json({ error: 'Server error deleting organization unit' });
        }
    });

    // ---- PROTECTED: rotate a district's branch key (shown once) ----
    app.post('/ecg/org-units/:id/rotate-key', verifyEcgToken, requireRole('hq_super_admin', 'hq_manager', 'regional_manager', 'station_manager'), async (req, res) => {
        try {
            const unit = await OrgUnit.findById(req.params.id).select('+branchKeyHash');
            if (!unit || unit.deletedAt) return res.status(404).json({ error: 'Not found' });
            if (unit.type !== 'district') return res.status(400).json({ error: 'Only district/local station units have branch keys' });
            if (!(await canManageUnit(req.ecgStaff, unit)) && !hasPermission(req.ecgStaff, 'manage_branch_keys')) {
                return res.status(403).json({ error: 'Forbidden' });
            }

            const branchKeyPlaintext = generateBranchKey(unit.name);
            unit.branchKeyHash = sha256(branchKeyPlaintext);
            unit.branchKeyRotatedAt = new Date();
            await unit.save();

            await logAudit({ staff: req.ecgStaff, orgUnit: req.ecgOrgUnit, action: 'branch_key_rotated', target: unit.name, details: { unitId: unit._id }, req });
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

    // ---- PROTECTED: activate/deactivate/edit a staff member, or (HQ Super
    //      Admin / permitted manager only) adjust their explicit permissions ----
    app.patch('/ecg/staff/:id', verifyEcgToken, async (req, res) => {
        try {
            const target = await EcgStaff.findById(req.params.id);
            if (!target) return res.status(404).json({ error: 'Not found' });
            const targetUnit = await OrgUnit.findById(target.orgUnitId);
            if (!(await canManageUnit(req.ecgStaff, targetUnit))) return res.status(403).json({ error: 'Forbidden' });
            if (String(target._id) === String(req.ecgStaff._id)) return res.status(400).json({ error: 'Use your own profile settings to change your own account' });
            if ((ROLE_TIER[target.role] || 0) >= (ROLE_TIER[req.ecgStaff.role] || 0) && req.ecgStaff.role !== 'hq_super_admin') {
                return res.status(403).json({ error: 'You cannot modify an account at or above your own tier' });
            }

            const { active, name, permissions } = req.body || {};
            if (active !== undefined) target.active = Boolean(active);
            if (name !== undefined) target.name = String(name).trim();
            if (permissions !== undefined) {
                if (!hasPermission(req.ecgStaff, 'manage_operational_permissions') && req.ecgStaff.role !== 'hq_super_admin') {
                    return res.status(403).json({ error: 'Missing manage_operational_permissions permission' });
                }
                const check = canGrantRoleAndPermissions(req.ecgStaff, targetUnit.type, target.role, permissions);
                if (!check.ok) return res.status(403).json({ error: check.error });
                target.permissions = [...new Set(permissions)];
            }
            await target.save();

            await logAudit({ staff: req.ecgStaff, orgUnit: req.ecgOrgUnit, action: active === false ? 'staff_deactivated' : 'staff_updated', target: target.email, details: { targetStaffId: target._id }, req });
            return res.json(publicStaff(target));
        } catch (err) {
            console.error('[ecg-auth] update staff error:', err.message);
            return res.status(500).json({ error: 'Server error updating staff' });
        }
    });

    // ---- PROTECTED: create an invitation (org unit + role + permissions
    //      fully validated server-side against the granter's own scope/tier) ----
    app.post('/ecg/invitations', verifyEcgToken, requirePermission('invite_staff'), async (req, res) => {
        try {
            const { email, role, orgUnitId, permissions } = req.body || {};
            if (!email || !role) return res.status(400).json({ error: 'email and role are required' });

            const targetUnitId = orgUnitId || req.ecgStaff.orgUnitId;
            const targetUnit = await OrgUnit.findById(targetUnitId);
            if (!targetUnit || targetUnit.deletedAt) return res.status(404).json({ error: 'Organization unit not found' });

            const withinScope = String(targetUnit._id) === String(req.ecgStaff.orgUnitId) || (await canManageUnit(req.ecgStaff, targetUnit));
            if (!withinScope) return res.status(403).json({ error: 'You cannot invite staff into that organization unit' });

            // station_manager may only invite station_operator, never another manager
            if (req.ecgStaff.role === 'station_manager' && role !== 'station_operator') {
                return res.status(403).json({ error: 'Station managers may only invite station operators' });
            }
            // regional_manager may only invite within their own region's tiers
            if (req.ecgStaff.role === 'regional_manager' && !['regional_staff', 'station_manager', 'station_operator'].includes(role)) {
                return res.status(403).json({ error: 'Regional managers may only invite regional staff or station-level roles within their region' });
            }
            // hq_manager may only invite hq_staff by default (matches the "if permitted" cap on manager-level invites)
            if (req.ecgStaff.role === 'hq_manager' && role !== 'hq_staff') {
                return res.status(403).json({ error: 'HQ Managers may only invite HQ Staff' });
            }

            const requestedPermissions = Array.isArray(permissions) ? [...new Set(permissions)] : [];
            const check = canGrantRoleAndPermissions(req.ecgStaff, targetUnit.type, role, requestedPermissions);
            if (!check.ok) return res.status(403).json({ error: check.error });

            const existingStaff = await EcgStaff.findOne({ email: String(email).toLowerCase().trim() });
            if (existingStaff) return res.status(409).json({ error: 'An ECG staff account already exists for this email' });

            const token = randomToken();
            const invitation = await EcgInvitation.create({
                tokenHash: sha256(token),
                email: String(email).toLowerCase().trim(),
                role,
                orgUnitId: targetUnit._id,
                permissions: requestedPermissions,
                branchKeyRequired: targetUnit.type === 'district',
                createdByStaffId: req.ecgStaff._id,
                expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
            });

            await logAudit({ staff: req.ecgStaff, orgUnit: req.ecgOrgUnit, action: 'invitation_created', target: email, details: { invitationId: invitation._id, email, role, orgUnitId: targetUnit._id, permissions: requestedPermissions }, req });

            return res.status(201).json({
                id: invitation._id,
                email: invitation.email,
                role: invitation.role,
                permissions: invitation.permissions,
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
                id: inv._id, email: inv.email, role: inv.role, permissions: inv.permissions, orgUnitId: inv.orgUnitId,
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
        if (!(await canManageUnit(req.ecgStaff, unit)) && String(invitation.createdByStaffId) !== String(req.ecgStaff._id)) {
            return res.status(403).json({ error: 'Forbidden' });
        }
        invitation.revoked = true;
        await invitation.save();
        await logAudit({ staff: req.ecgStaff, orgUnit: req.ecgOrgUnit, action: 'invitation_revoked', target: invitation.email, details: { invitationId: invitation._id }, req });
        return res.json({ success: true });
    });

    // ---- PROTECTED: audit log, scoped ----
    app.get('/ecg/audit-log', verifyEcgToken, requirePermission('view_audit_log'), async (req, res) => {
        const unitIds = await scopedUnitIds(req.ecgStaff);
        const limit = Math.min(Number(req.query.limit) || 100, 500);
        const entries = await EcgAuditLog.find({ orgUnitId: { $in: unitIds } }).sort({ createdAt: -1 }).limit(limit).lean();
        return res.json(entries);
    });

    // ---- PROTECTED: read-only permission catalog, for the invite form's
    //      checkbox list (filtered client-side to what the caller can grant) ----
    app.get('/ecg/permissions-catalog', verifyEcgToken, (req, res) => {
        return res.json({
            all: ALL_PERMISSIONS,
            grantable: req.ecgStaff.role === 'hq_super_admin' ? ALL_PERMISSIONS : effectivePermissions(req.ecgStaff),
            roles: ROLES,
            roleDefaults: ROLE_DEFAULT_PERMISSIONS
        });
    });

    // Publish shared internals for ecg-news.js, ecg-power.js (and any future ecg-*.js module)
    app.locals.ecg = {
        models: { OrgUnit, EcgStaff, EcgInvitation, EcgAuditLog },
        middleware: { verifyEcgToken, requireRole, requirePermission },
        helpers: { scopedUnitIds, canManageUnit, canGrantRoleAndPermissions, logAudit, publicOrgUnit, publicStaff, hasPermission, effectivePermissions },
        constants: { ROLES, ROLE_TIER, UNIT_ROLES, ALL_PERMISSIONS, ROLE_DEFAULT_PERMISSIONS }
    };

    console.log('[ecg-auth] ECG staff auth & organization routes mounted at /ecg/*');

    return app.locals.ecg;

    // ------------------------------------------------------------
    // SECURITY NOTE: every route above independently re-checks
    // authentication (verifyEcgToken), organization scope
    // (scopedUnitIds/canManageUnit), role, and permission
    // (requireRole/requirePermission/hasPermission) — the frontend
    // (ecg-dashboard.html) only ever HIDES buttons a user's token
    // wouldn't be allowed to act on; it is never the source of truth.
    // A request forged to target another station/region/unit id, or
    // to grant a permission the caller lacks, is rejected here.
    // ------------------------------------------------------------
};