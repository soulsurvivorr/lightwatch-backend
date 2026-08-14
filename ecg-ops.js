// ============================================================
//  ECG-OPS.JS — Power Plants, Transmission, Regions, Announcements,
//               Analytics, Settings, Integrations, System Health
//
//  Backs the rest of ecg-dashboard.html's nav (everything ecg-auth.js
//  / ecg-news.js / ecg-power.js don't already cover). Same shared-
//  internals pattern as those files: reuses app.locals.ecg instead of
//  redefining models/middleware, and every protected route re-checks
//  auth + org scope + permission on the server (see ecg-auth.js's
//  security note — the frontend only ever hides buttons).
//
//  Scope rules (mirrors ecg-power.js / ecg-news.js):
//    headquarters — sees/manages everything.
//    regional     — sees/manages assets in their own region + its
//                    districts; can view (not manage) other regions
//                    if they hold view_all_regions.
//    district     — sees assets tied to their own station/region,
//                    read-only unless explicitly granted a manage_*
//                    permission (station_manager gets manage_transmission
//                    and manage_announcements by default; see
//                    ecg-auth.js's ROLE_DEFAULT_PERMISSIONS).
//
//  New permissions this file relies on (added to ecg-auth.js's
//  ALL_PERMISSIONS / ROLE_DEFAULT_PERMISSIONS):
//      manage_power_plants, manage_transmission,
//      manage_announcements, manage_integrations
//
//  Wire in AFTER ecg-auth.js (and ecg-power.js/ecg-news.js, order
//  between those three doesn't matter to this file):
//      require('./ecg-ops')(app, { mongoose });
// ============================================================

module.exports = function setupEcgOps(app, { mongoose }) {
    const ecg = app.locals.ecg;
    if (!ecg) {
        throw new Error('[ecg-ops] app.locals.ecg is missing — require("./ecg-auth")(app, ...) must run before require("./ecg-ops")(app, ...)');
    }
    const { OrgUnit, EcgStaff, EcgAuditLog } = ecg.models;
    const { verifyEcgToken, requirePermission } = ecg.middleware;
    const { scopedUnitIds, canManageUnit, logAudit, hasPermission } = ecg.helpers;

    const GHANA_REGIONS = [
        'Ahafo', 'Ashanti', 'Bono', 'Bono East', 'Central', 'Eastern', 'Greater Accra',
        'North East', 'Northern', 'Oti', 'Savannah', 'Upper East', 'Upper West',
        'Volta', 'Western', 'Western North'
    ];

    // ------------------------------------------------------------
    // Schemas
    // ------------------------------------------------------------
    const powerPlantSchema = new mongoose.Schema({
        name: { type: String, required: true, trim: true },
        plantType: { type: String, enum: ['hydro', 'thermal', 'solar', 'wind', 'other'], required: true },
        region: { type: String, required: true },
        orgUnitId: { type: mongoose.Schema.Types.ObjectId, ref: 'EcgOrgUnit', default: null }, // owning regional office
        capacityMW: { type: Number, required: true, min: 0 },
        currentOutputMW: { type: Number, default: 0, min: 0 },
        status: { type: String, enum: ['operational', 'degraded', 'maintenance', 'offline'], default: 'operational' },
        operator: { type: String, default: 'ECG / VRA', trim: true },
        commissionedYear: { type: Number, default: null },
        lat: { type: Number, default: null },
        lng: { type: Number, default: null },
        createdByStaffId: { type: mongoose.Schema.Types.ObjectId, ref: 'EcgStaff', default: null },
        createdAt: { type: Date, default: Date.now },
        updatedAt: { type: Date, default: Date.now }
    });
    powerPlantSchema.index({ region: 1 });
    const PowerPlant = mongoose.models.EcgPowerPlant || mongoose.model('EcgPowerPlant', powerPlantSchema);

    const transmissionLineSchema = new mongoose.Schema({
        name: { type: String, required: true, trim: true },
        fromSubstation: { type: String, required: true, trim: true },
        toSubstation: { type: String, required: true, trim: true },
        region: { type: String, required: true },
        orgUnitId: { type: mongoose.Schema.Types.ObjectId, ref: 'EcgOrgUnit', default: null },
        voltageKV: { type: Number, required: true, min: 0 },
        lengthKm: { type: Number, default: null, min: 0 },
        status: { type: String, enum: ['active', 'fault', 'maintenance', 'offline'], default: 'active' },
        loadPercent: { type: Number, default: 0, min: 0, max: 150 },
        createdByStaffId: { type: mongoose.Schema.Types.ObjectId, ref: 'EcgStaff', default: null },
        createdAt: { type: Date, default: Date.now },
        updatedAt: { type: Date, default: Date.now }
    });
    transmissionLineSchema.index({ region: 1 });
    const TransmissionLine = mongoose.models.EcgTransmissionLine || mongoose.model('EcgTransmissionLine', transmissionLineSchema);

    const announcementSchema = new mongoose.Schema({
        title: { type: String, required: true, trim: true, maxlength: 160 },
        body: { type: String, default: '', trim: true, maxlength: 4000 },
        severity: { type: String, enum: ['info', 'warning', 'critical'], default: 'info' },
        audience: { type: String, enum: ['staff', 'public', 'both'], default: 'staff' },
        scope: { type: String, enum: ['nationwide', 'regional', 'district'], required: true },
        orgUnitId: { type: mongoose.Schema.Types.ObjectId, ref: 'EcgOrgUnit', default: null },
        orgUnitName: { type: String, default: 'Nationwide' },
        region: { type: String, default: null },
        publishedByStaffId: { type: mongoose.Schema.Types.ObjectId, ref: 'EcgStaff', required: true },
        publishedByName: { type: String, required: true },
        active: { type: Boolean, default: true },
        expiresAt: { type: Date, default: null },
        createdAt: { type: Date, default: Date.now },
        updatedAt: { type: Date, default: Date.now }
    });
    announcementSchema.index({ active: 1, createdAt: -1 });
    announcementSchema.index({ orgUnitId: 1 });
    const Announcement = mongoose.models.EcgAnnouncement || mongoose.model('EcgAnnouncement', announcementSchema);

    // Editable profile info per region — population/customer counts etc.
    // that don't belong on the OrgUnit record itself (OrgUnit is org
    // structure; this is regional reference data used by the Regions page).
    const regionProfileSchema = new mongoose.Schema({
        region: { type: String, required: true, unique: true, enum: GHANA_REGIONS },
        population: { type: Number, default: null },
        customerCount: { type: Number, default: null },
        capitalTown: { type: String, default: null },
        notes: { type: String, default: '', maxlength: 1000 },
        updatedByStaffId: { type: mongoose.Schema.Types.ObjectId, ref: 'EcgStaff', default: null },
        updatedAt: { type: Date, default: Date.now }
    });
    const RegionProfile = mongoose.models.EcgRegionProfile || mongoose.model('EcgRegionProfile', regionProfileSchema);

    // One settings document per org unit — notification/threshold/branding
    // preferences. HQ's document also carries the system-wide defaults.
    const settingsSchema = new mongoose.Schema({
        orgUnitId: { type: mongoose.Schema.Types.ObjectId, ref: 'EcgOrgUnit', required: true, unique: true },
        notifyOnNewOutage: { type: Boolean, default: true },
        notifyOnRestoration: { type: Boolean, default: true },
        outageEscalationMinutes: { type: Number, default: 60, min: 5 },
        reserveMarginWarningPct: { type: Number, default: 15, min: 0, max: 100 },
        publicContactEmail: { type: String, default: '', trim: true },
        publicContactPhone: { type: String, default: '', trim: true },
        updatedByStaffId: { type: mongoose.Schema.Types.ObjectId, ref: 'EcgStaff', default: null },
        updatedAt: { type: Date, default: Date.now }
    });
    const EcgSettings = mongoose.models.EcgSettings || mongoose.model('EcgSettings', settingsSchema);

    // Integrations are system-wide (HQ-managed) — third-party services this
    // deployment can connect to. Seeded on first request if empty so the
    // page always has real, persisted rows to show rather than a blank page.
    const integrationSchema = new mongoose.Schema({
        key: { type: String, required: true, unique: true },
        name: { type: String, required: true },
        description: { type: String, default: '' },
        category: { type: String, enum: ['notifications', 'weather', 'maps', 'payments', 'monitoring'], required: true },
        connected: { type: Boolean, default: false },
        lastSyncAt: { type: Date, default: null },
        updatedByStaffId: { type: mongoose.Schema.Types.ObjectId, ref: 'EcgStaff', default: null },
        updatedAt: { type: Date, default: Date.now }
    });
    const Integration = mongoose.models.EcgIntegration || mongoose.model('EcgIntegration', integrationSchema);

    const DEFAULT_INTEGRATIONS = [
        { key: 'web_push', name: 'Web Push Notifications', category: 'notifications', description: 'VAPID web-push alerts to subscribed customer browsers.' },
        { key: 'fcm', name: 'Firebase Cloud Messaging', category: 'notifications', description: 'Native Android push notifications.' },
        { key: 'weather_api', name: 'Weather Service', category: 'weather', description: 'Powers the regional/district weather overview panels.' },
        { key: 'google_maps', name: 'Google Maps Geocoding', category: 'maps', description: 'Reverse-geocodes signup locations to city names.' },
        { key: 'cloudinary', name: 'Cloudinary Media Storage', category: 'monitoring', description: 'Stores uploaded photos/attachments from reports.' },
        { key: 'newrelic', name: 'New Relic APM', category: 'monitoring', description: 'Application performance monitoring for the API.' }
    ];
    async function ensureIntegrationsSeeded() {
        const count = await Integration.countDocuments();
        if (count > 0) return;
        try { await Integration.insertMany(DEFAULT_INTEGRATIONS.map(d => ({ ...d, connected: false }))); }
        catch (err) { console.error('[ecg-ops] integration seed failed:', err.message); }
    }

    // ------------------------------------------------------------
    // Small shared helpers
    // ------------------------------------------------------------

    // Resolve the effective region-scope filter for a GET based on the
    // caller's own org unit — headquarters sees everything (or a specific
    // ?region= filter), regional/district are locked to their own region
    // unless they hold view_all_regions.
    function regionScopeFilter(req) {
        const { region: queryRegion } = req.query;
        if (req.ecgOrgUnit.type === 'headquarters') {
            return queryRegion ? { region: queryRegion } : {};
        }
        if (hasPermission(req.ecgStaff, 'view_all_regions') && queryRegion) {
            return { region: queryRegion };
        }
        return { region: req.ecgOrgUnit.region };
    }

    // Can this staff member manage (create/edit/delete) assets tagged to `region`?
    function canManageRegion(staff, orgUnit, region) {
        if (staff.role === 'hq_super_admin') return true;
        if (orgUnit.type === 'headquarters') return true; // hq_manager/hq_staff gated by permission check at the route
        return orgUnit.region === region;
    }

    function publicPlant(p) {
        return {
            id: p._id, name: p.name, plantType: p.plantType, region: p.region, orgUnitId: p.orgUnitId,
            capacityMW: p.capacityMW, currentOutputMW: p.currentOutputMW, status: p.status,
            operator: p.operator, commissionedYear: p.commissionedYear, lat: p.lat, lng: p.lng,
            createdAt: p.createdAt, updatedAt: p.updatedAt
        };
    }
    function publicLine(l) {
        return {
            id: l._id, name: l.name, fromSubstation: l.fromSubstation, toSubstation: l.toSubstation,
            region: l.region, orgUnitId: l.orgUnitId, voltageKV: l.voltageKV, lengthKm: l.lengthKm,
            status: l.status, loadPercent: l.loadPercent, createdAt: l.createdAt, updatedAt: l.updatedAt
        };
    }
    function publicAnnouncement(a) {
        return {
            id: a._id, title: a.title, body: a.body, severity: a.severity, audience: a.audience,
            scope: a.scope, orgUnitId: a.orgUnitId, orgUnitName: a.orgUnitName, region: a.region,
            publishedByName: a.publishedByName, active: a.active, expiresAt: a.expiresAt, createdAt: a.createdAt
        };
    }

    // ==============================================================
    // POWER PLANTS
    // ==============================================================
    app.get('/ecg/plants', verifyEcgToken, async (req, res) => {
        try {
            const filter = { ...regionScopeFilter(req) };
            if (req.query.status) filter.status = req.query.status;
            const plants = await PowerPlant.find(filter).sort({ capacityMW: -1 }).lean();
            return res.json(plants.map(publicPlant));
        } catch (err) {
            console.error('[ecg-ops] list plants error:', err.message);
            return res.status(500).json({ error: 'Server error fetching power plants' });
        }
    });

    app.post('/ecg/plants', verifyEcgToken, requirePermission('manage_power_plants'), async (req, res) => {
        try {
            const { name, plantType, region, capacityMW, currentOutputMW, status, operator, commissionedYear, lat, lng } = req.body || {};
            if (!name || !plantType || !region || capacityMW === undefined) {
                return res.status(400).json({ error: 'name, plantType, region and capacityMW are required' });
            }
            if (!GHANA_REGIONS.includes(region)) return res.status(400).json({ error: 'Unknown region' });
            if (!canManageRegion(req.ecgStaff, req.ecgOrgUnit, region)) return res.status(403).json({ error: 'You cannot add a plant outside your region' });

            const regionalUnit = await OrgUnit.findOne({ type: 'regional', region, deletedAt: null }).lean();
            const plant = await PowerPlant.create({
                name: String(name).trim(), plantType, region,
                orgUnitId: regionalUnit ? regionalUnit._id : null,
                capacityMW: Number(capacityMW), currentOutputMW: Number(currentOutputMW) || 0,
                status: status || 'operational', operator: operator ? String(operator).trim() : 'ECG / VRA',
                commissionedYear: commissionedYear ? Number(commissionedYear) : null,
                lat: lat !== undefined ? Number(lat) : null, lng: lng !== undefined ? Number(lng) : null,
                createdByStaffId: req.ecgStaff._id
            });
            await logAudit({ staff: req.ecgStaff, orgUnit: req.ecgOrgUnit, action: 'power_plant_created', target: plant.name, details: { plantId: plant._id, region }, req });
            return res.status(201).json(publicPlant(plant));
        } catch (err) {
            console.error('[ecg-ops] create plant error:', err.message);
            return res.status(500).json({ error: 'Server error creating power plant' });
        }
    });

    app.patch('/ecg/plants/:id', verifyEcgToken, requirePermission('manage_power_plants'), async (req, res) => {
        try {
            const plant = await PowerPlant.findById(req.params.id);
            if (!plant) return res.status(404).json({ error: 'Not found' });
            if (!canManageRegion(req.ecgStaff, req.ecgOrgUnit, plant.region)) return res.status(403).json({ error: 'Forbidden' });

            const fields = ['name', 'plantType', 'capacityMW', 'currentOutputMW', 'status', 'operator', 'commissionedYear', 'lat', 'lng'];
            fields.forEach(f => { if (req.body[f] !== undefined) plant[f] = req.body[f]; });
            plant.updatedAt = new Date();
            await plant.save();
            await logAudit({ staff: req.ecgStaff, orgUnit: req.ecgOrgUnit, action: 'power_plant_updated', target: plant.name, details: { plantId: plant._id, changes: req.body }, req });
            return res.json(publicPlant(plant));
        } catch (err) {
            console.error('[ecg-ops] update plant error:', err.message);
            return res.status(500).json({ error: 'Server error updating power plant' });
        }
    });

    app.delete('/ecg/plants/:id', verifyEcgToken, requirePermission('manage_power_plants'), async (req, res) => {
        try {
            const plant = await PowerPlant.findById(req.params.id);
            if (!plant) return res.status(404).json({ error: 'Not found' });
            if (!canManageRegion(req.ecgStaff, req.ecgOrgUnit, plant.region)) return res.status(403).json({ error: 'Forbidden' });
            await plant.deleteOne();
            await logAudit({ staff: req.ecgStaff, orgUnit: req.ecgOrgUnit, action: 'power_plant_deleted', target: plant.name, details: { plantId: req.params.id }, req });
            return res.json({ success: true });
        } catch (err) {
            console.error('[ecg-ops] delete plant error:', err.message);
            return res.status(500).json({ error: 'Server error deleting power plant' });
        }
    });

    // ==============================================================
    // TRANSMISSION LINES
    // ==============================================================
    app.get('/ecg/transmission-lines', verifyEcgToken, async (req, res) => {
        try {
            const filter = { ...regionScopeFilter(req) };
            if (req.query.status) filter.status = req.query.status;
            const lines = await TransmissionLine.find(filter).sort({ voltageKV: -1 }).lean();
            return res.json(lines.map(publicLine));
        } catch (err) {
            console.error('[ecg-ops] list transmission lines error:', err.message);
            return res.status(500).json({ error: 'Server error fetching transmission lines' });
        }
    });

    app.post('/ecg/transmission-lines', verifyEcgToken, requirePermission('manage_transmission'), async (req, res) => {
        try {
            const { name, fromSubstation, toSubstation, region, voltageKV, lengthKm, status, loadPercent } = req.body || {};
            if (!name || !fromSubstation || !toSubstation || !region || voltageKV === undefined) {
                return res.status(400).json({ error: 'name, fromSubstation, toSubstation, region and voltageKV are required' });
            }
            if (!GHANA_REGIONS.includes(region)) return res.status(400).json({ error: 'Unknown region' });
            if (!canManageRegion(req.ecgStaff, req.ecgOrgUnit, region)) return res.status(403).json({ error: 'You cannot add a line outside your region' });

            const regionalUnit = await OrgUnit.findOne({ type: 'regional', region, deletedAt: null }).lean();
            const line = await TransmissionLine.create({
                name: String(name).trim(), fromSubstation: String(fromSubstation).trim(), toSubstation: String(toSubstation).trim(),
                region, orgUnitId: regionalUnit ? regionalUnit._id : null, voltageKV: Number(voltageKV),
                lengthKm: lengthKm !== undefined ? Number(lengthKm) : null, status: status || 'active',
                loadPercent: loadPercent !== undefined ? Number(loadPercent) : 0, createdByStaffId: req.ecgStaff._id
            });
            await logAudit({ staff: req.ecgStaff, orgUnit: req.ecgOrgUnit, action: 'transmission_line_created', target: line.name, details: { lineId: line._id, region }, req });
            return res.status(201).json(publicLine(line));
        } catch (err) {
            console.error('[ecg-ops] create transmission line error:', err.message);
            return res.status(500).json({ error: 'Server error creating transmission line' });
        }
    });

    app.patch('/ecg/transmission-lines/:id', verifyEcgToken, requirePermission('manage_transmission'), async (req, res) => {
        try {
            const line = await TransmissionLine.findById(req.params.id);
            if (!line) return res.status(404).json({ error: 'Not found' });
            if (!canManageRegion(req.ecgStaff, req.ecgOrgUnit, line.region)) return res.status(403).json({ error: 'Forbidden' });
            const fields = ['name', 'fromSubstation', 'toSubstation', 'voltageKV', 'lengthKm', 'status', 'loadPercent'];
            fields.forEach(f => { if (req.body[f] !== undefined) line[f] = req.body[f]; });
            line.updatedAt = new Date();
            await line.save();
            await logAudit({ staff: req.ecgStaff, orgUnit: req.ecgOrgUnit, action: 'transmission_line_updated', target: line.name, details: { lineId: line._id, changes: req.body }, req });
            return res.json(publicLine(line));
        } catch (err) {
            console.error('[ecg-ops] update transmission line error:', err.message);
            return res.status(500).json({ error: 'Server error updating transmission line' });
        }
    });

    app.delete('/ecg/transmission-lines/:id', verifyEcgToken, requirePermission('manage_transmission'), async (req, res) => {
        try {
            const line = await TransmissionLine.findById(req.params.id);
            if (!line) return res.status(404).json({ error: 'Not found' });
            if (!canManageRegion(req.ecgStaff, req.ecgOrgUnit, line.region)) return res.status(403).json({ error: 'Forbidden' });
            await line.deleteOne();
            await logAudit({ staff: req.ecgStaff, orgUnit: req.ecgOrgUnit, action: 'transmission_line_deleted', target: line.name, details: { lineId: req.params.id }, req });
            return res.json({ success: true });
        } catch (err) {
            console.error('[ecg-ops] delete transmission line error:', err.message);
            return res.status(500).json({ error: 'Server error deleting transmission line' });
        }
    });

    // ==============================================================
    // REGIONS — read-mostly overview combining OrgUnit + RegionProfile +
    // live counts of plants/lines/staff/districts per region. HQ-only page
    // in the frontend (see ecg-dashboard.html's canViewRegionsOverview).
    // ==============================================================
    app.get('/ecg/regions/summary', verifyEcgToken, requirePermission('view_all_regions'), async (req, res) => {
        try {
            const [regionalUnits, profiles, plants, lines, districts, staffCounts] = await Promise.all([
                OrgUnit.find({ type: 'regional', deletedAt: null }).lean(),
                RegionProfile.find().lean(),
                PowerPlant.aggregate([{ $group: { _id: '$region', capacityMW: { $sum: '$capacityMW' }, count: { $sum: 1 } } }]),
                TransmissionLine.aggregate([{ $group: { _id: '$region', count: { $sum: 1 } } }]),
                OrgUnit.aggregate([{ $match: { type: 'district', deletedAt: null } }, { $group: { _id: '$region', count: { $sum: 1 } } }]),
                EcgStaff.aggregate([{ $match: { active: true } }, { $lookup: { from: 'ecgorgunits', localField: 'orgUnitId', foreignField: '_id', as: 'unit' } }, { $unwind: '$unit' }, { $group: { _id: '$unit.region', count: { $sum: 1 } } }])
            ]);
            const byRegion = name => ({
                profile: profiles.find(p => p.region === name) || null,
                unit: regionalUnits.find(u => u.region === name) || null,
                plants: plants.find(p => p._id === name) || { capacityMW: 0, count: 0 },
                lines: lines.find(l => l._id === name) || { count: 0 },
                districts: districts.find(d => d._id === name) || { count: 0 },
                staff: staffCounts.find(s => s._id === name) || { count: 0 }
            });
            const out = GHANA_REGIONS.map(name => {
                const r = byRegion(name);
                return {
                    region: name,
                    hasRegionalOffice: Boolean(r.unit),
                    orgUnitId: r.unit ? r.unit._id : null,
                    active: r.unit ? r.unit.active : false,
                    population: r.profile ? r.profile.population : null,
                    customerCount: r.profile ? r.profile.customerCount : null,
                    capitalTown: r.profile ? r.profile.capitalTown : null,
                    totalCapacityMW: r.plants.capacityMW,
                    plantCount: r.plants.count,
                    transmissionLineCount: r.lines.count,
                    districtCount: r.districts.count,
                    staffCount: r.staff.count
                };
            });
            return res.json(out);
        } catch (err) {
            console.error('[ecg-ops] regions summary error:', err.message);
            return res.status(500).json({ error: 'Server error fetching regions summary' });
        }
    });

    app.patch('/ecg/regions/:region', verifyEcgToken, async (req, res) => {
        try {
            const region = req.params.region;
            if (!GHANA_REGIONS.includes(region)) return res.status(404).json({ error: 'Unknown region' });
            const canEdit = req.ecgStaff.role === 'hq_super_admin' ||
                (req.ecgOrgUnit.type === 'headquarters' && hasPermission(req.ecgStaff, 'manage_regional_offices')) ||
                (req.ecgOrgUnit.type === 'regional' && req.ecgOrgUnit.region === region && hasPermission(req.ecgStaff, 'manage_local_stations'));
            if (!canEdit) return res.status(403).json({ error: 'You cannot edit this region\'s profile' });

            const { population, customerCount, capitalTown, notes } = req.body || {};
            const update = { updatedByStaffId: req.ecgStaff._id, updatedAt: new Date() };
            if (population !== undefined) update.population = Number(population);
            if (customerCount !== undefined) update.customerCount = Number(customerCount);
            if (capitalTown !== undefined) update.capitalTown = String(capitalTown).trim();
            if (notes !== undefined) update.notes = String(notes).trim();

            const profile = await RegionProfile.findOneAndUpdate({ region }, { $set: update, $setOnInsert: { region } }, { upsert: true, new: true });
            await logAudit({ staff: req.ecgStaff, orgUnit: req.ecgOrgUnit, action: 'region_profile_updated', target: region, details: req.body, req });
            return res.json(profile);
        } catch (err) {
            console.error('[ecg-ops] update region profile error:', err.message);
            return res.status(500).json({ error: 'Server error updating region profile' });
        }
    });

    // ==============================================================
    // ANNOUNCEMENTS
    // ==============================================================
    app.get('/ecg/announcements', verifyEcgToken, async (req, res) => {
        try {
            const unitIds = await scopedUnitIds(req.ecgStaff);
            const filter = req.ecgOrgUnit.type === 'headquarters'
                ? {}
                : { $or: [{ scope: 'nationwide' }, { orgUnitId: { $in: unitIds } }, { region: req.ecgOrgUnit.region }] };
            if (req.query.activeOnly === 'true') filter.active = true;
            const items = await Announcement.find(filter).sort({ createdAt: -1 }).limit(100).lean();
            return res.json(items.map(publicAnnouncement));
        } catch (err) {
            console.error('[ecg-ops] list announcements error:', err.message);
            return res.status(500).json({ error: 'Server error fetching announcements' });
        }
    });

    app.post('/ecg/announcements', verifyEcgToken, requirePermission('manage_announcements'), async (req, res) => {
        try {
            const { title, body, severity, audience, scope, orgUnitId, expiresAt } = req.body || {};
            if (!title || !scope) return res.status(400).json({ error: 'title and scope are required' });
            if (!['nationwide', 'regional', 'district'].includes(scope)) return res.status(400).json({ error: 'Invalid scope' });

            let targetUnit = null, region = null, orgUnitName = 'Nationwide';
            if (scope !== 'nationwide') {
                if (req.ecgOrgUnit.type === 'headquarters') {
                    if (!orgUnitId) return res.status(400).json({ error: 'orgUnitId is required for a regional/district announcement' });
                    targetUnit = await OrgUnit.findById(orgUnitId);
                    if (!targetUnit) return res.status(404).json({ error: 'Organization unit not found' });
                } else {
                    targetUnit = req.ecgOrgUnit;
                }
                region = targetUnit.region;
                orgUnitName = targetUnit.name;
            } else if (req.ecgOrgUnit.type !== 'headquarters') {
                return res.status(403).json({ error: 'Only Headquarters can publish a nationwide announcement' });
            }

            const announcement = await Announcement.create({
                title: String(title).trim(), body: body ? String(body).trim() : '',
                severity: ['info', 'warning', 'critical'].includes(severity) ? severity : 'info',
                audience: ['staff', 'public', 'both'].includes(audience) ? audience : 'staff',
                scope, orgUnitId: targetUnit ? targetUnit._id : null, orgUnitName, region,
                publishedByStaffId: req.ecgStaff._id, publishedByName: req.ecgStaff.name,
                expiresAt: expiresAt ? new Date(expiresAt) : null
            });
            await logAudit({ staff: req.ecgStaff, orgUnit: req.ecgOrgUnit, action: 'announcement_published', target: announcement.title, details: { announcementId: announcement._id, scope }, req });
            return res.status(201).json(publicAnnouncement(announcement));
        } catch (err) {
            console.error('[ecg-ops] publish announcement error:', err.message);
            return res.status(500).json({ error: 'Server error publishing announcement' });
        }
    });

    app.patch('/ecg/announcements/:id', verifyEcgToken, requirePermission('manage_announcements'), async (req, res) => {
        try {
            const a = await Announcement.findById(req.params.id);
            if (!a) return res.status(404).json({ error: 'Not found' });
            const unit = a.orgUnitId ? await OrgUnit.findById(a.orgUnitId) : null;
            const isOwn = String(a.publishedByStaffId) === String(req.ecgStaff._id) || (a.orgUnitId && String(a.orgUnitId) === String(req.ecgStaff.orgUnitId));
            if (!isOwn && !(unit && await canManageUnit(req.ecgStaff, unit)) && req.ecgOrgUnit.type !== 'headquarters') {
                return res.status(403).json({ error: 'Forbidden' });
            }
            const fields = ['title', 'body', 'severity', 'audience', 'active', 'expiresAt'];
            fields.forEach(f => { if (req.body[f] !== undefined) a[f] = req.body[f]; });
            a.updatedAt = new Date();
            await a.save();
            await logAudit({ staff: req.ecgStaff, orgUnit: req.ecgOrgUnit, action: 'announcement_updated', target: a.title, details: { announcementId: a._id, changes: req.body }, req });
            return res.json(publicAnnouncement(a));
        } catch (err) {
            console.error('[ecg-ops] update announcement error:', err.message);
            return res.status(500).json({ error: 'Server error updating announcement' });
        }
    });

    app.delete('/ecg/announcements/:id', verifyEcgToken, requirePermission('manage_announcements'), async (req, res) => {
        try {
            const a = await Announcement.findById(req.params.id);
            if (!a) return res.status(404).json({ error: 'Not found' });
            const unit = a.orgUnitId ? await OrgUnit.findById(a.orgUnitId) : null;
            const isOwn = String(a.publishedByStaffId) === String(req.ecgStaff._id) || (a.orgUnitId && String(a.orgUnitId) === String(req.ecgStaff.orgUnitId));
            if (!isOwn && !(unit && await canManageUnit(req.ecgStaff, unit)) && req.ecgOrgUnit.type !== 'headquarters') {
                return res.status(403).json({ error: 'Forbidden' });
            }
            await a.deleteOne();
            await logAudit({ staff: req.ecgStaff, orgUnit: req.ecgOrgUnit, action: 'announcement_deleted', target: a.title, details: { announcementId: req.params.id }, req });
            return res.json({ success: true });
        } catch (err) {
            console.error('[ecg-ops] delete announcement error:', err.message);
            return res.status(500).json({ error: 'Server error deleting announcement' });
        }
    });

    // ==============================================================
    // REPORTS & ANALYTICS — real aggregation over the caller's scope
    // (events, power plants, transmission, staff, org units), not
    // synthetic numbers.
    // ==============================================================
    app.get('/ecg/analytics/overview', verifyEcgToken, async (req, res) => {
        try {
            const EcgOfficialEvent = mongoose.models.EcgOfficialEvent;
            const unitIds = await scopedUnitIds(req.ecgStaff);
            const isHq = req.ecgOrgUnit.type === 'headquarters';
            const unitFilter = isHq ? {} : { orgUnitId: { $in: unitIds } };
            const regionFilter = isHq ? {} : { region: req.ecgOrgUnit.region };

            const [eventsByType, eventsByStatus, plantAgg, lineAgg, staffAgg, thirtyDayTrend] = await Promise.all([
                EcgOfficialEvent ? EcgOfficialEvent.aggregate([{ $match: unitFilter }, { $group: { _id: '$eventType', count: { $sum: 1 } } }]) : [],
                EcgOfficialEvent ? EcgOfficialEvent.aggregate([{ $match: unitFilter }, { $group: { _id: '$status', count: { $sum: 1 } } }]) : [],
                PowerPlant.aggregate([{ $match: regionFilter }, { $group: { _id: null, capacityMW: { $sum: '$capacityMW' }, outputMW: { $sum: '$currentOutputMW' }, count: { $sum: 1 } } }]),
                TransmissionLine.aggregate([{ $match: regionFilter }, { $group: { _id: null, count: { $sum: 1 }, avgLoad: { $avg: '$loadPercent' } } }]),
                EcgStaff.countDocuments(isHq ? { active: true } : { active: true, orgUnitId: { $in: unitIds } }),
                EcgOfficialEvent ? EcgOfficialEvent.aggregate([
                    { $match: { ...unitFilter, createdAt: { $gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) } } },
                    { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } }, count: { $sum: 1 } } },
                    { $sort: { _id: 1 } }
                ]) : []
            ]);

            return res.json({
                scope: req.ecgOrgUnit.type,
                eventsByType: eventsByType.map(e => ({ type: e._id, count: e.count })),
                eventsByStatus: eventsByStatus.map(e => ({ status: e._id, count: e.count })),
                plants: plantAgg[0] ? { capacityMW: plantAgg[0].capacityMW, outputMW: plantAgg[0].outputMW, count: plantAgg[0].count } : { capacityMW: 0, outputMW: 0, count: 0 },
                transmission: lineAgg[0] ? { count: lineAgg[0].count, avgLoadPercent: Math.round((lineAgg[0].avgLoad || 0) * 10) / 10 } : { count: 0, avgLoadPercent: 0 },
                activeStaffCount: staffAgg,
                dailyEventTrend: thirtyDayTrend.map(d => ({ date: d._id, count: d.count }))
            });
        } catch (err) {
            console.error('[ecg-ops] analytics overview error:', err.message);
            return res.status(500).json({ error: 'Server error building analytics overview' });
        }
    });

    // ==============================================================
    // SETTINGS — per org unit
    // ==============================================================
    app.get('/ecg/settings', verifyEcgToken, async (req, res) => {
        try {
            let settings = await EcgSettings.findOne({ orgUnitId: req.ecgOrgUnit._id }).lean();
            if (!settings) settings = { orgUnitId: req.ecgOrgUnit._id, notifyOnNewOutage: true, notifyOnRestoration: true, outageEscalationMinutes: 60, reserveMarginWarningPct: 15, publicContactEmail: '', publicContactPhone: '' };
            return res.json(settings);
        } catch (err) {
            console.error('[ecg-ops] get settings error:', err.message);
            return res.status(500).json({ error: 'Server error fetching settings' });
        }
    });

    app.patch('/ecg/settings', verifyEcgToken, async (req, res) => {
        try {
            const fields = ['notifyOnNewOutage', 'notifyOnRestoration', 'outageEscalationMinutes', 'reserveMarginWarningPct', 'publicContactEmail', 'publicContactPhone'];
            const update = { updatedByStaffId: req.ecgStaff._id, updatedAt: new Date() };
            fields.forEach(f => { if (req.body[f] !== undefined) update[f] = req.body[f]; });
            const settings = await EcgSettings.findOneAndUpdate(
                { orgUnitId: req.ecgOrgUnit._id },
                { $set: update, $setOnInsert: { orgUnitId: req.ecgOrgUnit._id } },
                { upsert: true, new: true }
            );
            await logAudit({ staff: req.ecgStaff, orgUnit: req.ecgOrgUnit, action: 'settings_updated', target: req.ecgOrgUnit.name, details: req.body, req });
            return res.json(settings);
        } catch (err) {
            console.error('[ecg-ops] update settings error:', err.message);
            return res.status(500).json({ error: 'Server error updating settings' });
        }
    });

    // ==============================================================
    // INTEGRATIONS — HQ-managed, system-wide
    // ==============================================================
    app.get('/ecg/integrations', verifyEcgToken, async (req, res) => {
        try {
            await ensureIntegrationsSeeded();
            const items = await Integration.find().sort({ category: 1, name: 1 }).lean();
            return res.json(items);
        } catch (err) {
            console.error('[ecg-ops] list integrations error:', err.message);
            return res.status(500).json({ error: 'Server error fetching integrations' });
        }
    });

    app.patch('/ecg/integrations/:key', verifyEcgToken, requirePermission('manage_integrations'), async (req, res) => {
        try {
            const { connected } = req.body || {};
            const item = await Integration.findOneAndUpdate(
                { key: req.params.key },
                { $set: { connected: Boolean(connected), lastSyncAt: connected ? new Date() : null, updatedByStaffId: req.ecgStaff._id, updatedAt: new Date() } },
                { new: true }
            );
            if (!item) return res.status(404).json({ error: 'Not found' });
            await logAudit({ staff: req.ecgStaff, orgUnit: req.ecgOrgUnit, action: connected ? 'integration_connected' : 'integration_disconnected', target: item.name, details: { key: item.key }, req });
            return res.json(item);
        } catch (err) {
            console.error('[ecg-ops] update integration error:', err.message);
            return res.status(500).json({ error: 'Server error updating integration' });
        }
    });

    // ==============================================================
    // SYSTEM HEALTH — real, server-derived metrics (DB connection state,
    // process uptime/memory, active incident counts, staff online) —
    // never fabricated numbers.
    // ==============================================================
    app.get('/ecg/system-health', verifyEcgToken, async (req, res) => {
        try {
            const EcgOfficialEvent = mongoose.models.EcgOfficialEvent;
            const PowerStatusChange = mongoose.models.EcgPowerStatusChange;
            const dbStateNames = ['disconnected', 'connected', 'connecting', 'disconnecting'];
            const fifteenMinAgo = new Date(Date.now() - 15 * 60 * 1000);

            const [activeEvents, activePowerIncidents, staffOnline, totalStaff, plantsOffline, linesFaulted] = await Promise.all([
                EcgOfficialEvent ? EcgOfficialEvent.countDocuments({ status: 'active' }) : 0,
                PowerStatusChange ? PowerStatusChange.countDocuments({ active: true }) : 0,
                EcgStaff.countDocuments({ active: true, lastLoginAt: { $gte: fifteenMinAgo } }),
                EcgStaff.countDocuments({ active: true }),
                PowerPlant.countDocuments({ status: { $in: ['offline', 'maintenance'] } }),
                TransmissionLine.countDocuments({ status: { $in: ['fault', 'offline'] } })
            ]);

            const mem = process.memoryUsage();
            return res.json({
                database: { state: dbStateNames[mongoose.connection.readyState] || 'unknown', ok: mongoose.connection.readyState === 1 },
                api: { uptimeSeconds: Math.round(process.uptime()), memoryUsedMB: Math.round(mem.heapUsed / 1024 / 1024), memoryTotalMB: Math.round(mem.heapTotal / 1024 / 1024), nodeVersion: process.version },
                operations: { activeOutageEvents: activeEvents, activePowerIncidents, plantsOffline, linesFaulted },
                staff: { onlineLast15Min: staffOnline, totalActive: totalStaff },
                checkedAt: new Date()
            });
        } catch (err) {
            console.error('[ecg-ops] system health error:', err.message);
            return res.status(500).json({ error: 'Server error fetching system health' });
        }
    });

    console.log('[ecg-ops] ECG plants/transmission/regions/announcements/analytics/settings/integrations/health routes mounted at /ecg/*');

    return { models: { PowerPlant, TransmissionLine, Announcement, RegionProfile, EcgSettings, Integration } };
};