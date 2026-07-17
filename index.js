const Router = require("./router");

// The Cloudflare worker runtime populates these globals.
//
// `globalThis` solves the chicken-and-egg problem of not being able to deploy
// the worker without the secret defined, and not being able to define the secret
// without the working already being deployed. See here for more context:
// https://github.com/cloudflare/wrangler/issues/1418
const Env = {
  STRAVA_ID: globalThis.STRAVA_ID,
  STRAVA_SESSION: globalThis.STRAVA_SESSION,
  TILE_CACHE_SECS: +globalThis.TILE_CACHE_SECS || 0,
  ALLOWED_ORIGINS: (globalThis.ALLOWED_ORIGINS || "*").split(","),
};

addEventListener("fetch", (event) => {
  event.respondWith(handleRequest(event));
});

// Non-browser clients (JOSM, GIS software, native apps) send no Origin header
// and are not subject to CORS, so an absent Origin is always allowed through.
function isOriginAllowed(origin) {
  if (origin === null) return true;
  if (Env.ALLOWED_ORIGINS.includes("*")) return true;
  return Env.ALLOWED_ORIGINS.includes(origin);
}

async function handleRequest(event) {
  try {
    // Checked before the cache lookup: the cache is keyed on URL alone, so a
    // check further down would be skipped entirely on a cache hit.
    const origin = event.request.headers.get("origin");
    if (!isOriginAllowed(origin)) {
      return new Response("Origin not allowed", { status: 403 });
    }

    let response = await caches.default.match(event.request.url);

    if (!response) {
      const r = new Router();
      r.get("/(personal|global)/.*", (req) =>
        handleTileProxyRequest(req, event),
      );
      r.get("/", () => handleIndexRequest());

      response = await r.route(event.request);

      if (Env.TILE_CACHE_SECS > 0 && response.status === 200) {
        response = new Response(response.body, response);
        response.headers.append(
          "Cache-Control",
          `max-age=${Env.TILE_CACHE_SECS}`,
        );
        // Stored before CORS headers are attached, so the entry stays
        // origin-agnostic and can be handed to any caller below.
        event.waitUntil(
          caches.default.put(event.request.url, response.clone()),
        );
      }
    }

    if (origin !== null) {
      response = new Response(response.body, response);
      response.headers.set(
        "Access-Control-Allow-Origin",
        Env.ALLOWED_ORIGINS.includes("*") ? "*" : origin,
      );
      response.headers.set("Vary", "Origin");
    }

    return response;
  } catch (err) {
    return new Response(`err in request handler: ${err}`, { status: 500 });
  }
}

function handleIndexRequest() {
  return new Response(`\
Global Heatmap
       256px: /global/:color/:activity/{z}/{x}/{y}@small.png
       512px: /global/:color/:activity/{z}/{x}/{y}.png
      1024px: /global/:color/:activity/{z}/{x}/{y}@2x.png

      colors: mobileblue, orange, hot, blue, bluered, purple, gray
  activities: all, ride, winter, run, water, ...


Personal Heatmap
       512px: /personal/:color/:activity/{z}/{x}/{y}.png
      1024px: /personal/:color/:activity/{z}/{x}/{y}@2x.png

      colors: orange, hot, blue, bluered, purple, gray
  activities: all, ride, winter, run, water, ...


Additional Activity Types
    sport_AlpineSki
    sport_BackcountrySki
    sport_Badminton
    sport_Canoeing
    sport_EBikeRide
    sport_EMountainBikeRide
    sport_Golf
    sport_GravelRide
    sport_Handcycle
    sport_Hike
    sport_IceSkate
    sport_InlineSkate
    sport_Kayaking
    sport_Kitesurf
    sport_MountainBikeRide
    sport_NordicSki
    sport_Pickleball
    sport_Ride
    sport_RockClimbing
    sport_RollerSki
    sport_Rowing
    sport_Run
    sport_Sail
    sport_Skateboard
    sport_Snowboard
    sport_Snowshoe
    sport_Soccer
    sport_StandUpPaddling
    sport_Surfing
    sport_Swim
    sport_Tennis
    sport_TrailRun
    sport_Velomobile
    sport_VirtualRide
    sport_VirtualRow
    sport_VirtualRun
    sport_Walk
    sport_Wheelchair
    sport_Windsurf
`);
}

// Assumed lifetime when Strava sends no usable expiry. Short enough to recover
// quickly if the guess is wrong, long enough that we are not re-authenticating
// constantly.
const FALLBACK_EXPIRY_MS = 60 * 60 * 1000;

// Anything below this is far too small to be a millisecond timestamp for a
// present-day date, so it must be seconds.
const SECONDS_EPOCH_CEILING = 1e12;

// CloudFront expiry epochs are conventionally in seconds, but Date.now() is in
// milliseconds. Comparing the two directly makes every cached entry look stale,
// which turns the freshness check into a login on every single tile request.
// Normalize to milliseconds, and fall back to a fixed lifetime if Strava gives
// us nothing usable rather than treating it as permanently expired.
function normalizeExpiry(raw, now) {
  if (!Number.isFinite(raw) || raw <= 0) return now + FALLBACK_EXPIRY_MS;
  const ms = raw < SECONDS_EPOCH_CEILING ? raw * 1000 : raw;
  return ms > now ? ms : now + FALLBACK_EXPIRY_MS;
}

// Exchange our session cookie for fresh CloudFront credentials via /maps.
async function refreshCloudFrontCookies() {
  const resp = await fetch("https://www.strava.com/maps", {
    headers: {
      Cookie: `_strava4_session=${Env.STRAVA_SESSION}`,
      Referer: "https://www.strava.com/",
      Origin: "https://www.strava.com",
    },
    redirect: "manual",
  });

  const cookieNames = [
    "CloudFront-Key-Pair-Id",
    "CloudFront-Policy",
    "CloudFront-Signature",
    "_strava_idcf",
  ];

  const cookies = {};
  let rawExpiry = NaN;

  for (const header of resp.headers.getAll("set-cookie")) {
    const match = header.match(/^([^=]+)=([^;]*)/);
    if (!match) continue;
    const [_, name, value] = match;

    if (value && cookieNames.includes(name)) {
      cookies[name] = value;
    } else if (name === "_strava_CloudFront-Expires" && value) {
      rawExpiry = parseInt(value, 10);
    }
  }

  if (cookieNames.some((name) => !cookies[name])) {
    throw new Error(
      "Failed to obtain CloudFront cookies from Strava — session may be invalid",
    );
  }

  const cookieStr = Object.entries(cookies)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");

  return { cookies: cookieStr, expiry: normalizeExpiry(rawExpiry, Date.now()) };
}

const KV_KEY = "strava_cloudfront_cookies";
const REFRESH_BUFFER_MS = 5 * 60 * 1000; // refresh 5 minutes before expiry

// in-memory cache, persists across requests within an isolate
let COOKIE_CACHE = null;

// Held while a refresh is running so concurrent requests join it instead of
// each firing its own login at Strava. One map pan misses the cache on ~30
// tiles at once, and 30 simultaneous logins is what gets an account flagged.
// This only spans a single isolate, but that is where the pile-up happens.
let REFRESH_IN_FLIGHT = null;

function isFresh(entry, now) {
  return Boolean(entry && entry.expiry > now + REFRESH_BUFFER_MS);
}

function refreshOnce(event) {
  if (REFRESH_IN_FLIGHT) return REFRESH_IN_FLIGHT;

  REFRESH_IN_FLIGHT = refreshCloudFrontCookies()
    .then((fresh) => {
      COOKIE_CACHE = fresh;
      const ttlSecs = Math.max(
        Math.floor((fresh.expiry - Date.now()) / 1000),
        60,
      );
      // Every line here is one login against Strava. Seeing these arrive per
      // tile rather than per hour is the signal that something is wrong.
      console.log(
        `refreshed CloudFront cookies, valid ${Math.round(ttlSecs / 60)}m`,
      );
      event.waitUntil(
        STRAVA_HEATMAP_PROXY_COOKIES.put(KV_KEY, JSON.stringify(fresh), {
          expirationTtl: ttlSecs,
        }),
      );
      return fresh;
    })
    .finally(() => {
      REFRESH_IN_FLIGHT = null;
    });

  return REFRESH_IN_FLIGHT;
}

// Get valid CloudFront cookies, refreshing if needed. Pass force after Strava
// has rejected the cookies we hold, to bypass both caches.
async function getStravaCookies(event, force = false) {
  const now = Date.now();

  if (!force) {
    if (isFresh(COOKIE_CACHE, now)) return COOKIE_CACHE.cookies;

    const fromKv = await STRAVA_HEATMAP_PROXY_COOKIES.get(KV_KEY, {
      type: "json",
    });

    if (isFresh(fromKv, now)) {
      COOKIE_CACHE = fromKv;
      return COOKIE_CACHE.cookies;
    }
  }

  const fresh = await refreshOnce(event);
  return fresh.cookies;
}

const PERSONAL_MAP_URL =
  "https://personal-heatmaps-external.strava.com/" +
  "tiles/{strava_id}/{color}/{z}/{x}/{y}{res}.png" +
  "?filter_type={activity}&include_everyone=true" +
  "&include_followers_only=true&respect_privacy_zones=true";

const GLOBAL_MAP_URL =
  "https://content-a.strava.com/" +
  "identified/globalheat/{activity}/{color}/{z}/{x}/{y}{res}.png?v=19{qs}";

// Proxy requests from /kind/color/activity/z/x/y(?@2x).png to baseUrl
async function handleTileProxyRequest(request, event) {
  const url = new URL(request.url);

  const match = url.pathname.match(
    new RegExp(
      "(personal|global)/(\\w+)/(\\w+)/(\\d+)/(\\d+)/(\\d+)(@small|@2x)?.png",
    ),
  );
  if (match === null) {
    return new Response(
      "invalid url, expected: /kind/color/activity/z/x/y.png",
      {
        status: 400,
      },
    );
  }

  const [_, kind, color, activity, z, x, y, res] = match;
  const data = {
    strava_id: Env.STRAVA_ID,
    color,
    activity,
    x,
    y,
    z,
    // "@small" and "@2x" as part of the URL don't map 1:1 to Strava's API.
    res: res === "@small" ? "" : res || "",
    qs: res === "@small" ? "&px=256" : "",
  };

  const baseUrl = kind === "personal" ? PERSONAL_MAP_URL : GLOBAL_MAP_URL;
  // replace templated data in base URL
  const proxyUrl = baseUrl.replace(/\{(\w+)\}/g, (_, key) => data[key]);

  let response = await fetchTile(proxyUrl, kind, event, false);

  // Strava can invalidate cookies before they expire — a logout, a password
  // change, a policy update. Going on expiry alone would leave us serving 403s
  // until the clock ran out, so treat a rejection as a reason to
  // re-authenticate now and try the tile once more.
  //
  // Only 403. A 401 from the personal host means STRAVA_SESSION itself was
  // rejected, and minting new CloudFront cookies cannot fix that — the secret
  // needs replacing by hand.
  if (response.status === 403) {
    response = await fetchTile(proxyUrl, kind, event, true);
  }

  return new Response(await response.arrayBuffer(), response);
}

// The personal heatmap is per-athlete, so its host has to know who is asking.
// The CloudFront cookies are only an access grant and carry no identity, which
// is what a 401 from that host means. Strava's own client sends
// _strava4_session alongside them, so do the same — but only to the host that
// needs it, since the global heatmap is identical for everyone and has no use
// for our identity.
function cookieHeaderFor(kind, cloudFrontCookies) {
  if (kind !== "personal") return cloudFrontCookies;
  return `${cloudFrontCookies}; _strava4_session=${Env.STRAVA_SESSION}`;
}

async function fetchTile(proxyUrl, kind, event, force) {
  const cloudFrontCookies = await getStravaCookies(event, force);

  return fetch(
    new Request(proxyUrl, {
      method: "GET",
      headers: new Headers({
        Cookie: cookieHeaderFor(kind, cloudFrontCookies),
      }),
    }),
  );
}
