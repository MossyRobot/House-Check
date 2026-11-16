import assert from "node:assert/strict";
import { test } from "node:test";

import {
  bookmarkletHref, explainGoogleError, extractListing, formatDuration, nextWeekdayAt, parseRadonGrid,
  propertyFromHash, radonClassAt, transitSummary, wgs84ToBng,
} from "../docs/lib.js";

test("wgs84ToBng matches pyproj to within 10 m", () => {
  // [lat, lon, easting, northing] from pyproj EPSG:4326 -> EPSG:27700
  const ref = [
    [51.75122, -1.26754, 450659.9, 206089.9],
    [50.0657, -5.7132, 134369.6, 25005.1],
    [58.6373, -3.0689, 338044.1, 972651.0],
    [60.8, -0.85, 462689.6, 1213556.2],
    [51.5007, -0.1246, 530269.9, 179640.7],
  ];
  for (const [lat, lon, e, n] of ref) {
    const r = wgs84ToBng(lat, lon);
    assert.ok(Math.abs(r.easting - e) < 10, `easting ${r.easting} vs ${e}`);
    assert.ok(Math.abs(r.northing - n) < 10, `northing ${r.northing} vs ${n}`);
  }
});

function makeGrid(cells) {
  // 700 x 1250 km grid, set given [col, row, class] cells
  const w = 700, h = 1250;
  const buf = new ArrayBuffer(16 + Math.ceil((w * h) / 2));
  const bytes = new Uint8Array(buf);
  bytes.set([82, 68, 78, 49]); // "RDN1"
  const dv = new DataView(buf);
  dv.setUint16(4, w, true); dv.setUint16(6, h, true);
  for (const [c, r, v] of cells) {
    const i = r * w + c;
    bytes[16 + (i >> 1)] |= i & 1 ? v << 4 : v;
  }
  return buf;
}

test("radon grid lookup", () => {
  const grid = parseRadonGrid(makeGrid([[450, 206, 4], [451, 206, 2], [134, 25, 6]]));
  assert.equal(radonClassAt(grid, 51.75122, -1.26754), 4); // BNG 450660, 206090
  assert.equal(radonClassAt(grid, 50.0657, -5.7132), 6);
  assert.equal(radonClassAt(grid, 51.5007, -0.1246), null); // no data
  assert.equal(radonClassAt(grid, 54.6, -5.9), null); // Belfast, outside GB data
});

function flattenedModel() {
  const arr = [
    { propertyData: 1, isAuthenticated: 7 },
    { id: 2, address: 3, location: 10, prices: 15 },
    "12345678",
    { displayAddress: 4, outcode: 5, incode: 6 },
    "1 Example Street", "AB1", "2CD", false, null, "GB",
    { latitude: 11, longitude: 12, pinType: 13, showMap: 14 },
    51.75122, -1.26754, "APPROXIMATE_POINT", true,
    { primaryPrice: 16 }, "£300,000",
  ];
  return { data: JSON.stringify(arr), encoding: "on" };
}

test("extractListing handles the flattened page model", () => {
  assert.deepEqual(extractListing(flattenedModel()), {
    id: "12345678", lat: 51.75122, lon: -1.26754, pin: "APPROXIMATE_POINT",
    addr: "1 Example Street", pc: "AB1 2CD", price: "£300,000",
  });
});

test("extractListing handles the legacy page model", () => {
  const l = extractListing({ propertyData: { id: 5, location: { latitude: 52, longitude: -2 } } });
  assert.equal(l.lat, 52);
  assert.equal(l.id, "5");
});

test("bookmarklet opens the results page with the listing in the hash", () => {
  const href = bookmarkletHref("https://example.github.io/house-check/#old");
  assert.ok(href.startsWith("javascript:"));
  const src = decodeURIComponent(href.slice("javascript:".length));
  let opened = null;
  const fakeWindow = { __PAGE_MODEL: flattenedModel(), open: (u) => { opened = u; } };
  new Function("window", "alert", src)(fakeWindow, (m) => { throw new Error(m); });
  assert.ok(opened.startsWith("https://example.github.io/house-check/#"));
  const prop = propertyFromHash(opened.split("#")[1]);
  assert.equal(prop.pc, "AB1 2CD");
  assert.equal(prop.lat, 51.75122);
  assert.equal(prop.price, "£300,000");
});

test("bookmarklet alerts when not on a listing", () => {
  const src = decodeURIComponent(bookmarkletHref("https://x/").slice(11));
  let msg = null;
  new Function("window", "alert", src)({ open() { throw new Error("should not open"); } }, (m) => { msg = m; });
  assert.match(msg, /Rightmove property page/);
});

test("propertyFromHash rejects junk", () => {
  assert.equal(propertyFromHash("#lat=abc&lon=1"), null);
  assert.equal(propertyFromHash("#lat=51&lon=-1&id=12<script>").id, "12");
});

test("nextWeekdayAt skips weekends and past times", () => {
  const sat = new Date(2026, 10, 14, 12, 0); // Saturday 14 Nov 2026
  const d = nextWeekdayAt(8, sat);
  assert.equal(d.getDay(), 1);
  assert.equal(d.getHours(), 8);
  const monEarly = new Date(2026, 10, 16, 6, 0);
  assert.equal(nextWeekdayAt(8, monEarly).getDate(), 16);
  const monLate = new Date(2026, 10, 16, 7, 30);
  assert.equal(nextWeekdayAt(8, monLate).getDate(), 17);
});

test("formatting helpers", () => {
  assert.equal(formatDuration(1500), "25 min");
  assert.equal(formatDuration(3600), "1 h");
  assert.equal(formatDuration(5400), "1 h 30 min");
  const route = { legs: [{ steps: [
    { transitDetails: { transitLine: { nameShort: "5", vehicle: { type: "BUS" } } } },
    {},
    { transitDetails: { transitLine: { name: "GWR", vehicle: { type: "HEAVY_RAIL" } } } },
  ] }] };
  assert.equal(transitSummary(route), "Bus 5 → Train");
});

test("explainGoogleError gives a fix for known reasons", () => {
  const blocked = { error: { code: 403, status: "PERMISSION_DENIED", message: "Requests from referer are blocked.",
    details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "API_KEY_HTTP_REFERRER_BLOCKED" }] } };
  const msg = explainGoogleError(blocked, 403, "https://mossyrobot.github.io");
  assert.match(msg, /https:\/\/mossyrobot\.github\.io\/\*/);
  assert.match(msg, /\[API_KEY_HTTP_REFERRER_BLOCKED\]$/);
  const unknown = explainGoogleError({ error: { status: "PERMISSION_DENIED", message: "Something odd" } }, 403, "x");
  assert.equal(unknown, "Something odd [PERMISSION_DENIED]");
  assert.equal(explainGoogleError({}, 500, "x"), "Google returned an error. [HTTP 500]");
});
