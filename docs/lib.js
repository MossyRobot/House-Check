// Pure logic shared by the page and the tests (no DOM access here).

// ---------- WGS84 lat/lon -> British National Grid (OSGB36) ----------
// Helmert transform + Transverse Mercator. Accurate to ~5 m, plenty for 1 km squares.

const rad = (d) => (d * Math.PI) / 180;

function toCartesian(lat, lon, a, b, h = 0) {
  const e2 = 1 - (b * b) / (a * a);
  const sinPhi = Math.sin(lat), cosPhi = Math.cos(lat);
  const nu = a / Math.sqrt(1 - e2 * sinPhi * sinPhi);
  return [
    (nu + h) * cosPhi * Math.cos(lon),
    (nu + h) * cosPhi * Math.sin(lon),
    ((1 - e2) * nu + h) * sinPhi,
  ];
}

function fromCartesian([x, y, z], a, b) {
  const e2 = 1 - (b * b) / (a * a);
  const p = Math.sqrt(x * x + y * y);
  let lat = Math.atan2(z, p * (1 - e2));
  for (let i = 0; i < 10; i++) {
    const nu = a / Math.sqrt(1 - e2 * Math.sin(lat) ** 2);
    lat = Math.atan2(z + e2 * nu * Math.sin(lat), p);
  }
  return [lat, Math.atan2(y, x)];
}

export function wgs84ToBng(latDeg, lonDeg) {
  // WGS84 -> OSGB36 (Helmert, OS published parameters)
  const [x1, y1, z1] = toCartesian(rad(latDeg), rad(lonDeg), 6378137, 6356752.3142);
  const tx = -446.448, ty = 125.157, tz = -542.06;
  const s = 20.4894e-6;
  const rx = rad(-0.1502 / 3600), ry = rad(-0.247 / 3600), rz = rad(-0.8421 / 3600);
  const x2 = tx + (1 + s) * x1 - rz * y1 + ry * z1;
  const y2 = ty + rz * x1 + (1 + s) * y1 - rx * z1;
  const z2 = tz - ry * x1 + rx * y1 + (1 + s) * z1;
  const a = 6377563.396, b = 6356256.909;
  const [phi, lam] = fromCartesian([x2, y2, z2], a, b);

  // Transverse Mercator (National Grid)
  const F0 = 0.9996012717, phi0 = rad(49), lam0 = rad(-2), N0 = -100000, E0 = 400000;
  const e2 = 1 - (b * b) / (a * a), n = (a - b) / (a + b);
  const sinP = Math.sin(phi), cosP = Math.cos(phi), tanP = Math.tan(phi);
  const nu = (a * F0) / Math.sqrt(1 - e2 * sinP * sinP);
  const rho = (a * F0 * (1 - e2)) / Math.pow(1 - e2 * sinP * sinP, 1.5);
  const eta2 = nu / rho - 1;
  const dP = phi - phi0, sP = phi + phi0;
  const M = b * F0 * (
    (1 + n + (5 / 4) * n ** 2 + (5 / 4) * n ** 3) * dP
    - (3 * n + 3 * n ** 2 + (21 / 8) * n ** 3) * Math.sin(dP) * Math.cos(sP)
    + ((15 / 8) * n ** 2 + (15 / 8) * n ** 3) * Math.sin(2 * dP) * Math.cos(2 * sP)
    - (35 / 24) * n ** 3 * Math.sin(3 * dP) * Math.cos(3 * sP)
  );
  const I = M + N0;
  const II = (nu / 2) * sinP * cosP;
  const III = (nu / 24) * sinP * cosP ** 3 * (5 - tanP ** 2 + 9 * eta2);
  const IIIA = (nu / 720) * sinP * cosP ** 5 * (61 - 58 * tanP ** 2 + tanP ** 4);
  const IV = nu * cosP;
  const V = (nu / 6) * cosP ** 3 * (nu / rho - tanP ** 2);
  const VI = (nu / 120) * cosP ** 5 * (5 - 18 * tanP ** 2 + tanP ** 4 + 14 * eta2 - 58 * tanP ** 2 * eta2);
  const dL = lam - lam0;
  return {
    easting: E0 + IV * dL + V * dL ** 3 + VI * dL ** 5,
    northing: I + II * dL ** 2 + III * dL ** 4 + IIIA * dL ** 6,
  };
}

// ---------- Radon grid (built by tools/build_radon.py) ----------

export const RADON_BANDS = { 1: "under 1%", 2: "1–3%", 3: "3–5%", 4: "5–10%", 5: "10–30%", 6: "30% or more" };

export function parseRadonGrid(buffer) {
  const bytes = new Uint8Array(buffer);
  const magic = String.fromCharCode(...bytes.slice(0, 4));
  if (magic !== "RDN1") throw new Error("Not a radon grid file");
  const dv = new DataView(buffer instanceof ArrayBuffer ? buffer : bytes.buffer, bytes.byteOffset);
  return {
    width: dv.getUint16(4, true),
    height: dv.getUint16(6, true),
    x0: dv.getUint16(8, true) * 1000,
    y0: dv.getUint16(10, true) * 1000,
    cells: bytes.subarray(16),
  };
}

/** Radon class 1-6 for a lat/lon, or null where the GB atlas has no data. */
export function radonClassAt(grid, lat, lon) {
  const { easting, northing } = wgs84ToBng(lat, lon);
  const col = Math.floor((easting - grid.x0) / 1000);
  const row = Math.floor((northing - grid.y0) / 1000);
  if (col < 0 || row < 0 || col >= grid.width || row >= grid.height) return null;
  const i = row * grid.width + col;
  const byte = grid.cells[i >> 1];
  const v = i & 1 ? byte >> 4 : byte & 0x0f;
  return v === 0 ? null : v;
}

// ---------- Rightmove page model ----------
// Rightmove listing pages set window.__PAGE_MODEL = {data: "<json>", encoding: "on"}.
// The JSON is a flattened array: element 0 is the root, and every value inside an
// object is an index into the array. Older pages used window.PAGE_MODEL = {propertyData}.
// This function is also inlined into the bookmarklet, so it must be self-contained.

export function extractListing(model) {
  let d = model && model.data !== undefined ? model.data : model;
  if (typeof d === "string") d = JSON.parse(d);
  const flat = Array.isArray(d);
  const root = flat ? d[0] : d;
  const g = (o, k) => (o == null ? undefined : flat ? d[o[k]] : o[k]);
  const pd = g(root, "propertyData");
  const loc = g(pd, "location");
  const addr = g(pd, "address");
  const prices = g(pd, "prices");
  const lat = g(loc, "latitude"), lon = g(loc, "longitude");
  if (lat == null || lon == null) return null;
  return {
    id: String(g(pd, "id") ?? ""),
    lat: Number(lat),
    lon: Number(lon),
    pin: g(loc, "pinType") || "",
    addr: g(addr, "displayAddress") || "",
    pc: [g(addr, "outcode"), g(addr, "incode")].filter(Boolean).join(" "),
    price: g(prices, "primaryPrice") || "",
  };
}

/** Source for the bookmarklet: reads the open listing and opens the results page. */
export function bookmarkletHref(pageUrl) {
  const base = pageUrl.split("#")[0];
  const src =
    `(()=>{const extractListing=${extractListing.toString()};` +
    `const m=window.__PAGE_MODEL||window.PAGE_MODEL;let l=null;try{l=m&&extractListing(m)}catch(e){}` +
    `if(!l){alert("House check: open a Rightmove property page first (the page for one house, not the search results).");return}` +
    `const p=new URLSearchParams();for(const k in l)if(l[k]!==""&&l[k]!=null)p.set(k,l[k]);` +
    `window.open(${JSON.stringify(base)}+"#"+p.toString(),"_blank")})()`;
  return "javascript:" + encodeURIComponent(src);
}

/** Read the property passed in the URL hash by the bookmarklet. */
export function propertyFromHash(hash) {
  const p = new URLSearchParams(hash.replace(/^#/, ""));
  const lat = parseFloat(p.get("lat")), lon = parseFloat(p.get("lon"));
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return {
    lat, lon,
    id: (p.get("id") || "").replace(/\D/g, ""),
    pin: p.get("pin") || "",
    addr: p.get("addr") || "",
    pc: p.get("pc") || "",
    price: p.get("price") || "",
  };
}

// ---------- Journeys ----------

/** Next Monday-Friday at the given hour (local time), at least an hour from now. */
export function nextWeekdayAt(hour, now = new Date()) {
  const d = new Date(now);
  d.setHours(hour, 0, 0, 0);
  while (d.getTime() < now.getTime() + 3600e3 || d.getDay() === 0 || d.getDay() === 6) {
    d.setDate(d.getDate() + 1);
  }
  return d;
}

export function formatDuration(seconds) {
  const mins = Math.round(seconds / 60);
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60), m = mins % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

/**
 * Turn a Google API error response into a message that says what to fix.
 * Google puts the real cause in error.details[].reason (an ErrorInfo entry).
 */
export function explainGoogleError(json, status, siteOrigin) {
  const err = (json && json.error) || {};
  const info = (err.details || []).find((d) => d && String(d["@type"] || "").endsWith("ErrorInfo")) || {};
  const reason = info.reason || err.status || `HTTP ${status}`;
  const fixes = {
    API_KEY_HTTP_REFERRER_BLOCKED:
      `This key isn't allowed on this website. In Google Cloud → Credentials → your key → Website restrictions, add ${siteOrigin}/* and save (it can take ~5 minutes to apply).`,
    API_KEY_SERVICE_BLOCKED:
      "This key isn't allowed to use the Routes API. In Google Cloud → Credentials → your key → API restrictions, tick \"Routes API\" and save.",
    SERVICE_DISABLED:
      "The Routes API isn't switched on for this Google Cloud project. Go to APIs & Services → Library → Routes API → Enable.",
    BILLING_DISABLED:
      "Billing isn't set up on this Google Cloud project. Attach a billing account (the free allowance still applies).",
    API_KEY_INVALID: "Google doesn't recognise this key. Check it was pasted in full, with no spaces.",
    RATE_LIMIT_EXCEEDED: "The daily request limit has been reached. It resets tomorrow.",
    RESOURCE_EXHAUSTED: "The daily request limit has been reached. It resets tomorrow.",
  };
  const fix = fixes[reason] || err.message || "Google returned an error.";
  return `${fix} [${reason}]`;
}

export function transitSummary(route) {
  const parts = [];
  for (const leg of route.legs || []) {
    for (const step of leg.steps || []) {
      const line = step.transitDetails && step.transitDetails.transitLine;
      if (!line) continue;
      const type = (line.vehicle && line.vehicle.type) || "";
      const label = line.nameShort || line.name || "";
      const kind = { HEAVY_RAIL: "Train", RAIL: "Train", COMMUTER_TRAIN: "Train", HIGH_SPEED_TRAIN: "Train",
        LONG_DISTANCE_TRAIN: "Train", BUS: "Bus", INTERCITY_BUS: "Coach", SUBWAY: "Tube",
        METRO_RAIL: "Metro", TRAM: "Tram", FERRY: "Ferry" }[type] || "Transit";
      parts.push(kind === "Train" || !label ? kind : `${kind} ${label}`);
    }
  }
  return parts.join(" → ");
}
