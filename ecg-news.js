// ============================================================
//  ECG-NEWS.JS — Official ECG updates feed
//
//  This is the AUTHORITATIVE counterpart to news.js. news.js scrapes
//  and infers outage "events" from third-party RSS/news sources; this
//  file stores events that ECG staff themselves published through
//  ecg-dashboard.html, tagged with exactly which organization unit
//  published them and which of that unit's coverage areas are
//  affected. The two are kept as separate collections/routes rather
//  than merged, so a scraped/unconfirmed report is never confused
//  with an authoritative ECG-published one — the public frontend can
//  label/sort them differently by checking `source: 'ecg_official'`.
//
//  Every publish/update/resolve below ALSO mirrors a matching entry
//  into news.js's own NewsEvent collection (source-flagged official),
//  so it flows straight into the existing public GET /news feed that
//  index.html already renders — no separate "official news" widget
//  needed on the public site; it just shows up there, badged official.
//
//  MUST be wired in AFTER ecg-auth.js, since it reuses that file's
//  models/middleware/helpers off app.locals.ecg instead of redefining
//  them, and works best after news.js so NewsEvent is already
//  registered (degrades gracefully to ECG-only records if not):
//      require('./ecg-auth')(app, { mongoose, jwt, JWT_SECRET, verifyAdminToken });
//      require('./ecg-news')(app, { mongoose });
//
//  Routes:
//    GET    /ecg/events            — PUBLIC. Official updates feed.
//    GET    /ecg/events/:id        — PUBLIC. Single event detail.
//    POST   /ecg/events            — PROTECTED (publish_updates). Publish a new event.
//    PATCH  /ecg/events/:id        — PROTECTED (manage_events). Update / resolve.
//    DELETE /ecg/events/:id        — PROTECTED (manage_events). Retract.
// ============================================================

module.exports = function setupEcgNews(app, { mongoose }) {
    const ecg = app.locals.ecg;
    if (!ecg) {
        throw new Error('[ecg-news] app.locals.ecg is missing — require("./ecg-auth")(app, ...) must run before require("./ecg-news")(app, ...)');
    }
    const { OrgUnit, EcgStaff } = ecg.models;
    const { verifyEcgToken, requirePermission } = ecg.middleware;
    const { canManageUnit, logAudit, publicOrgUnit } = ecg.helpers;

    const ecgEventSchema = new mongoose.Schema({
        orgUnitId: { type: mongoose.Schema.Types.ObjectId, ref: 'EcgOrgUnit', required: true },
        orgUnitName: { type: String, required: true },
        region: { type: String, default: null },
        publishedByStaffId: { type: mongoose.Schema.Types.ObjectId, ref: 'EcgStaff', required: true },
        publishedByName: { type: String, required: true },

        eventType: { type: String, enum: ['outage', 'restoration', 'maintenance', 'advisory'], required: true },
        headline: { type: String, required: true, trim: true, maxlength: 200 },
        summary: { type: String, default: '', trim: true, maxlength: 2000 },
        affectedAreas: { type: [String], required: true, validate: v => Array.isArray(v) && v.length > 0 },

        status: { type: String, enum: ['active', 'resolved'], default: 'active' },
        startTime: { type: Date, default: Date.now },
        endTime: { type: Date, default: null },

        source: { type: String, default: 'ecg_official', immutable: true },
        confirmedCommunityReportRefs: { type: [String], default: [] },
        mirroredNewsEventId: { type: mongoose.Schema.Types.ObjectId, ref: 'NewsEvent', default: null },

        history: [{
            action: String,
            byStaffName: String,
            note: String,
            at: { type: Date, default: Date.now }
        }],

        createdAt: { type: Date, default: Date.now },
        updatedAt: { type: Date, default: Date.now }
    });
    ecgEventSchema.index({ status: 1, createdAt: -1 });
    ecgEventSchema.index({ affectedAreas: 1 });
    ecgEventSchema.index({ orgUnitId: 1 });

    const EcgOfficialEvent = mongoose.models.EcgOfficialEvent || mongoose.model('EcgOfficialEvent', ecgEventSchema);

    const EVENT_CATEGORY = { outage: 'outage', restoration: 'restoration', maintenance: 'maintenance', advisory: 'general' };
    const EVENT_TYPE_LABEL = { outage: 'Unplanned Outage', restoration: 'Power Restored', maintenance: 'Planned Maintenance', advisory: 'Advisory' };

    // Mirrors an official ECG event into news.js's public NewsEvent
    // collection so it appears in GET /news (index.html's feed),
    // badged official via sources[].official = true. No-op if news.js
    // hasn't registered its model for some reason.
    async function mirrorToPublicNews(event, { isUpdate = false } = {}) {
        const NewsEvent = mongoose.models.NewsEvent;
        if (!NewsEvent) return;
        try {
            const doc = {
                category: EVENT_CATEGORY[event.eventType] || 'general',
                eventType: EVENT_TYPE_LABEL[event.eventType] || event.eventType,
                headline: event.headline,
                summary: event.summary || '',
                affectedLocations: event.affectedAreas,
                isNationwide: false,
                startTime: event.startTime,
                endTime: event.endTime,
                firstPublishedAt: event.createdAt || new Date(),
                lastUpdatedAt: new Date(),
                dedupeKey: `ecg-event-${event._id}`,
                sources: [{
                    name: event.orgUnitName || 'ECG Official', icon: '⚡', official: true,
                    url: null, resolvedUrl: null, headline: event.headline, publishedAt: new Date()
                }],
                confidenceScore: 100,
                status: event.status
            };
            if (event.mirroredNewsEventId && isUpdate) {
                await NewsEvent.findByIdAndUpdate(event.mirroredNewsEventId, doc);
                return event.mirroredNewsEventId;
            }
            const created = await NewsEvent.create(doc);
            return created._id;
        } catch (err) {
            console.error('[ecg-news] mirror to public news failed:', err.message);
            return null;
        }
    }

    function publicEvent(ev) {
        return {
            id: ev._id,
            orgUnitName: ev.orgUnitName,
            region: ev.region,
            publishedByName: ev.publishedByName,
            eventType: ev.eventType,
            headline: ev.headline,
            summary: ev.summary,
            affectedAreas: ev.affectedAreas,
            status: ev.status,
            startTime: ev.startTime,
            endTime: ev.endTime,
            source: ev.source,
            history: ev.history,
            createdAt: ev.createdAt,
            updatedAt: ev.updatedAt
        };
        // Deliberately omits orgUnitId/publishedByStaffId — internal
        // identifiers, not needed by public consumers of this feed.
    }

    // ---- PUBLIC: official updates feed, optionally filtered ----
    app.get('/ecg/events', async (req, res) => {
        try {
            const { area, region, status, eventType, orgUnitId, limit } = req.query;
            const filter = {};
            if (area) filter.affectedAreas = new RegExp(`^${String(area).trim()}$`, 'i');
            if (region) filter.region = new RegExp(`^${String(region).trim()}$`, 'i');
            if (status) filter.status = status;
            if (eventType) filter.eventType = eventType;
            if (orgUnitId) filter.orgUnitId = orgUnitId;

            const events = await EcgOfficialEvent.find(filter)
                .sort({ createdAt: -1 })
                .limit(Math.min(Number(limit) || 50, 200))
                .lean();

            return res.json(events.map(publicEvent));
        } catch (err) {
            console.error('[ecg-news] list events error:', err.message);
            return res.status(500).json({ error: 'Server error fetching ECG updates' });
        }
    });

    app.get('/ecg/events/:id', async (req, res) => {
        try {
            const ev = await EcgOfficialEvent.findById(req.params.id).lean();
            if (!ev) return res.status(404).json({ error: 'Not found' });
            return res.json(publicEvent(ev));
        } catch (err) {
            return res.status(404).json({ error: 'Not found' });
        }
    });

    // ---- PROTECTED: publish a new official event ----
    app.post('/ecg/events', verifyEcgToken, requirePermission('publish_updates'), async (req, res) => {
        try {
            const { eventType, headline, summary, affectedAreas, orgUnitId, startTime } = req.body || {};
            if (!eventType || !headline || !Array.isArray(affectedAreas) || affectedAreas.length === 0) {
                return res.status(400).json({ error: 'eventType, headline, and at least one affected area are required' });
            }

            const targetUnitId = orgUnitId || req.ecgStaff.orgUnitId;
            const targetUnit = await OrgUnit.findById(targetUnitId);
            if (!targetUnit) return res.status(404).json({ error: 'Organization unit not found' });
            const withinScope = String(targetUnit._id) === String(req.ecgStaff.orgUnitId) || (await canManageUnit(req.ecgStaff, targetUnit));
            if (!withinScope) {
                return res.status(403).json({ error: 'You cannot publish events for that organization unit' });
            }
            if (targetUnit.type !== 'district') {
                return res.status(400).json({ error: 'Events must be published against a district/local station unit (the one with real coverage areas)' });
            }

            const cleanAreas = affectedAreas.map(a => String(a).trim()).filter(Boolean);
            const unknownAreas = cleanAreas.filter(a => !targetUnit.coverageAreas.some(c => c.toLowerCase() === a.toLowerCase()));
            if (unknownAreas.length > 0) {
                return res.status(400).json({ error: `These areas are not part of ${targetUnit.name}'s assigned coverage: ${unknownAreas.join(', ')}` });
            }

            const event = await EcgOfficialEvent.create({
                orgUnitId: targetUnit._id,
                orgUnitName: targetUnit.name,
                region: targetUnit.region,
                publishedByStaffId: req.ecgStaff._id,
                publishedByName: req.ecgStaff.name,
                eventType,
                headline: String(headline).trim(),
                summary: summary ? String(summary).trim() : '',
                affectedAreas: cleanAreas,
                startTime: startTime ? new Date(startTime) : new Date(),
                history: [{ action: 'published', byStaffName: req.ecgStaff.name }]
            });

            const mirroredId = await mirrorToPublicNews(event);
            if (mirroredId) { event.mirroredNewsEventId = mirroredId; await event.save(); }

            await logAudit({ staff: req.ecgStaff, orgUnit: req.ecgOrgUnit, action: 'event_published', target: event.headline, details: { eventId: event._id, headline: event.headline, areas: cleanAreas }, req });

            return res.status(201).json(publicEvent(event));
        } catch (err) {
            console.error('[ecg-news] publish event error:', err.message);
            return res.status(500).json({ error: 'Server error publishing event' });
        }
    });

    // ---- PROTECTED: update / resolve an event ----
    app.patch('/ecg/events/:id', verifyEcgToken, requirePermission('manage_events'), async (req, res) => {
        try {
            const event = await EcgOfficialEvent.findById(req.params.id);
            if (!event) return res.status(404).json({ error: 'Not found' });
            const unit = await OrgUnit.findById(event.orgUnitId);
            const isOwnUnit = String(event.orgUnitId) === String(req.ecgStaff.orgUnitId);
            if (!isOwnUnit && !(await canManageUnit(req.ecgStaff, unit))) {
                return res.status(403).json({ error: 'Forbidden' });
            }

            const { summary, status, endTime, note } = req.body || {};
            const historyNote = { byStaffName: req.ecgStaff.name, note: note || undefined };

            if (summary !== undefined) event.summary = String(summary).trim();
            if (status !== undefined && ['active', 'resolved'].includes(status)) {
                event.status = status;
                event.history.push({ ...historyNote, action: status === 'resolved' ? 'resolved' : 'reopened' });
                if (status === 'resolved' && !event.endTime) event.endTime = new Date();
            } else if (note) {
                event.history.push({ ...historyNote, action: 'updated' });
            }
            if (endTime !== undefined) event.endTime = endTime ? new Date(endTime) : null;
            event.updatedAt = new Date();
            await event.save();

            await mirrorToPublicNews(event, { isUpdate: true });

            await logAudit({ staff: req.ecgStaff, orgUnit: req.ecgOrgUnit, action: 'event_updated', target: event.headline, details: { eventId: event._id, changes: req.body }, req });
            return res.json(publicEvent(event));
        } catch (err) {
            console.error('[ecg-news] update event error:', err.message);
            return res.status(500).json({ error: 'Server error updating event' });
        }
    });

    // ---- PROTECTED: retract an event ----
    app.delete('/ecg/events/:id', verifyEcgToken, requirePermission('manage_events'), async (req, res) => {
        try {
            const event = await EcgOfficialEvent.findById(req.params.id);
            if (!event) return res.status(404).json({ error: 'Not found' });
            const unit = await OrgUnit.findById(event.orgUnitId);
            const isOwnUnit = String(event.orgUnitId) === String(req.ecgStaff.orgUnitId);
            if (!isOwnUnit && !(await canManageUnit(req.ecgStaff, unit))) {
                return res.status(403).json({ error: 'Forbidden' });
            }
            const NewsEvent = mongoose.models.NewsEvent;
            if (NewsEvent && event.mirroredNewsEventId) {
                await NewsEvent.findByIdAndDelete(event.mirroredNewsEventId).catch(() => {});
            }
            await event.deleteOne();
            await logAudit({ staff: req.ecgStaff, orgUnit: req.ecgOrgUnit, action: 'event_retracted', target: event.headline, details: { eventId: req.params.id, headline: event.headline }, req });
            return res.json({ success: true });
        } catch (err) {
            console.error('[ecg-news] delete event error:', err.message);
            return res.status(500).json({ error: 'Server error retracting event' });
        }
    });

    console.log('[ecg-news] ECG official updates routes mounted at /ecg/events');

    return { models: { EcgOfficialEvent } };
};