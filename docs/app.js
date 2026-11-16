import {
  RADON_BANDS, bookmarkletHref, formatDuration, nextWeekdayAt, parseRadonGrid,
  propertyFromHash, radonClassAt, transitSummary,
} from "./lib.js";

const $ = (sel) => document.querySelector(sel);
const el = (tag, props = {}, ...children) => {
  const n = Object.assign(document.createElement(tag), props);
  for (const c of children) if (c != null) n.append(c);
  return n;
};

// ---------- storage (this browser only) ----------
const store = {
  get(key, fallback) {
    try { const v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v); }
    catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode etc. */ }
  },
};

const apiKey = () => store.get("gmapsKey", "") || (window.HOUSECHECK_CONFIG || {}).googleMapsApiKey || "";
const getPlaces = () => store.get("places", []);
const setPlaces = (p) => { store.set("places", p); renderPlaces(); renderJourneys(); };

// ---------- radon ----------
let radonGrid = null;
const radonReady = fetch("radon-gb.bin")
  .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.arrayBuffer(); })
  .then((buf) => { radonGrid = parseRadonGrid(buf); })
  .catch((e) => { console.warn("Radon data not loaded:", e); });

function radonCard(prop) {
  const card = el("section", { className: "card" }, el("h2", { textContent: "Radon" }));
  if (!radonGrid) {
    card.append(el("p", { className: "muted", textContent: "Radon data isn't available on this site yet." }));
    return card;
  }
  const cls = radonClassAt(radonGrid, prop.lat, prop.lon);
  if (cls == null) {
    card.append(el("p", { textContent: "Not covered: the atlas is for Great Britain only (not Northern Ireland or offshore)." }));
    return card;
  }
  const level = cls === 1 ? "low" : cls <= 3 ? "affected" : "high";
  card.append(
    el("div", { className: `radon radon-${level}` },
      el("span", { className: "radon-class", textContent: `Class ${cls}` }),
      el("span", { textContent: `${RADON_BANDS[cls]} of homes in this 1 km square are estimated to be above the radon Action Level.` })),
    el("p", {
      className: "muted",
      textContent: cls === 1
        ? "Lowest band - not a radon Affected Area."
        : "This is a radon Affected Area (1% or more of homes above the Action Level). It's a screening result for the worst spot in the square, not this house - a test or the UKHSA address report gives a better answer.",
    }),
    el("p", {}, el("a", { href: "https://www.ukradon.org/services/address_search", target: "_blank", rel: "noopener",
      textContent: "UKHSA address-level radon report (about £4) →" })),
  );
  return card;
}

// ---------- journeys ----------
const CACHE_DAYS = 30;

async function computeRoute(origin, destination, mode) {
  const key = apiKey();
  if (!key) throw new Error("No Google Maps API key set (see Settings below).");
  const cacheKey = `route|${origin.lat.toFixed(5)},${origin.lon.toFixed(5)}|${destination}|${mode}`;
  const cached = store.get(cacheKey, null);
  if (cached && Date.now() - cached.t < CACHE_DAYS * 864e5) return cached.v;

  const body = {
    origin: { location: { latLng: { latitude: origin.lat, longitude: origin.lon } } },
    destination: { address: destination },
    travelMode: mode,
    languageCode: "en-GB",
    regionCode: "GB",
  };
  let fields = "routes.duration,routes.distanceMeters";
  if (mode === "TRANSIT") {
    body.departureTime = nextWeekdayAt(8).toISOString();
    fields += ",routes.legs.steps.transitDetails.transitLine";
  }
  const r = await fetch("https://routes.googleapis.com/directions/v2:computeRoutes", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Goog-Api-Key": key, "X-Goog-FieldMask": fields },
    body: JSON.stringify(body),
  });
  const json = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((json.error && json.error.message) || `Google returned HTTP ${r.status}`);
  const route = (json.routes || [])[0];
  const v = route
    ? { seconds: parseInt(route.duration, 10), meters: route.distanceMeters || 0,
        summary: mode === "TRANSIT" ? transitSummary(route) : "" }
    : null;
  store.set(cacheKey, { t: Date.now(), v });
  return v;
}

function routeCell(promise, mode) {
  const td = el("td", { className: "muted", textContent: "…" });
  promise.then((v) => {
    td.className = "";
    td.textContent = "";
    if (!v) { td.className = "muted"; td.textContent = "No route"; return; }
    td.append(el("strong", { textContent: formatDuration(v.seconds) }));
    if (mode === "DRIVE") td.append(el("span", { className: "muted", textContent: ` · ${(v.meters / 1609.344).toFixed(1)} mi` }));
    if (v.summary) td.append(el("div", { className: "small muted", textContent: v.summary }));
  }).catch((e) => {
    td.className = "error";
    td.textContent = e.message;
  });
  return td;
}

let currentProperty = null;

function renderJourneys() {
  const box = $("#journeys");
  box.replaceChildren();
  if (!currentProperty) return;
  const places = getPlaces();
  const card = el("section", { className: "card" }, el("h2", { textContent: "Journeys" }));
  if (!places.length) {
    card.append(el("p", { className: "muted", textContent: "Add some saved places below (work, family, friends) to see journey times." }));
    box.append(card);
    return;
  }
  const when = nextWeekdayAt(8);
  card.append(el("p", { className: "small muted",
    textContent: `From this property. Public transport leaves ${when.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "short" })} at 08:00; driving ignores traffic.` }));
  const table = el("table", {},
    el("thead", {}, el("tr", {}, el("th", { textContent: "To" }), el("th", { textContent: "Drive" }), el("th", { textContent: "Public transport" }))));
  const tbody = el("tbody");
  for (const p of places) {
    tbody.append(el("tr", {},
      el("td", {}, el("strong", { textContent: p.name }), el("div", { className: "small muted", textContent: p.address })),
      routeCell(computeRoute(currentProperty, p.address, "DRIVE"), "DRIVE"),
      routeCell(computeRoute(currentProperty, p.address, "TRANSIT"), "TRANSIT")));
  }
  table.append(tbody);
  card.append(el("div", { className: "table-wrap" }, table));
  box.append(card);
}

// ---------- property ----------
async function renderProperty() {
  currentProperty = propertyFromHash(location.hash);
  const box = $("#property");
  box.replaceChildren();
  $("#search-title").textContent = currentProperty ? "Check another property" : "Check a property";
  if (!currentProperty) { renderJourneys(); return; }
  const p = currentProperty;

  const head = el("section", { className: "card" },
    el("h2", { textContent: p.addr || p.pc || "Selected location" }));
  const facts = el("p", { className: "muted" });
  facts.append([p.pc, p.price].filter(Boolean).join(" · "));
  head.append(facts);
  if (p.pin.toUpperCase().includes("APPROX")) {
    head.append(el("p", { className: "warn",
      textContent: "The agent has only given an approximate map pin, so the radon square and journeys may be for a nearby spot." }));
  }
  if (p.id) {
    head.append(el("p", {}, el("a", { href: `https://www.rightmove.co.uk/properties/${p.id}`, target: "_blank", rel: "noopener",
      textContent: "View on Rightmove →" })));
  }
  box.append(head);
  await radonReady;
  if (currentProperty !== p) return;
  box.append(radonCard(p));
  renderJourneys();
}

// ---------- postcode search ----------
$("#postcode-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const input = $("#postcode");
  const msg = $("#postcode-msg");
  const pc = input.value.trim();
  if (!pc) return;
  msg.textContent = "Looking up…";
  try {
    const r = await fetch(`https://api.postcodes.io/postcodes/${encodeURIComponent(pc)}`);
    const json = await r.json();
    if (!r.ok || !json.result) throw new Error(json.error || "Postcode not found");
    const { latitude, longitude, postcode } = json.result;
    msg.textContent = "";
    location.hash = new URLSearchParams({ lat: latitude, lon: longitude, pc: postcode }).toString();
  } catch (e) {
    msg.textContent = e.message;
  }
});

// ---------- saved places ----------
function renderPlaces() {
  const list = $("#places-list");
  list.replaceChildren();
  const places = getPlaces();
  if (!places.length) list.append(el("li", { className: "muted", textContent: "No saved places yet." }));
  places.forEach((p, i) => {
    list.append(el("li", {},
      el("span", {}, el("strong", { textContent: p.name }), " ", el("span", { className: "muted", textContent: p.address })),
      el("button", { type: "button", className: "link", textContent: "Remove",
        onclick: () => { if (confirm(`Remove ${p.name}?`)) setPlaces(getPlaces().filter((_, j) => j !== i)); } })));
  });
}

$("#place-form").addEventListener("submit", (ev) => {
  ev.preventDefault();
  const name = $("#place-name").value.trim();
  const address = $("#place-address").value.trim();
  if (!name || !address) return;
  setPlaces([...getPlaces(), { name, address }]);
  ev.target.reset();
});

$("#export-places").addEventListener("click", () => {
  const blob = new Blob([JSON.stringify(getPlaces(), null, 2)], { type: "application/json" });
  const a = el("a", { href: URL.createObjectURL(blob), download: "house-check-places.json" });
  a.click();
  URL.revokeObjectURL(a.href);
});

$("#import-places").addEventListener("change", async (ev) => {
  const file = ev.target.files[0];
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (!Array.isArray(data)) throw new Error();
    const clean = data.filter((p) => p && typeof p.name === "string" && typeof p.address === "string")
      .map(({ name, address }) => ({ name, address }));
    setPlaces([...getPlaces(), ...clean]);
  } catch {
    alert("That file doesn't look like an exported places list.");
  }
  ev.target.value = "";
});

// ---------- settings & setup ----------
$("#key-input").value = store.get("gmapsKey", "");
$("#key-status").textContent = apiKey()
  ? (store.get("gmapsKey", "") ? "Using the key saved in this browser." : "Using the site's built-in key.")
  : "No key set - journeys won't work until one is added.";
$("#key-form").addEventListener("submit", (ev) => {
  ev.preventDefault();
  store.set("gmapsKey", $("#key-input").value.trim());
  location.reload();
});

$("#bookmarklet").href = bookmarkletHref(location.href);
$("#bookmarklet").addEventListener("click", (ev) => {
  ev.preventDefault();
  alert("Drag this button onto your bookmarks bar, then click it while looking at a Rightmove property.");
});

window.addEventListener("hashchange", renderProperty);
renderPlaces();
renderProperty();
