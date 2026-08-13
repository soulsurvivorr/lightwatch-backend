// ============================================================
//  ECG-POWER.JS — Grid-status toggles (nationwide / regional / district)
//
//  Lets authorized ECG staff mark power as OFF or RESTORED for a scope
//  they're permitted to act on. This is a STATUS/COMMUNICATIONS system,
//  same as ecg-news.js — LightWatch has no hardware/SCADA connection to
//  the actual grid. Toggling here records an authoritative status change,
//  audits it, and pushes it into the same public feed the community
//  outage tracker (news.js's GET /news, rendered on index.html) reads —
//  it does not physically switch anything.
//
//  Scope/permission rules (enforced server-side — see ecg-auth.js's
//  security note; the frontend only hides buttons, never enforces):
//    nationwide — role hq_super_admin ONLY, permission control_nationwide_power.
//    regional   — staff whose own org unit is that regional office
//                 (regional_manager / regional_staff), permission
//                 control_regional_power. HQ Super Admin / HQ Manager
//                 with manage_org_units may also act on any region.
//    district   — staff whose own org unit is that district/local
//                 station (station_manager / station_operator),
//                 permission control_district_power. Regional/HQ roles
//                 that can manage that unit may also act on it.
//  `areas` lets a regional or district actor scope the toggle to
//  specific coverage areas/stations instead of the whole unit — pass
//  ['all'] (or omit) to mean the entire scope.
//
//  MUST be wired in AFTER ecg-auth.js (reuses its models/middleware/
//  helpers off app.locals.ecg) and works best after news.js (mirrors
//  into news.js's NewsEvent collection if it's already registered —
//  degrades gracefully to ECG-only records if not):
//      require('./ecg-power')(app, { mongoose });
// ============================================================

module.exports = function setupEcgPower(app, { mongoose }) {
    const ecg = app.locals.ecg;
    if (!ecg) {
        throw new Error('[ecg-power] app.locals.ecg is missing — require("./ecg-auth")(app, ...) must run before require("./ecg-power")(app, ...)');
    }
    const { OrgUnit, EcgStaff } = ecg.models;
    const { verifyEcgToken } = ecg.middleware;
    const { canManageUnit, logAudit, hasPermission, publicOrgUnit } = ecg.helpers;

    const powerStatusSchema = new mongoose.Schema({
        scope: { type: String, enum: ['nationwide', 'regional', 'district'], required: true },
        orgUnitId: { type: mongoose.Schema.Types.ObjectId, ref: 'EcgOrgUnit', default: null }, // null for nationwide
        orgUnitName: { type: String, default: 'Nationwide' },
        region: { type: String, default: null },
        areas: { type: [String], default: ['all'] }, // 'all' or specific coverage areas / station names
        action: { type: String, enum: ['power_off', 'power_restored'], required: true },
        reason: { type: String, default: '', trim: true, maxlength: 500 },
        byStaffId: { type: mongoose.Schema.Types.ObjectId, ref: 'EcgStaff', required: true },
        byStaffName: { type: String, required: true },
        byRole: { type: String, required: true },
        active: { type: Boolean, default: true }, // true while this outage is unresolved
        startedAt: { type: Date, default: Date.now },
        endedAt: { type: Date, default: null },
        createdAt: { type: Date, default: Date.now }
    });
    powerStatusSchema.index({ scope: 1, active: 1 });
    powerStatusSchema.index({ orgUnitId: 1, active: 1 });

    const PowerStatusChange = mongoose.models.EcgPowerStatusChange || mongoose.model('EcgPowerStatusChange', powerStatusSchema);

    // Mirrors a power event into news.js's public NewsEvent collection, so
    // it shows up in GET /news (index.html's official news feed) within
    // that route's normal cache window, badged official via sources[].official.
    // Soft dependency: if news.js hasn't registered the model yet for some
    // reason, this is a no-op rather than a hard failure.
    async function mirrorToPublicNews({ scope, unitName, region, areas, action, reason, byName }) {
        const NewsEvent = mongoose.models.NewsEvent;
        if (!NewsEvent) return;
        const isRestoration = action === 'power_restored';
        const scopeLabel = scope === 'nationwide' ? 'Nationwide' : unitName;
        const areaText = (!areas || areas.length === 0 || areas.includes('all')) ? scopeLabel : areas.join(', ');
        try {
            await NewsEvent.create({
                category: isRestoration ? 'restoration' : 'outage',
                eventType: isRestoration ? 'Power Restored' : (scope === 'nationwide' ? 'Nationwide Power Outage' : 'Power Outage'),
                headline: isRestoration
                    ? `Power restored — ${areaText}`
                    : `Power outage declared — ${areaText}`,
                summary: reason || (isRestoration ? `Power has been restored by ${byName}.` : `Power has been switched off by ${byName}.`),
                affectedLocations: (!areas || areas.includes('all')) ? [scopeLabel] : areas,
                isNationwide: scope === 'nationwide',
                startTime: new Date(),
                firstPublishedAt: new Date(),
                lastUpdatedAt: new Date(),
                dedupeKey: `ecg-power-${scope}-${unitName || 'nationwide'}-${Date.now()}`,
                sources: [{ name: 'ECG Official', icon: '⚡', official: true, url: null, resolvedUrl: null, headline: isRestoration ? 'Power Restored' : 'Power Outage Declared', publishedAt: new Date() }],
                confidenceScore: 100,
                status: isRestoration ? 'resolved' : 'active'
            });
        } catch (err) {
            console.error('[ecg-power] mirror to public news failed:', err.message);
        }
    }

    function publicChange(c) {
        return {
            id: c._id, scope: c.scope, orgUnitId: c.orgUnitId, orgUnitName: c.orgUnitName,
            region: c.region, areas: c.areas, action: c.action, reason: c.reason,
            byStaffName: c.byStaffName, byRole: c.byRole, active: c.active,
            startedAt: c.startedAt, endedAt: c.endedAt, createdAt: c.createdAt
        };
    }

    // ---- PUBLIC: current active power-status changes (for index.html /
    //      the "live status" widgets to cross-reference official state) ----
    app.get('/ecg/power/active', async (req, res) => {
        const changes = await PowerStatusChange.find({ active: true }).sort({ startedAt: -1 }).limit(100).lean();
        return res.json(changes.map(publicChange));
    });

    // ---- PROTECTED: nationwide toggle — HQ Super Admin only ----
    app.post('/ecg/power/nationwide', verifyEcgToken, async (req, res) => {
        try {
            if (req.ecgStaff.role !== 'hq_super_admin') {
                return res.status(403).json({ error: 'Only the HQ Super Admin can toggle nationwide power status' });
            }
            if (!hasPermission(req.ecgStaff, 'control_nationwide_power')) {
                return res.status(403).json({ error: 'Missing control_nationwide_power permission' });
            }
            const { action, reason } = req.body || {};
            if (!['power_off', 'power_restored'].includes(action)) return res.status(400).json({ error: 'action must be power_off or power_restored' });

            if (action === 'power_restored') {
                await PowerStatusChange.updateMany({ scope: 'nationwide', active: true }, { active: false, endedAt: new Date() });
            }
            const change = await PowerStatusChange.create({
                scope: 'nationwide', orgUnitId: null, orgUnitName: 'Nationwide', region: null, areas: ['all'],
                action, reason: reason ? String(reason).trim() : '',
                byStaffId: req.ecgStaff._id, byStaffName: req.ecgStaff.name, byRole: req.ecgStaff.role,
                active: action === 'power_off'
            });

            await logAudit({ staff: req.ecgStaff, orgUnit: req.ecgOrgUnit, action: `power_${action === 'power_off' ? 'off' : 'restored'}_nationwide`, target: 'Nationwide', details: { changeId: change._id, reason }, req });
            await mirrorToPublicNews({ scope: 'nationwide', unitName: 'Nationwide', region: null, areas: ['all'], action, reason, byName: req.ecgStaff.name });

            return res.status(201).json(publicChange(change));
        } catch (err) {
            console.error('[ecg-power] nationwide toggle error:', err.message);
            return res.status(500).json({ error: 'Server error updating nationwide power status' });
        }
    });

    // ---- PROTECTED: regional toggle — Regional Manager/Staff for their own
    //      region, or HQ roles that can manage that regional unit ----
    app.post('/ecg/power/regional', verifyEcgToken, async (req, res) => {
        try {
            const { orgUnitId, action, reason, areas } = req.body || {};
            if (!['power_off', 'power_restored'].includes(action)) return res.status(400).json({ error: 'action must be power_off or power_restored' });

            const targetUnitId = orgUnitId || (req.ecgOrgUnit.type === 'regional' ? req.ecgOrgUnit._id : null);
            if (!targetUnitId) return res.status(400).json({ error: 'orgUnitId is required' });
            const unit = await OrgUnit.findById(targetUnitId);
            if (!unit || unit.deletedAt || unit.type !== 'regional') return res.status(404).json({ error: 'Regional office not found' });

            const isOwnRegion = String(unit._id) === String(req.ecgStaff.orgUnitId);
            const canActOwn = isOwnRegion && ['regional_manager', 'regional_staff'].includes(req.ecgStaff.role) && hasPermission(req.ecgStaff, 'control_regional_power');
            const canActAsManager = !isOwnRegion && (await canManageUnit(req.ecgStaff, unit)) && hasPermission(req.ecgStaff, 'control_regional_power');
            if (!canActOwn && !canActAsManager) {
                return res.status(403).json({ error: 'You are not authorized to control power status for that region' });
            }

            const cleanAreas = Array.isArray(areas) && areas.length > 0 ? areas.map(a => String(a).trim()).filter(Boolean) : ['all'];

            if (action === 'power_restored') {
                const restoreFilter = { scope: 'regional', orgUnitId: unit._id, active: true };
                if (!cleanAreas.includes('all')) restoreFilter.areas = { $in: cleanAreas };
                await PowerStatusChange.updateMany(restoreFilter, { active: false, endedAt: new Date() });
            }
            const change = await PowerStatusChange.create({
                scope: 'regional', orgUnitId: unit._id, orgUnitName: unit.name, region: unit.region, areas: cleanAreas,
                action, reason: reason ? String(reason).trim() : '',
                byStaffId: req.ecgStaff._id, byStaffName: req.ecgStaff.name, byRole: req.ecgStaff.role,
                active: action === 'power_off'
            });

            await logAudit({ staff: req.ecgStaff, orgUnit: req.ecgOrgUnit, action: `power_${action === 'power_off' ? 'off' : 'restored'}_regional`, target: unit.name, details: { changeId: change._id, areas: cleanAreas, reason }, req });
            await mirrorToPublicNews({ scope: 'regional', unitName: unit.name, region: unit.region, areas: cleanAreas, action, reason, byName: req.ecgStaff.name });

            return res.status(201).json(publicChange(change));
        } catch (err) {
            console.error('[ecg-power] regional toggle error:', err.message);
            return res.status(500).json({ error: 'Server error updating regional power status' });
        }
    });

    // ---- PROTECTED: district toggle — Station Manager/Operator for their
    //      own station, or Regional/HQ roles that can manage that district.
    //      `areas` must be a subset of the district's real coverageAreas
    //      (or ['all']) — same rule ecg-news.js already applies to events. ----
    app.post('/ecg/power/district', verifyEcgToken, async (req, res) => {
        try {
            const { orgUnitId, action, reason, areas } = req.body || {};
            if (!['power_off', 'power_restored'].includes(action)) return res.status(400).json({ error: 'action must be power_off or power_restored' });

            const targetUnitId = orgUnitId || (req.ecgOrgUnit.type === 'district' ? req.ecgOrgUnit._id : null);
            if (!targetUnitId) return res.status(400).json({ error: 'orgUnitId is required' });
            const unit = await OrgUnit.findById(targetUnitId);
            if (!unit || unit.deletedAt || unit.type !== 'district') return res.status(404).json({ error: 'District/local station not found' });

            const isOwnStation = String(unit._id) === String(req.ecgStaff.orgUnitId);
            const canActOwn = isOwnStation && ['station_manager', 'station_operator'].includes(req.ecgStaff.role) && hasPermission(req.ecgStaff, 'control_district_power');
            const canActAsManager = !isOwnStation && (await canManageUnit(req.ecgStaff, unit)) && hasPermission(req.ecgStaff, 'control_district_power');
            if (!canActOwn && !canActAsManager) {
                return res.status(403).json({ error: 'You are not authorized to control power status for that station' });
            }

            const requestedAreas = Array.isArray(areas) && areas.length > 0 ? areas.map(a => String(a).trim()).filter(Boolean) : ['all'];
            const cleanAreas = requestedAreas.includes('all') ? ['all'] : requestedAreas;
            if (!cleanAreas.includes('all')) {
                const unknown = cleanAreas.filter(a => !unit.coverageAreas.some(c => c.toLowerCase() === a.toLowerCase()));
                if (unknown.length > 0) {
                    return res.status(400).json({ error: `These areas are not part of ${unit.name}'s assigned coverage: ${unknown.join(', ')}` });
                }
            }

            if (action === 'power_restored') {
                const restoreFilter = { scope: 'district', orgUnitId: unit._id, active: true };
                if (!cleanAreas.includes('all')) restoreFilter.areas = { $in: cleanAreas };
                await PowerStatusChange.updateMany(restoreFilter, { active: false, endedAt: new Date() });
            }
            const change = await PowerStatusChange.create({
                scope: 'district', orgUnitId: unit._id, orgUnitName: unit.name, region: unit.region, areas: cleanAreas,
                action, reason: reason ? String(reason).trim() : '',
                byStaffId: req.ecgStaff._id, byStaffName: req.ecgStaff.name, byRole: req.ecgStaff.role,
                active: action === 'power_off'
            });

            await logAudit({ staff: req.ecgStaff, orgUnit: req.ecgOrgUnit, action: `power_${action === 'power_off' ? 'off' : 'restored'}_district`, target: unit.name, details: { changeId: change._id, areas: cleanAreas, reason }, req });
            await mirrorToPublicNews({ scope: 'district', unitName: unit.name, region: unit.region, areas: cleanAreas, action, reason, byName: req.ecgStaff.name });

            return res.status(201).json(publicChange(change));
        } catch (err) {
            console.error('[ecg-power] district toggle error:', err.message);
            return res.status(500).json({ error: 'Server error updating district power status' });
        }
    });

    // ---- PROTECTED: history of power changes, scoped to what the caller can see ----
    app.get('/ecg/power/history', verifyEcgToken, async (req, res) => {
        const { scopedUnitIds } = ecg.helpers;
        const unitIds = await scopedUnitIds(req.ecgStaff);
        const limit = Math.min(Number(req.query.limit) || 100, 300);
        const filter = req.ecgOrgUnit.type === 'headquarters'
            ? {}
            : { $or: [{ scope: 'nationwide' }, { orgUnitId: { $in: unitIds } }] };
        const changes = await PowerStatusChange.find(filter).sort({ createdAt: -1 }).limit(limit).lean();
        return res.json(changes.map(publicChange));
    });

    console.log('[ecg-power] ECG power-status routes mounted at /ecg/power/*');

    return { models: { PowerStatusChange } };
};