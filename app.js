(function () {
  "use strict";

  const SHOW_SUPERSEDED_KEY = "trip-map-show-superseded";

  /** Trips available in the switcher. First one is the default. */
  const TRIPS = [];
  if (window.SG_TRIP_2026) {
    TRIPS.push({
      key: "sg2026",
      label: "Singapore · 12 Nov – 2 Dec 2026",
      data: window.SG_TRIP_2026,
      storageKey: "tm-pub-edits-v1",
    });
  }
  if (window.ITINERARY) {
    TRIPS.push({
      key: "fintech2026",
      label: "Earlier plan · Fintech + NZ (old bookings)",
      data: window.ITINERARY,
      storageKey: "trip-map-edits-v1",
    });
  }
  const tripParam = new URLSearchParams(window.location.search).get("trip");
  const currentTrip = TRIPS.find((t) => t.key === tripParam) || TRIPS[0];
  if (!currentTrip) {
    console.error("ITINERARY data missing");
    return;
  }
  const STORAGE_KEY = currentTrip.storageKey;
  const base = currentTrip.data;

  /** Deep clone base so we never mutate the source module. */
  function clone(obj) {
    return JSON.parse(JSON.stringify(obj));
  }

  function loadEdits() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return { stops: {}, segments: {} };
      const parsed = JSON.parse(raw);
      return {
        stops: parsed.stops || {},
        segments: parsed.segments || {},
      };
    } catch (_) {
      return { stops: {}, segments: {} };
    }
  }

  function saveEdits(edits) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(edits));
  }

  function mergeData(edits) {
    const data = clone(base);
    data.stops = data.stops.map((s) => {
      const e = edits.stops[s.id];
      return e ? Object.assign({}, s, e) : s;
    });
    data.segments = data.segments.map((seg) => {
      const e = edits.segments[seg.id];
      if (!e) return seg;
      const merged = Object.assign({}, seg, e);
      if (e.departure && seg.departure) {
        merged.departure = Object.assign({}, seg.departure, e.departure);
      }
      if (e.arrival && seg.arrival) {
        merged.arrival = Object.assign({}, seg.arrival, e.arrival);
      }
      return merged;
    });
    return data;
  }

  let edits = loadEdits();
  let data = mergeData(edits);
  let stopById = Object.fromEntries(data.stops.map((s) => [s.id, s]));

  let map = null;
  let activeStopId = null;
  let showSuperseded =
    localStorage.getItem(SHOW_SUPERSEDED_KEY) === "1" || false;
  const markersByStop = {};
  let routeLayers = [];
  let dirty = false;

  const els = {
    title: document.getElementById("trip-title"),
    subtitle: document.getElementById("trip-subtitle"),
    panel: document.getElementById("detail-panel"),
    body: document.getElementById("detail-body"),
    city: document.getElementById("detail-city"),
    country: document.getElementById("detail-country"),
    dates: document.getElementById("detail-dates"),
    stay: document.getElementById("detail-stay"),
    close: document.getElementById("detail-close"),
    saveStatus: document.getElementById("save-status"),
    btnSave: document.getElementById("btn-save"),
    btnExport: document.getElementById("btn-export"),
    btnReset: document.getElementById("btn-reset"),
    showSuperseded: document.getElementById("show-superseded"),
    hint: document.getElementById("map-hint"),
    footer: document.getElementById("detail-footer"),
    tripSelect: document.getElementById("trip-select"),
    btnStops: document.getElementById("btn-stops"),
    btnThink: document.getElementById("btn-think"),
    supersededToggle: document.getElementById("superseded-toggle"),
    legend: document.getElementById("legend"),
  };

  function refreshMerged() {
    data = mergeData(edits);
    stopById = Object.fromEntries(data.stops.map((s) => [s.id, s]));
  }

  function setDirty(isDirty) {
    dirty = isDirty;
    if (!els.saveStatus) return;
    if (isDirty) {
      els.saveStatus.textContent = "Unsaved changes";
      els.saveStatus.className = "save-status dirty";
    } else {
      els.saveStatus.textContent = "Saved locally";
      els.saveStatus.className = "save-status saved";
    }
  }

  function persist() {
    saveEdits(edits);
    refreshMerged();
    setDirty(false);
  }

  function escapeHtml(str) {
    return String(str == null ? "" : str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function stayDuration(stop) {
    if (stop.stayNote) return stop.stayNote;
    if (stop.note) return stop.note;
    return "";
  }

  function segmentsForStop(stopId) {
    return data.segments.filter(
      (s) =>
        s.stopId === stopId ||
        s.fromStopId === stopId ||
        s.toStopId === stopId
    );
  }

  function inboundFlights(stopId) {
    return data.segments.filter(
      (s) => s.type === "flight" && s.toStopId === stopId
    );
  }

  function outboundFlights(stopId) {
    return data.segments.filter(
      (s) => s.type === "flight" && s.fromStopId === stopId
    );
  }

  function eventsAt(stopId) {
    return data.segments.filter(
      (s) => s.type === "event" && s.stopId === stopId
    );
  }

  function layoversAt(stopId) {
    return data.segments.filter(
      (s) => s.type === "layover" && s.stopId === stopId
    );
  }

  function sortActiveFirst(list) {
    return list.slice().sort((a, b) => {
      const aSuper = a.status === "superseded" ? 1 : 0;
      const bSuper = b.status === "superseded" ? 1 : 0;
      return aSuper - bSuper;
    });
  }

  function filterVisible(list) {
    if (showSuperseded) return list;
    return list.filter((s) => s.status !== "superseded");
  }

  function statusBadge(status) {
    if (status === "superseded") {
      return '<span class="badge badge-status-superseded">Superseded</span>';
    }
    if (status === "booked") {
      return '<span class="badge badge-status-booked">Booked</span>';
    }
    if (status === "option") {
      return '<span class="badge badge-status-option">Option · not booked</span>';
    }
    if (status === "registered") {
      return '<span class="badge badge-status-booked">Registered</span>';
    }
    return '<span class="badge badge-status-active">Active</span>';
  }

  /** Turn bare URLs in plain text into links (text is escaped first). */
  function linkify(text) {
    return escapeHtml(text).replace(
      /(https?:\/\/[^\s<)]+[^\s<).,])/g,
      '<a href="$1" target="_blank" rel="noopener">$1</a>'
    );
  }

  function formatPrice(opt) {
    const p = opt.price;
    if (p === "booked") return '<span class="price booked">Booked</span>';
    if (p === null || p === undefined || p === "") {
      return '<span class="price unknown">Price unverified</span>';
    }
    if (typeof p === "number") {
      const cur = opt.currency || "";
      let txt = `${cur} ${p.toLocaleString("en-NZ")}`;
      if (opt.price_nzd_approx && cur !== "NZD") {
        txt += ` (~NZ$${opt.price_nzd_approx})`;
      }
      return `<span class="price">${escapeHtml(txt)}</span>`;
    }
    return `<span class="price">${escapeHtml(String(p))}</span>`;
  }

  function optionCard(opt) {
    const link = opt.link
      ? `<a class="opt-link" href="${escapeHtml(opt.link)}" target="_blank" rel="noopener">Open link ↗</a>`
      : '<span class="opt-link none">No link</span>';
    return `
      <article class="card option">
        <div class="card-top">
          <span class="badge badge-type">${escapeHtml(opt.type || "option")}</span>
          ${statusBadge("option")}
        </div>
        <div class="card-title">${escapeHtml(opt.name)}</div>
        <div class="opt-row">${formatPrice(opt)} ${link}</div>
        ${opt.notes ? `<div class="card-meta">${linkify(opt.notes)}</div>` : ""}
        ${opt.checked ? `<div class="card-checked">Checked ${escapeHtml(opt.checked)}</div>` : ""}
      </article>`;
  }

  function bulletList(items) {
    if (!items || !items.length) return "";
    return `<ul class="note-list">${items
      .map((t) => `<li>${linkify(t)}</li>`)
      .join("")}</ul>`;
  }

  function comparisonHtml(cmp) {
    if (!cmp) return "";
    const [head, ...rows] = cmp.rows;
    return `
      <div class="compare">
        <p class="compare-title">${escapeHtml(cmp.title)}</p>
        <p class="note-block">${escapeHtml(cmp.bottomLine)}</p>
        <div class="table-wrap"><table>
          <thead><tr>${head.map((h) => `<th>${escapeHtml(h)}</th>`).join("")}</tr></thead>
          <tbody>${rows
            .map(
              (r) =>
                `<tr class="${r[0] === "Total" ? "total" : ""}">${r
                  .map((c, i) => (i === 0 ? `<th>${escapeHtml(c)}</th>` : `<td>${escapeHtml(c)}</td>`))
                  .join("")}</tr>`
            )
            .join("")}</tbody>
        </table></div>
        ${cmp.todo && cmp.todo.length ? `<p class="section-sub">To do (Matt / Papa)</p>${bulletList(cmp.todo)}` : ""}
        <p class="card-checked">Source: ${escapeHtml(cmp.source)}</p>
      </div>`;
  }

  function flightCard(seg, direction) {
    const from = stopById[seg.fromStopId];
    const to = stopById[seg.toStopId];
    const isSuper = seg.status === "superseded";
    const depLabel = (seg.departure && seg.departure.localLabel) || "";
    const arrLabel = (seg.arrival && seg.arrival.localLabel) || "";
    const dirBadge =
      direction === "in"
        ? '<span class="badge badge-inbound">Inbound</span>'
        : '<span class="badge badge-outbound">Outbound</span>';

    return `
      <article class="card ${isSuper ? "superseded" : ""} ${seg.status === "option" ? "option" : ""} ${seg.status === "booked" ? "booked" : ""}" data-seg="${escapeHtml(seg.id)}">
        <div class="card-top">
          <span class="badge badge-flight">Flight</span>
          ${dirBadge}
          ${statusBadge(seg.status || "active")}
          <span class="card-title">${escapeHtml(seg.airline)} ${escapeHtml(seg.flightNumber || "")}</span>
        </div>
        <div class="card-route">
          <strong>${escapeHtml(from ? from.city : seg.departure.city)}</strong>
          (${escapeHtml(seg.departure.airport)})
          →
          <strong>${escapeHtml(to ? to.city : seg.arrival.city)}</strong>
          (${escapeHtml(seg.arrival.airport)})
          ${seg.duration && seg.duration !== "—" ? " · " + escapeHtml(seg.duration) : ""}
        </div>
        ${seg.warning ? `<div class="card-warn">${escapeHtml(seg.warning)}</div>` : ""}
        ${seg.priceLabel ? `<div class="opt-row"><span class="price">${escapeHtml(seg.priceLabel)}</span></div>` : ""}
        ${seg.detail ? `<div class="card-meta">${linkify(seg.detail)}</div>` : ""}
        ${seg.link ? `<div class="opt-row"><a class="opt-link" href="${escapeHtml(seg.link)}" target="_blank" rel="noopener">Website ↗</a></div>` : ""}
        <div class="field-grid">
          <div class="field">
            <label>Departure time</label>
            <input class="mono edit-dep" data-seg="${escapeHtml(seg.id)}" type="text" value="${escapeHtml(depLabel)}" ${isSuper ? "readonly" : ""} />
          </div>
          <div class="field">
            <label>Arrival time</label>
            <input class="mono edit-arr" data-seg="${escapeHtml(seg.id)}" type="text" value="${escapeHtml(arrLabel)}" ${isSuper ? "readonly" : ""} />
          </div>
          <div class="field">
            <label>Notes (this device only)</label>
            <textarea class="edit-notes" data-seg="${escapeHtml(seg.id)}" ${isSuper ? "readonly" : ""}>${escapeHtml(seg.detail || "")}</textarea>
          </div>
        </div>
      </article>`;
  }

  function eventCard(seg) {
    return `
      <article class="card" data-seg="${escapeHtml(seg.id)}">
        <div class="card-top">
          <span class="badge badge-event">Event</span>
          ${statusBadge(seg.status || "active")}
          <span class="card-title">${escapeHtml(seg.title)}</span>
        </div>
        ${seg.detail ? `<div class="card-meta">${escapeHtml(seg.detail)}</div>` : ""}
        ${seg.link ? `<div class="opt-row"><a class="opt-link" href="${escapeHtml(seg.link)}" target="_blank" rel="noopener noreferrer">Open</a></div>` : ""}
        <div class="field-grid">
          <div class="field">
            <label>Venue</label>
            <input class="edit-confirmation" data-seg="${escapeHtml(seg.id)}" type="text" value="${escapeHtml(seg.confirmation || "")}" />
          </div>
          <div class="field">
            <label>Notes</label>
            <textarea class="edit-event-notes" data-seg="${escapeHtml(seg.id)}">${escapeHtml(seg.detail || "")}</textarea>
          </div>
        </div>
      </article>`;
  }

  function layoverCard(seg) {
    return `
      <article class="card">
        <div class="card-top">
          <span class="badge badge-layover">Layover</span>
          ${statusBadge(seg.status || "active")}
          <span class="card-title">${escapeHtml(seg.title)}</span>
        </div>
        <div class="card-meta">${escapeHtml(seg.detail || "")} · ${escapeHtml(seg.duration || "")}</div>
        <div class="card-meta">${escapeHtml(seg.from || "")} → ${escapeHtml(seg.to || "")}</div>
      </article>`;
  }

  function renderList(items, emptyMsg, renderer) {
    const visible = filterVisible(sortActiveFirst(items));
    if (!visible.length) {
      return `<p class="empty">${escapeHtml(emptyMsg)}</p>`;
    }
    return visible.map(renderer).join("");
  }

  function openStop(stopId) {
    const stop = stopById[stopId];
    if (!stop) return;

    activeStopId = stopId;
    els.panel.hidden = false;
    if (els.footer) els.footer.hidden = false;
    els.hint.classList.add("hidden");

    els.city.textContent = stop.city;
    els.country.textContent = `${stop.country} · ${stop.iata}`;
    els.dates.textContent = stop.dates || "";
    els.stay.textContent = stayDuration(stop)
      ? `Stay / note: ${stayDuration(stop)} · ${stop.timezone || ""}`
      : stop.timezone || "";

    const inbound = inboundFlights(stopId);
    const outbound = outboundFlights(stopId);
    const events = eventsAt(stopId);
    const layovers = layoversAt(stopId);

    const options = stop.options || [];
    const cmp = stop.comparison && data.comparison ? data.comparison : null;

    const notesHtml =
      stop.notesList && stop.notesList.length
        ? `<div class="section"><h3 class="section-title">Notes</h3>${bulletList(stop.notesList)}</div>`
        : "";

    els.body.innerHTML = `
      ${stop.title ? `<p class="stop-title">${escapeHtml(stop.title)}</p>` : ""}

      ${events.length ? `<div class="section"><h3 class="section-title">Events</h3>${renderList(events, "", eventCard)}</div>` : ""}

      <div class="section">
        <h3 class="section-title">Inbound</h3>
        ${renderList(inbound, "No inbound flights", (s) => flightCard(s, "in"))}
      </div>

      <div class="section">
        <h3 class="section-title">Outbound</h3>
        ${renderList(outbound, "No outbound flights", (s) => flightCard(s, "out"))}
      </div>

      ${
        layovers.length
          ? `<div class="section"><h3 class="section-title">Layovers</h3>${renderList(layovers, "", layoverCard)}</div>`
          : ""
      }

      ${cmp ? `<div class="section"><h3 class="section-title">Move vs stay</h3>${comparisonHtml(cmp)}</div>` : ""}

      ${
        options.length
          ? `<div class="section"><h3 class="section-title">Options · not booked (${options.length})</h3>${options.map(optionCard).join("")}</div>`
          : ""
      }

      ${notesHtml}

      <div class="section">
        <h3 class="section-title">My notes (saved on this device)</h3>
        <div class="field-grid">
          <div class="field">
            <label>Dates</label>
            <input id="edit-stop-dates" type="text" value="${escapeHtml(stop.dates || "")}" />
          </div>
          <div class="field">
            <label>Stay duration / note</label>
            <input id="edit-stop-note" type="text" value="${escapeHtml(stop.note || "")}" />
          </div>
          <div class="field">
            <label>Hotel / lodging</label>
            <input id="edit-stop-hotel" type="text" value="${escapeHtml(stop.hotel || "")}" placeholder="Optional" />
          </div>
        </div>
      </div>
    `;
    els.body.scrollTop = 0;

    wireEditors();
    highlightMarker(stopId);
    map.flyTo([stop.lat, stop.lng], Math.max(map.getZoom(), 5), { duration: 0.55 });
    setDirty(false);
  }

  function openInfo(kicker, title, sub, html) {
    activeStopId = null;
    els.panel.hidden = false;
    if (els.footer) els.footer.hidden = true;
    els.hint.classList.add("hidden");
    els.country.textContent = kicker;
    els.city.textContent = title;
    els.dates.textContent = sub || "";
    els.stay.textContent = "";
    els.body.innerHTML = html;
    els.body.scrollTop = 0;
    highlightMarker(null);
    els.body.querySelectorAll("[data-open-stop]").forEach((btn) => {
      btn.addEventListener("click", () => openStop(btn.dataset.openStop));
    });
  }

  function openStopsList() {
    const items = data.stops
      .map((s, i) => {
        const nOpts = (s.options || []).length;
        const booked = data.segments.filter(
          (g) => g.type === "flight" && g.status === "booked" && g.fromStopId === s.id
        );
        return `
          <button type="button" class="stop-row" data-open-stop="${escapeHtml(s.id)}">
            <span class="trip-marker ${markerClassFor(s).replace("trip-marker", "")}">${i + 1}</span>
            <span class="stop-row-text">
              <strong>${escapeHtml(s.city)} <span class="muted">${escapeHtml(s.iata)}</span></strong>
              <span>${escapeHtml(s.dates || "")}</span>
              <span class="muted">${escapeHtml(s.note || "")}${
                booked.length
                  ? ` · next: ${booked.map((b) => escapeHtml(b.flightNumber)).join(", ")} (booked)`
                  : ""
              }${nOpts ? ` · ${nOpts} option${nOpts > 1 ? "s" : ""}` : ""}</span>
            </span>
          </button>`;
      })
      .join("");
    openInfo(
      "Itinerary",
      "Stops in order",
      data.researchNote || "",
      `<div class="stop-list">${items}</div>`
    );
  }

  function openThink() {
    const t = data.toThink || { items: [], unverified: [] };
    openInfo(
      "Before you go",
      "To think about",
      `${t.items.length + (t.unverified || []).length} notes · checked ${data.checked || ""}`,
      `
        <div class="section"><h3 class="section-title">To think about</h3>${bulletList(t.items)}</div>
        ${data.comparison ? `<div class="section"><h3 class="section-title">Move vs stay (AKL)</h3>${comparisonHtml(data.comparison)}</div>` : ""}
        ${
          t.unverified && t.unverified.length
            ? `<div class="section"><h3 class="section-title">Unverified / to confirm</h3>${bulletList(t.unverified)}</div>`
            : ""
        }
        ${
          data.fx
            ? `<p class="card-checked">FX: 1 NZD = ${escapeHtml(data.fx.NZD_to_FJD)} FJD = ${escapeHtml(data.fx.NZD_to_SGD)} SGD (${escapeHtml(data.fx.source)})</p>`
            : ""
        }
      `
    );
  }

  function closePanel() {
    activeStopId = null;
    els.panel.hidden = true;
    els.hint.classList.remove("hidden");
    highlightMarker(null);
  }

  function highlightMarker(stopId) {
    Object.entries(markersByStop).forEach(([id, marker]) => {
      const el = marker.getElement();
      if (!el) return;
      const icon = el.querySelector(".trip-marker");
      if (icon) icon.classList.toggle("active", id === stopId);
    });
  }

  function ensureSegEdit(segId) {
    if (!edits.segments[segId]) edits.segments[segId] = {};
    return edits.segments[segId];
  }

  function ensureStopEdit(stopId) {
    if (!edits.stops[stopId]) edits.stops[stopId] = {};
    return edits.stops[stopId];
  }

  function wireEditors() {
    const stopId = activeStopId;
    if (!stopId) return;

    const dates = document.getElementById("edit-stop-dates");
    const note = document.getElementById("edit-stop-note");
    const hotel = document.getElementById("edit-stop-hotel");

    function onStopChange() {
      const e = ensureStopEdit(stopId);
      e.dates = dates.value;
      e.note = note.value;
      e.hotel = hotel.value;
      setDirty(true);
      els.dates.textContent = dates.value;
      els.stay.textContent = note.value
        ? `Stay / note: ${note.value}`
        : "";
    }

    [dates, note, hotel].forEach((el) => {
      if (el) el.addEventListener("input", onStopChange);
    });

    els.body.querySelectorAll(".edit-dep").forEach((input) => {
      input.addEventListener("input", () => {
        const e = ensureSegEdit(input.dataset.seg);
        e.departure = e.departure || {};
        e.departure.localLabel = input.value;
        setDirty(true);
      });
    });

    els.body.querySelectorAll(".edit-arr").forEach((input) => {
      input.addEventListener("input", () => {
        const e = ensureSegEdit(input.dataset.seg);
        e.arrival = e.arrival || {};
        e.arrival.localLabel = input.value;
        setDirty(true);
      });
    });

    els.body.querySelectorAll(".edit-ref").forEach((input) => {
      input.addEventListener("input", () => {
        const e = ensureSegEdit(input.dataset.seg);
        e.bookingRef = input.value;
        setDirty(true);
      });
    });

    els.body.querySelectorAll(".edit-notes").forEach((input) => {
      input.addEventListener("input", () => {
        const e = ensureSegEdit(input.dataset.seg);
        e.detail = input.value;
        setDirty(true);
      });
    });

    els.body.querySelectorAll(".edit-confirmation").forEach((input) => {
      input.addEventListener("input", () => {
        const e = ensureSegEdit(input.dataset.seg);
        e.confirmation = input.value;
        setDirty(true);
      });
    });

    els.body.querySelectorAll(".edit-event-notes").forEach((input) => {
      input.addEventListener("input", () => {
        const e = ensureSegEdit(input.dataset.seg);
        e.detail = input.value;
        setDirty(true);
      });
    });
  }

  function clearRouteLayers() {
    routeLayers.forEach((layer) => map.removeLayer(layer));
    routeLayers = [];
  }

  /** Slightly curved line so out/return legs on the same pair don't overlap. */
  function arc(a, b, bend) {
    const pts = [];
    const dx = b[1] - a[1];
    const dy = b[0] - a[0];
    const mid = [(a[0] + b[0]) / 2 - dx * bend, (a[1] + b[1]) / 2 + dy * bend];
    for (let t = 0; t <= 1.0001; t += 0.05) {
      const u = 1 - t;
      pts.push([
        u * u * a[0] + 2 * u * t * mid[0] + t * t * b[0],
        u * u * a[1] + 2 * u * t * mid[1] + t * t * b[1],
      ]);
    }
    return pts;
  }

  function drawSegmentRoutes() {
    data.segments
      .filter((s) => s.type === "flight" && s.status !== "superseded")
      .forEach((s) => {
        const a = stopById[s.fromStopId];
        const b = stopById[s.toStopId];
        if (!a || !b) return;
        const isOption = s.status === "option";
        const who = s.who || "us";
        const bend = s.bend != null ? s.bend : isOption ? 0.32 : 0.12;
        const line = L.polyline(arc([a.lat, a.lng], [b.lat, b.lng], bend), {
          color: who === "sam" ? "#5b8def" : isOption ? "#ffd166" : "#3d9cf0",
          weight: isOption ? 2.5 : 3.5,
          opacity: isOption ? 0.95 : 0.9,
          dashArray: isOption ? "7 7" : null,
          lineJoin: "round",
        }).addTo(map);
        line.bindTooltip(
          `${who === "sam" ? "Sam · " : ""}${s.airline} ${s.flightNumber} · ${isOption ? "not booked" : "booked"}`,
          { sticky: true }
        );
        routeLayers.push(line);
      });
  }

  function drawRoutes() {
    clearRouteLayers();

    if (data.drawSegments) {
      drawSegmentRoutes();
      return;
    }

    const pathIds = data.path || data.stops.map((s) => s.id);
    const latlngs = pathIds.map((id) => {
      const s = stopById[id];
      return [s.lat, s.lng];
    });

    const main = L.polyline(latlngs, {
      color: "#3d9cf0",
      weight: 3,
      opacity: 0.85,
      dashArray: "8 6",
      lineJoin: "round",
    }).addTo(map);
    routeLayers.push(main);

    if (showSuperseded) {
      data.segments
        .filter((s) => s.type === "flight" && s.status === "superseded")
        .forEach((s) => {
          const layer = L.polyline(
            [
              [stopById[s.fromStopId].lat, stopById[s.fromStopId].lng],
              [stopById[s.toStopId].lat, stopById[s.toStopId].lng],
            ],
            {
              color: "#6b7785",
              weight: 2,
              opacity: 0.5,
              dashArray: "2 8",
            }
          ).addTo(map);
          routeLayers.push(layer);
        });
    }
  }

  function markerClassFor(stop) {
    const involved = segmentsForStop(stop.id);
    const hasEvent = involved.some(
      (s) => s.type === "event" && s.status !== "superseded"
    );
    const onlySuperseded =
      involved.length > 0 &&
      involved.every(
        (s) => s.status === "superseded" || s.type === "layover"
      );
    let cls = "trip-marker";
    if (hasEvent) cls += " marker-event";
    else if (onlySuperseded) cls += " marker-superseded";
    return cls;
  }

  function initMap() {
    map = L.map("map", {
      zoomControl: true,
      attributionControl: true,
    });

    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      maxZoom: 19,
    }).addTo(map);

    drawRoutes();

    const seenCoords = {};
    let number = 0;
    data.stops.forEach((stop) => {
      if (stop.side) {
        const dot = L.circleMarker([stop.lat, stop.lng], {
          radius: 5,
          color: "#5b8def",
          weight: 2,
          fillColor: "#0f1419",
          fillOpacity: 1,
        }).addTo(map);
        dot.bindTooltip(stop.city, { permanent: true, direction: "right", offset: [8, 0] });
        return;
      }
      number += 1;
      const k = `${stop.lat},${stop.lng}`;
      const dup = seenCoords[k] || 0;
      seenCoords[k] = dup + 1;
      const icon = L.divIcon({
        className: "",
        html: `<div class="${markerClassFor(stop)}" title="${escapeHtml(stop.city)}">${number}</div>`,
        iconSize: [28, 28],
        iconAnchor: [14 - dup * 30, 14],
      });

      const marker = L.marker([stop.lat, stop.lng], { icon }).addTo(map);
      marker.on("click", (e) => {
        L.DomEvent.stopPropagation(e);
        openStop(stop.id);
      });
      markersByStop[stop.id] = marker;
    });

    map.fitBounds(L.latLngBounds(data.stops.map((s) => [s.lat, s.lng])).pad(0.18));

    map.on("click", () => {
      closePanel();
    });

    setupGlider();
  }

  function bookedHops(who) {
    return data.segments.filter(
      (s) => s.type === "flight" && s.status === "booked" && s.departAt && (s.who || "us") === who
    );
  }

  function placeWho(who, at) {
    const list = bookedHops(who);
    if (!list.length) return null;
    const point = (id) => {
      const s = stopById[id];
      return s ? [s.lat, s.lng] : null;
    };
    if (at <= Date.parse(list[0].departAt)) return point(list[0].fromStopId);
    for (const hop of list) {
      const depart = Date.parse(hop.departAt);
      const arrive = Date.parse(hop.arriveAt);
      if (at < depart) return point(hop.fromStopId);
      if (at <= arrive) {
        const a = point(hop.fromStopId);
        const b = point(hop.toStopId);
        const pts = arc(a, b, hop.bend != null ? hop.bend : 0.12);
        return pts[Math.round(((at - depart) / (arrive - depart)) * (pts.length - 1))];
      }
    }
    return point(list[list.length - 1].toStopId);
  }

  function chainProgress(who, at) {
    const list = bookedHops(who);
    if (!list.length) return 0;
    const n = list.length;
    if (at <= Date.parse(list[0].departAt)) return 0;
    for (let i = 0; i < n; i++) {
      const depart = Date.parse(list[i].departAt);
      const arrive = Date.parse(list[i].arriveAt);
      if (at < depart) return i / n;
      if (at <= arrive) return (i + (at - depart) / (arrive - depart)) / n;
    }
    return 1;
  }

  function setupGlider() {
    const range = document.getElementById("glider-range");
    const dateEl = document.getElementById("glider-date");
    const line = document.getElementById("glider-line");
    if (!range || !map) return;
    const start = Date.parse("2026-11-12T00:00:00+13:00");
    const end = Date.parse("2026-12-05T18:00:00+13:00");
    const faces = window.TRIP_FACES || {};
    const people = [
      { id: "matt", who: "us", src: faces.matt, shift: "-18px" },
      { id: "dad", who: "us", src: faces.dad, shift: "2px" },
      { id: "sam", who: "sam", src: faces.sam, shift: "-10px" },
    ];
    const markers = {};
    people.forEach((person) => {
      const icon = L.divIcon({
        className: "face-pin",
        html: person.src
          ? `<img alt="" src="${person.src}" class="${person.who}" />`
          : `<span class="face-fallback ${person.who}"></span>`,
        iconSize: [36, 36],
        iconAnchor: person.id === "dad" ? [0, 18] : person.id === "matt" ? [36, 18] : [18, 18],
      });
      const marker = L.marker(placeWho(person.who, start), { icon, zIndexOffset: 900, keyboard: false }).addTo(map);
      markers[person.id] = marker;
      if (line && person.src) {
        const img = document.createElement("img");
        img.alt = "";
        img.src = person.src;
        img.className = "glider-face " + person.who;
        img.dataset.shift = person.shift;
        img.dataset.who = person.who;
        line.appendChild(img);
      }
    });
    range.min = String(start);
    range.max = String(end);
    range.step = String(15 * 60 * 1000);
    range.value = String(Date.parse("2026-11-16T18:00:00+13:00"));
    const fmt = new Intl.DateTimeFormat("en-NZ", {
      timeZone: "Pacific/Auckland",
      weekday: "short",
      day: "numeric",
      month: "short",
      hour: "numeric",
      minute: "2-digit",
    });
    const paint = () => {
      const at = Number(range.value);
      if (dateEl) dateEl.textContent = fmt.format(at);
      people.forEach((person) => {
        const coord = placeWho(person.who, at);
        if (coord) markers[person.id].setLatLng(coord);
      });
      if (!line) return;
      line.querySelectorAll(".glider-face").forEach((img) => {
        const p = chainProgress(img.dataset.who, at);
        img.style.left = `calc(12px + (100% - 24px) * ${p})`;
        img.style.transform = `translate(${img.dataset.shift}, -50%)`;
      });
    };
    range.addEventListener("input", paint);
    paint();
  }

  function exportJson() {
    refreshMerged();
    const payload = {
      ...data,
      _exportedAt: new Date().toISOString(),
      _localEdits: edits,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "trip-itinerary-merged.json";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function resetEdits() {
    if (!confirm("Clear all local edits and restore the base itinerary?")) {
      return;
    }
    edits = { stops: {}, segments: {} };
    localStorage.removeItem(STORAGE_KEY);
    refreshMerged();
    setDirty(false);
    if (activeStopId) openStop(activeStopId);
  }

  function init() {
    els.title.textContent = data.title;
    els.subtitle.textContent = data.traveler || "";
    document.title = "Trip Map — " + data.title;

    if (els.tripSelect) {
      els.tripSelect.innerHTML = TRIPS.map(
        (t) =>
          `<option value="${escapeHtml(t.key)}" ${t.key === currentTrip.key ? "selected" : ""}>${escapeHtml(t.label)}</option>`
      ).join("");
      if (TRIPS.length < 2 && els.tripSelect.closest(".trip-picker")) els.tripSelect.closest(".trip-picker").hidden = true;
      els.tripSelect.addEventListener("change", () => {
        const url = new URL(window.location.href);
        url.searchParams.set("trip", els.tripSelect.value);
        window.location.href = url.toString();
      });
    }
    const hasSuperseded = data.segments.some((s) => s.status === "superseded");
    if (els.supersededToggle) els.supersededToggle.hidden = !hasSuperseded;
    if (els.legend) els.legend.dataset.mode = data.drawSegments ? "booked" : "classic";
    if (els.btnStops) els.btnStops.addEventListener("click", openStopsList);
    if (els.btnThink) {
      if (data.toThink) {
        const n = data.toThink.items.length + (data.toThink.unverified || []).length;
        els.btnThink.textContent = `To think about (${n})`;
        els.btnThink.addEventListener("click", openThink);
      } else {
        els.btnThink.hidden = true;
      }
    }

    els.showSuperseded.checked = showSuperseded;
    els.showSuperseded.addEventListener("change", () => {
      showSuperseded = els.showSuperseded.checked;
      localStorage.setItem(SHOW_SUPERSEDED_KEY, showSuperseded ? "1" : "0");
      drawRoutes();
      if (activeStopId) openStop(activeStopId);
    });

    els.close.addEventListener("click", closePanel);
    els.btnSave.addEventListener("click", () => {
      persist();
      if (activeStopId) {
        // Re-render with merged data so labels stay in sync
        openStop(activeStopId);
        setDirty(false);
        els.saveStatus.textContent = "Saved locally";
        els.saveStatus.className = "save-status saved";
      }
    });
    els.btnExport.addEventListener("click", exportJson);
    els.btnReset.addEventListener("click", resetEdits);

    // Auto-save on blur / before unload if dirty
    window.addEventListener("beforeunload", () => {
      if (dirty) persist();
    });

    // Debounced auto-save while typing
    let saveTimer = null;
    document.addEventListener("input", (e) => {
      if (!e.target.closest || !e.target.closest("#detail-panel")) return;
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        if (dirty) persist();
      }, 600);
    });

    initMap();

    // Deep links: #stops, #think, #stop=<id>
    const hash = decodeURIComponent(window.location.hash.slice(1));
    if (hash === "stops") openStopsList();
    else if (hash === "think" && data.toThink) openThink();
    else if (hash.startsWith("stop=") && stopById[hash.slice(5)]) openStop(hash.slice(5));

    // If previous session had edits, hint that they restored
    if (
      Object.keys(edits.stops).length ||
      Object.keys(edits.segments).length
    ) {
      els.saveStatus.textContent = "Local edits restored";
      els.saveStatus.className = "save-status saved";
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
