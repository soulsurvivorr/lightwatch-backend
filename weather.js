// ============================================================
//  WEATHER.JS — live weather + storm/grid-risk data for the Home
//  view's Weather card and the two Grid Risk / Weather Impact cards.
//
//  Backed by WeatherAPI.com (https://www.weatherapi.com) — needs an
//  API key, read from process.env.WEATHERAPI_KEY (set that in the
//  backend's env, not in this file). Wired into server.js the same
//  way news.js is: `require('./weather')(app, {...})` right after the
//  geocoding helpers it needs already exist.
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
//  WeatherAPI's model) so the card always shows a genuine nearby
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

    // Required for every WeatherAPI.com call. Read lazily inside the
    // fetch function (not at module load) so a missing key surfaces as
    // a normal 502 from the /weather route instead of crashing boot.
    const WEATHERAPI_KEY = process.env.WEATHERAPI_KEY;

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

    // WeatherAPI.com condition codes collapsed down to the handful of
    // conditions the UI actually distinguishes (see home.css's
    // data-weather="clear|clear-night|cloudy|rain|storm|fog" scenes).
    // WeatherAPI's own condition.text is used directly for the
    // human-readable description, so this table only needs to carry
    // the bucket, not separate desc strings — full code list at
    // https://www.weatherapi.com/docs/weather_conditions.json
    const WEATHERAPI_CODE_BUCKETS = {
        1000: 'clear',
        1003: 'cloudy', 1006: 'cloudy', 1009: 'cloudy',
        1030: 'fog', 1135: 'fog', 1147: 'fog',
        1063: 'rain', 1150: 'rain', 1153: 'rain', 1168: 'rain', 1171: 'rain',
        1180: 'rain', 1183: 'rain', 1186: 'rain', 1189: 'rain', 1192: 'rain',
        1195: 'rain', 1198: 'rain', 1201: 'rain', 1240: 'rain', 1243: 'rain',
        1246: 'rain', 1249: 'rain', 1252: 'rain',
        1066: 'snow', 1069: 'snow', 1072: 'snow', 1114: 'snow', 1117: 'snow',
        1204: 'snow', 1207: 'snow', 1210: 'snow', 1213: 'snow', 1216: 'snow',
        1219: 'snow', 1222: 'snow', 1225: 'snow', 1237: 'snow', 1255: 'snow',
        1258: 'snow', 1261: 'snow', 1264: 'snow',
        1087: 'storm', 1273: 'storm', 1276: 'storm', 1279: 'storm', 1282: 'storm'
    };

    function bucketForCode(code) {
        return WEATHERAPI_CODE_BUCKETS[code] || 'cloudy';
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
    // "Thunderstorm Risk" line. `hours` here is WeatherAPI's own flat
    // array of hour objects (each with a .condition.code), already
    // combined across the requested forecast days — see flattenHours().
    function assessRisk(hours, startIndex, lookaheadHours) {
        if (!Array.isArray(hours) || !hours.length) {
            return { level: 'low', label: 'Low Risk', etaHours: null, worstCondition: 'clear' };
        }
        const horizon = Math.min(hours.length, startIndex + lookaheadHours);
        let worst = { condition: 'clear', hoursAway: null, rank: -1 };
        for (let i = Math.max(startIndex, 0); i < horizon; i++) {
            const code = hours[i] && hours[i].condition ? hours[i].condition.code : null;
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

    // Flattens WeatherAPI's forecast.forecastday[].hour[] (one array per
    // day) into a single chronological array, same shape the rest of
    // this file wants to scan across a day boundary (e.g. "risk in the
    // next 12 hours" when it's currently 8pm).
    function flattenHours(forecast) {
        const days = (forecast.forecast && forecast.forecast.forecastday) || [];
        return days.reduce((all, day) => all.concat(day.hour || []), []);
    }

    async function fetchWeatherApi(lat, lng) {
        if (!WEATHERAPI_KEY) {
            throw new Error('WEATHERAPI_KEY environment variable is not set');
        }
        const url = 'https://api.weatherapi.com/v1/forecast.json'
            + `?key=${encodeURIComponent(WEATHERAPI_KEY)}&q=${lat},${lng}`
            + '&days=2&aqi=no&alerts=no';

        const response = await timeExternalCall(`WeatherAPI forecast (${lat},${lng})`, () => fetch(url));
        if (!response.ok) {
            throw new Error(`WeatherAPI responded ${response.status}`);
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

            // WeatherAPI hour.time is a local "YYYY-MM-DD HH:00" string
            // (already in the location's own timezone, same as
            // location.localtime below) — a straight string compare
            // finds the first hour at/after "now" without any parsing.
            const nowLocal = (forecast.location && forecast.location.localtime) || '';
            let startIndex = 0;
            if (hours.length && nowLocal) {
                const nowHourPrefix = nowLocal.slice(0, 13); // "YYYY-MM-DD HH"
                const idx = hours.findIndex((h) => h.time && h.time.slice(0, 13) >= nowHourPrefix);
                startIndex = idx >= 0 ? idx : 0;
            }

            const conditionCode = current.condition ? current.condition.code : null;
            const condition = bucketForCode(conditionCode);
            const description = (current.condition && current.condition.text) || 'Unknown';
            const risk = assessRisk(hours, startIndex, 12);

            const rainChance = hours[startIndex] && typeof hours[startIndex].chance_of_rain === 'number'
                ? hours[startIndex].chance_of_rain
                : null;

            // Next few hours of temperature (+ rain chance) for the
            // weather card's trend graph. Local time strings only —
            // the client formats hour labels itself.
            const hourlyTrend = hours.slice(startIndex, startIndex + 8).map((h) => ({
                time: h.time,
                temperatureC: typeof h.temp_c === 'number' ? h.temp_c : null,
                rainChance: typeof h.chance_of_rain === 'number' ? h.chance_of_rain : null
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
                    temperatureC: typeof current.temp_c === 'number' ? current.temp_c : null,
                    windKph: typeof current.wind_kph === 'number' ? current.wind_kph : null,
                    humidity: typeof current.humidity === 'number' ? current.humidity : null,
                    condition,
                    description,
                    weatherCode: conditionCode,
                    rainChance,
                    // 1 = daytime, 0 = nighttime (WeatherAPI's own sun-up/
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