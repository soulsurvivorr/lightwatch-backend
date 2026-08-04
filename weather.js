// ============================================================
//  WEATHER.JS — live weather + storm/grid-risk data for the Home
//  view's Weather card and the two Grid Risk / Weather Impact cards.
//
//  Backed by Open-Meteo (https://open-meteo.com) — free, no API key,
//  no rate-limit hassle for this scale of traffic. Wired into
//  server.js the same way news.js is: `require('./weather')(app, {...})`
//  right after the geocoding helpers it needs already exist.
//
//  WHY A SEPARATE FILE: this is a self-contained slice (one outbound
//  API, a couple of routes, no Mongo models) — keeping it out of
//  server.js keeps that file from growing further and makes this
//  piece independently testable/replaceable later (e.g. swapping in
//  a paid provider) without touching anything else.
//
//  WHAT IT EXPORTS: a single function(app, deps) — called once from
//  server.js — that registers:
//    GET /weather   — current conditions + storm/grid risk for a
//                      location name (or explicit lat/lng)
//
//  LOCATION RESOLUTION (the "Mampong fallback" behavior):
//  Small towns/suburbs the user might be under (a neighborhood that
//  isn't in GHANA_TOWN_COORDS and that Nominatim can't confidently
//  geocode either) would otherwise fall through resolveLocationCoords()
//  to its last-resort behavior — a deterministic-but-arbitrary point
//  scattered anywhere in Ghana's bounding box. That's fine for a map
//  pin (it still needs SOME position), but useless for weather: it
//  can land hours away from the person. So here specifically, if
//  resolution comes back "approximate" (= the scatter fallback), this
//  swaps in a real nearby, well-known town's coordinates instead
//  (FALLBACK_TOWN, defaults to Mampong — central, well covered by
//  Open-Meteo's model grid) so the card always shows a genuine nearby
//  forecast rather than a random one. The response marks
//  `approximate: true` in that case so the client can label it
//  ("near you") instead of implying pinpoint accuracy.
// ============================================================

module.exports = function registerWeatherRoutes(app, deps) {
    const {
        resolveLocationCoords,   // async (locationKey, storedLat, storedLng, displayLabel, region) -> {lat, lng, approximate}
        normalizeLocation,
        titleCaseLocation,
        timeExternalCall,
        GHANA_TOWN_COORDS,
        reverseGeocodeCity      // async (lat, lng) -> string|null — used when the client sends a raw GPS
                                 // fix (no location name) so lwxWeatherCity can still show a real city
                                 // instead of falling back to "Your area". Same helper server.js's own
                                 // /geocode/reverse route already uses.
    } = deps;

    if (typeof resolveLocationCoords !== 'function') {
        throw new Error('weather.js requires resolveLocationCoords from server.js');
    }

    // Nearest well-known town to fall back to when the requested place
    // can't be confidently geocoded. Override with WEATHER_FALLBACK_TOWN
    // (must be a lowercase, no-space key already present in
    // GHANA_TOWN_COORDS, e.g. "kumasi", "accra") if the default doesn't
    // fit your users' area.
    const FALLBACK_TOWN = (process.env.WEATHER_FALLBACK_TOWN || 'mampong').toLowerCase();

    // In-memory cache, keyed by a coarse (~5km) coordinate bucket, so
    // several people near each other don't each trigger their own
    // Open-Meteo call, and one person refreshing Home repeatedly doesn't
    // either. Fine to be in-memory/per-process — this is a "how's the
    // sky right now" cache, not data anyone needs consistent across
    // server restarts or multiple instances.
    const WEATHER_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
    const weatherCache = new Map();

    // Separate, much longer-lived cache for reverse-geocoded city names.
    // Unlike the weather itself, the city a coordinate sits in doesn't
    // change — no reason to re-hit the Google Maps API every 10 minutes
    // just because the weather cache expired.
    const CITY_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
    const cityCache = new Map();

    function roundCoord(n) {
        return Math.round(n * 20) / 20; // ~0.05deg grid, roughly 5km
    }

    // GPS-only requests (no ?location= name) arrive with just lat/lng, so
    // there's nothing to title-case into a display label — resolve one via
    // reverse geocoding instead, the same way the signup page's "use my
    // location" button already does via /geocode/reverse. Falls back to
    // null (caller shows "Your area") if reverseGeocodeCity isn't wired up
    // or the lookup fails/returns nothing, rather than blowing up the route.
    async function getCityForCoords(lat, lng) {
        if (typeof reverseGeocodeCity !== 'function') return null;
        const key = `${roundCoord(lat)},${roundCoord(lng)}`;
        const cached = cityCache.get(key);
        if (cached && (Date.now() - cached.fetchedAt) < CITY_CACHE_TTL_MS) {
            return cached.city;
        }
        try {
            const city = await reverseGeocodeCity(lat, lng);
            cityCache.set(key, { city, fetchedAt: Date.now() });
            return city;
        } catch (err) {
            console.error('[weather] reverse geocode failed:', err.message);
            return null;
        }
    }

    // WMO weather codes (the scheme Open-Meteo uses) collapsed down to
    // the handful of conditions the UI actually distinguishes.
    const WMO_CODES = {
        0: { desc: 'Clear sky', condition: 'clear' },
        1: { desc: 'Mainly clear', condition: 'clear' },
        2: { desc: 'Partly cloudy', condition: 'cloudy' },
        3: { desc: 'Overcast', condition: 'cloudy' },
        45: { desc: 'Fog', condition: 'fog' },
        48: { desc: 'Depositing rime fog', condition: 'fog' },
        51: { desc: 'Light drizzle', condition: 'rain' },
        53: { desc: 'Drizzle', condition: 'rain' },
        55: { desc: 'Dense drizzle', condition: 'rain' },
        56: { desc: 'Light freezing drizzle', condition: 'rain' },
        57: { desc: 'Freezing drizzle', condition: 'rain' },
        61: { desc: 'Slight rain', condition: 'rain' },
        63: { desc: 'Rain', condition: 'rain' },
        65: { desc: 'Heavy rain', condition: 'rain' },
        66: { desc: 'Light freezing rain', condition: 'rain' },
        67: { desc: 'Freezing rain', condition: 'rain' },
        71: { desc: 'Slight snow', condition: 'snow' },
        73: { desc: 'Snow', condition: 'snow' },
        75: { desc: 'Heavy snow', condition: 'snow' },
        77: { desc: 'Snow grains', condition: 'snow' },
        80: { desc: 'Slight rain showers', condition: 'rain' },
        81: { desc: 'Rain showers', condition: 'rain' },
        82: { desc: 'Violent rain showers', condition: 'rain' },
        85: { desc: 'Slight snow showers', condition: 'snow' },
        86: { desc: 'Heavy snow showers', condition: 'snow' },
        95: { desc: 'Thunderstorm', condition: 'storm' },
        96: { desc: 'Thunderstorm, slight hail', condition: 'storm' },
        99: { desc: 'Thunderstorm, heavy hail', condition: 'storm' }
    };

    function describeCode(code) {
        return WMO_CODES[code] || { desc: 'Unknown', condition: 'cloudy' };
    }

    // Ranks conditions purely for "which of these two is worse" comparisons
    // below — has no meaning outside this file.
    function conditionRank(condition) {
        if (condition === 'storm') return 3;
        if (condition === 'rain') return 2;
        if (condition === 'fog' || condition === 'snow') return 1;
        return 0;
    }

    // Scans the next `hours` hourly entries (starting at startIndex) for
    // the worst weather ahead, and how far away it is — this is what
    // drives both the Grid Risk card's ETA and the weather card's
    // "Thunderstorm Risk" line.
    function assessRisk(hourlyTimes, hourlyCodes, startIndex, hours) {
        if (!Array.isArray(hourlyTimes) || !Array.isArray(hourlyCodes)) {
            return { level: 'low', label: 'Low Risk', etaHours: null, worstCode: 0 };
        }
        const horizon = Math.min(hourlyCodes.length, startIndex + hours);
        let worst = { code: 0, hoursAway: null };
        for (let i = Math.max(startIndex, 0); i < horizon; i++) {
            const code = hourlyCodes[i] ?? 0;
            const rank = conditionRank(describeCode(code).condition);
            const worstRank = conditionRank(describeCode(worst.code).condition);
            if (rank > worstRank) {
                worst = { code, hoursAway: i - startIndex };
            }
        }
        const condition = describeCode(worst.code).condition;
        if (condition === 'storm') {
            return { level: 'high', label: 'High Risk', etaHours: worst.hoursAway, worstCode: worst.code };
        }
        if (condition === 'rain') {
            return { level: 'medium', label: 'Medium Risk', etaHours: worst.hoursAway, worstCode: worst.code };
        }
        return { level: 'low', label: 'Low Risk', etaHours: null, worstCode: worst.code };
    }

    function formatEta(hoursAway) {
        if (hoursAway == null) return null;
        if (hoursAway <= 0) return 'Now';
        if (hoursAway === 1) return '1 hour';
        return `${hoursAway} hours`;
    }

    async function fetchOpenMeteo(lat, lng) {
        const url = 'https://api.open-meteo.com/v1/forecast'
            + `?latitude=${lat}&longitude=${lng}`
            + '&current=temperature_2m,weather_code,wind_speed_10m,precipitation,relative_humidity_2m,is_day'
            + '&hourly=weather_code,precipitation_probability,wind_speed_10m'
            + '&forecast_days=2&timezone=auto';

        const response = await timeExternalCall(`Open-Meteo forecast (${lat},${lng})`, () => fetch(url));
        if (!response.ok) {
            throw new Error(`Open-Meteo responded ${response.status}`);
        }
        return response.json();
    }

    async function getWeatherForCoords(lat, lng) {
        const key = `${roundCoord(lat)},${roundCoord(lng)}`;
        const cached = weatherCache.get(key);
        if (cached && (Date.now() - cached.fetchedAt) < WEATHER_CACHE_TTL_MS) {
            return cached.data;
        }
        const data = await fetchOpenMeteo(lat, lng);
        weatherCache.set(key, { data, fetchedAt: Date.now() });
        return data;
    }

    // ------------------------------------------------------------
    // GET /weather?location=<name>&region=<region optional>
    //          or  ?lat=<n>&lng=<n>  (skips geocoding entirely — used
    //          when the browser already has a GPS fix)
    // ------------------------------------------------------------
    app.get('/weather', async (req, res) => {
        try {
            const { location, region } = req.query;
            const latParam = req.query.lat;
            const lngParam = req.query.lng;

            let resolvedLat, resolvedLng;
            let approximate = false;
            let cityLabel = location ? titleCaseLocation(normalizeLocation(location)) : null;

            const latNum = Number(latParam);
            const lngNum = Number(lngParam);
            const hasCoords = latParam !== undefined && lngParam !== undefined
                && Number.isFinite(latNum) && Number.isFinite(lngNum);

            if (hasCoords) {
                resolvedLat = latNum;
                resolvedLng = lngNum;
                // The client sent a raw GPS fix and no location name (this
                // is the common path — weather-home.js prefers GPS whenever
                // it's available), so cityLabel is still null at this point.
                // Without this, the response always fell back to "Your area"
                // regardless of where the user actually is. Reverse-geocode
                // it the same way /geocode/reverse does, and only fall back
                // to "Your area" (below) if that comes back empty too.
                const resolvedCity = await getCityForCoords(resolvedLat, resolvedLng);
                if (resolvedCity) cityLabel = resolvedCity;
            } else if (location && String(location).trim()) {
                const locationKey = normalizeLocation(location).replace(/[^a-z0-9]/g, '');
                let resolved = await resolveLocationCoords(locationKey, null, null, location, region);

                // See file header — swap the arbitrary scatter fallback
                // for a real nearby town so weather stays meaningful.
                if (resolved.approximate) {
                    const fallbackHit = GHANA_TOWN_COORDS && GHANA_TOWN_COORDS[FALLBACK_TOWN];
                    if (fallbackHit) {
                        resolved = { lat: fallbackHit[0], lng: fallbackHit[1], approximate: false };
                        cityLabel = titleCaseLocation(FALLBACK_TOWN);
                    }
                    approximate = true;
                }

                resolvedLat = resolved.lat;
                resolvedLng = resolved.lng;
            } else {
                return res.status(400).json({ error: 'location or lat/lng is required' });
            }

            const forecast = await getWeatherForCoords(resolvedLat, resolvedLng);
            const current = forecast.current || {};
            const hourly = forecast.hourly || {};

            let startIndex = 0;
            if (Array.isArray(hourly.time) && current.time) {
                const idx = hourly.time.findIndex((t) => t >= current.time);
                startIndex = idx >= 0 ? idx : 0;
            }

            const code = current.weather_code ?? 0;
            const meta = describeCode(code);
            const risk = assessRisk(hourly.time, hourly.weather_code, startIndex, 12);

            const rainChance = Array.isArray(hourly.precipitation_probability)
                ? hourly.precipitation_probability[startIndex] ?? null
                : null;

            const impactDescription = risk.level === 'high'
                ? 'High chance of weather-related outages today.'
                : risk.level === 'medium'
                    ? 'Medium chance of weather-related outages today.'
                    : 'Low chance of weather-related outages today.';

            const gridRiskDescription = risk.level === 'high'
                ? 'Heavy thunderstorms approaching.'
                : risk.level === 'medium'
                    ? 'Rain showers expected in your area.'
                    : 'No significant storms expected.';

            res.json({
                location: cityLabel || 'Your area',
                approximate,
                coords: { lat: resolvedLat, lng: resolvedLng },
                current: {
                    temperatureC: current.temperature_2m ?? null,
                    windKph: current.wind_speed_10m ?? null,
                    humidity: current.relative_humidity_2m ?? null,
                    condition: meta.condition,
                    description: meta.desc,
                    weatherCode: code,
                    rainChance,
                    // 1 = daytime, 0 = nighttime (Open-Meteo's own sun-up/
                    // sun-down flag for this location) — lets the client
                    // show a moon/stars scene instead of a sun for a
                    // genuinely clear night, rather than guessing from
                    // local device time.
                    isDay: typeof current.is_day === 'number' ? current.is_day : null
                },
                risk: {
                    level: risk.level,           // 'low' | 'medium' | 'high'
                    label: risk.label,           // 'Low Risk' | 'Medium Risk' | 'High Risk'
                    etaHours: risk.etaHours,
                    eta: formatEta(risk.etaHours),
                    gridRiskDescription,
                    impactDescription
                },
                fetchedAt: new Date().toISOString()
            });
        } catch (err) {
            console.error('GET /weather error:', err.message);
            res.status(502).json({ error: 'Could not fetch live weather right now.' });
        }
    });
};