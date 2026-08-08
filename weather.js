// ============================================================
//  WEATHER.JS — live weather + storm/grid-risk data for the Home
//  view's Weather card and the two Grid Risk / Weather Impact cards.
//
//  Backed by Open-Meteo (https://open-meteo.com) — free API with no
//  authentication required. Wired into server.js the same way news.js is:
//  `require('./weather')(app, {...})` right after the geocoding helpers
//  it needs already exist.
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
//  Open-Meteo's model) so the card always shows a genuine nearby
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

    // Open-Meteo API is free and requires no API key

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

    // WMO Weather Code buckets (https://www.open-meteo.com/en/docs)
    // collapsed down to the handful of conditions the UI actually distinguishes 
    // (see home.css's data-weather="clear|clear-night|cloudy|rain|storm|fog" scenes).
    const WMO_CODE_BUCKETS = {
        // Clear sky
        0: 'clear',
        // Mainly clear, partly cloudy, overcast
        1: 'cloudy', 2: 'cloudy', 3: 'cloudy',
        // Fog and depositing rime fog
        45: 'fog', 48: 'fog',
        // Drizzle
        51: 'rain', 53: 'rain', 55: 'rain',
        // Rain
        61: 'rain', 63: 'rain', 65: 'rain',
        // Rain showers
        80: 'rain', 81: 'rain', 82: 'rain',
        // Snow
        71: 'snow', 73: 'snow', 75: 'snow', 77: 'snow',
        85: 'snow', 86: 'snow',
        // Thunderstorm
        95: 'storm', 96: 'storm', 99: 'storm'
    };

    function bucketForCode(code) {
        return WMO_CODE_BUCKETS[code] || 'cloudy';
    }

    // Map WMO codes to human-readable descriptions
    const WMO_DESCRIPTIONS = {
        0: 'Clear sky',
        1: 'Mainly clear',
        2: 'Partly cloudy',
        3: 'Overcast',
        45: 'Foggy',
        48: 'Depositing rime fog',
        51: 'Light drizzle',
        53: 'Moderate drizzle',
        55: 'Dense drizzle',
        61: 'Slight rain',
        63: 'Moderate rain',
        65: 'Heavy rain',
        71: 'Slight snow',
        73: 'Moderate snow',
        75: 'Heavy snow',
        77: 'Snow grains',
        80: 'Slight rain showers',
        81: 'Moderate rain showers',
        82: 'Violent rain showers',
        85: 'Slight snow showers',
        86: 'Heavy snow showers',
        95: 'Thunderstorm',
        96: 'Thunderstorm with slight hail',
        99: 'Thunderstorm with heavy hail'
    };

    function descriptionForCode(code) {
        return WMO_DESCRIPTIONS[code] || 'Unknown';
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
    // "Thunderstorm Risk" line. `hours` here is Open-Meteo's hourly
    // array of hour objects (each with a .weather_code).
    function assessRisk(hours, startIndex, lookaheadHours) {
        if (!Array.isArray(hours) || !hours.length) {
            return { level: 'low', label: 'Low Risk', etaHours: null, worstCondition: 'clear' };
        }
        const horizon = Math.min(hours.length, startIndex + lookaheadHours);
        let worst = { condition: 'clear', hoursAway: null, rank: -1 };
        for (let i = Math.max(startIndex, 0); i < horizon; i++) {
            const code = hours[i] && typeof hours[i].weather_code === 'number' ? hours[i].weather_code : null;
            const condition = bucketForCode(code);
            const rank = conditionRank(condition);
            if (rank > worst.rank) {
                worst = { condition, hoursAway: i - startIndex, rank };
            }
        }
        if (worst.condition === 'storm') {
            return { level: 'high', label: 'High Risk', etaHours: worst.hoursAway, worstCondition: worst.condition };
        }
        if (worst.condition === 'rain') {
            return { level: 'medium', label: 'Medium Risk', etaHours: worst.hoursAway, worstCondition: worst.condition };
        }
        return { level: 'low', label: 'Low Risk', etaHours: null, worstCondition: worst.condition };
    }

    function formatEta(hoursAway) {
        if (hoursAway == null) return null;
        if (hoursAway <= 0) return 'Now';
        if (hoursAway === 1) return '1 hour';
        return `${hoursAway} hours`;
    }

    // Converts Open-Meteo's hourly data (separate arrays for time, weather_code, etc.)
    // into a flat array of hour objects for easier processing
    function flattenHours(forecast) {
        if (!forecast.hourly || !Array.isArray(forecast.hourly.time)) {
            return [];
        }
        const times = forecast.hourly.time || [];
        const codes = forecast.hourly.weather_code || [];
        const temps = forecast.hourly.temperature_2m || [];
        const precipitation = forecast.hourly.precipitation_probability || [];

        return times.map((time, i) => ({
            time,
            weather_code: codes[i],
            temperature_2m: temps[i],
            precipitation_probability: precipitation[i]
        }));
    }

    async function fetchWeatherApi(lat, lng) {
        // Open-Meteo API is free and doesn't require an API key
        // Request: current weather + 48 hours of hourly forecast
        const url = 'https://api.open-meteo.com/v1/forecast'
            + `?latitude=${lat}&longitude=${lng}`
            + '&current=temperature_2m,relative_humidity_2m,weather_code,is_day,wind_speed_10m'
            + '&hourly=weather_code,temperature_2m,precipitation_probability'
            + '&forecast_days=2'
            + '&timezone=auto';

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
        const data = await fetchWeatherApi(lat, lng);
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
            const hours = flattenHours(forecast);

            // Open-Meteo returns times in ISO format (e.g., "2024-08-08T15:00")
            // Find the current hour by comparing with the first hourly time
            let startIndex = 0;
            if (hours.length && current.time) {
                // Parse current time to get hour (remove minutes/seconds)
                const currentHourStr = current.time.slice(0, 13); // "YYYY-MM-DDTHH" or "YYYY-MM-DD HH"
                const idx = hours.findIndex((h) => h.time && h.time.slice(0, 13) >= currentHourStr);
                startIndex = idx >= 0 ? idx : 0;
            }

            const conditionCode = typeof current.weather_code === 'number' ? current.weather_code : null;
            const condition = bucketForCode(conditionCode);
            const description = descriptionForCode(conditionCode);
            const risk = assessRisk(hours, startIndex, 12);

            const rainChance = hours[startIndex] && typeof hours[startIndex].precipitation_probability === 'number'
                ? hours[startIndex].precipitation_probability
                : null;

            // Next few hours of temperature (+ rain chance) for the
            // weather card's trend graph. Open-Meteo times are ISO formatted.
            const hourlyTrend = hours.slice(startIndex, startIndex + 8).map((h) => ({
                time: h.time,
                temperatureC: typeof h.temperature_2m === 'number' ? h.temperature_2m : null,
                rainChance: typeof h.precipitation_probability === 'number' ? h.precipitation_probability : null
            }));

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
                    temperatureC: typeof current.temperature_2m === 'number' ? current.temperature_2m : null,
                    windKph: typeof current.wind_speed_10m === 'number' ? current.wind_speed_10m : null,
                    humidity: typeof current.relative_humidity_2m === 'number' ? current.relative_humidity_2m : null,
                    condition,
                    description,
                    weatherCode: conditionCode,
                    rainChance,
                    // 1 = daytime, 0 = nighttime (Open-Meteo's own sun-up/
                    // sun-down flag for this location) — lets the client
                    // show a moon/stars scene instead of a sun for a
                    // genuinely clear night, rather than guessing from
                    // local device time.
                    isDay: typeof current.is_day === 'number' ? current.is_day : null
                },
                // Short forward-looking trend for the weather card's
                // graph — see hourlyTrend above.
                hourly: hourlyTrend,
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