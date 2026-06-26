/**
 * history.js — FaminiDemo
 * Loads sensor readings and actuator events from MongoDB via Flask API.
 */

// ── Sensor readings ───────────────────────────────────────────────────────────

let sensorPage = 1;
const SENSOR_LIMIT = 20;

async function loadSensors(page = 1) {
  sensorPage = page;
  const tbody  = document.getElementById("sensor-tbody");
  const pager  = document.getElementById("sensor-pagination");
  const totLbl = document.getElementById("sensor-total-label");

  tbody.innerHTML = '<tr><td colspan="3" class="table-loading">Loading…</td></tr>';

  try {
    const res  = await fetch(`/api/history/sensors?page=${page}&limit=${SENSOR_LIMIT}`);
    const data = await res.json();

    totLbl.textContent = `${data.total.toLocaleString()} records`;

    if (data.records.length === 0) {
      tbody.innerHTML = '<tr><td colspan="3" class="table-loading">No records yet.</td></tr>';
      pager.innerHTML = "";
      return;
    }

    tbody.innerHTML = data.records.map(r => `
      <tr>
        <td>${r.timestamp}</td>
        <td>${r.tof_mm !== null ? r.tof_mm + " mm" : "—"}</td>
        <td>${r.ir_detected !== null
          ? (r.ir_detected
              ? '<span class="tag tag-yes">YES</span>'
              : '<span class="tag tag-no">NO</span>')
          : "—"}</td>
      </tr>
    `).join("");

    renderPagination(pager, data.page, data.pages, loadSensors);
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="3" class="table-loading">Error loading data: ${e.message}</td></tr>`;
  }
}


// ── Actuator events ───────────────────────────────────────────────────────────

let eventPage     = 1;
let eventActuator = "";
const EVENT_LIMIT = 20;

async function loadEvents(page = 1, actuator = eventActuator) {
  eventPage     = page;
  eventActuator = actuator;

  const tbody  = document.getElementById("event-tbody");
  const pager  = document.getElementById("event-pagination");
  const totLbl = document.getElementById("event-total-label");

  tbody.innerHTML = '<tr><td colspan="4" class="table-loading">Loading…</td></tr>';

  // Sync filter button active state
  document.querySelectorAll(".filter-btn").forEach(btn => {
    btn.classList.remove("active");
  });
  // Match by onclick text
  document.querySelectorAll(".filter-btn").forEach(btn => {
    const onclick = btn.getAttribute("onclick") || "";
    const match   = onclick.match(/loadEvents\(1,'(.*)'\)/);
    const val     = match ? match[1] : "";
    if (val === actuator) btn.classList.add("active");
  });

  try {
    const q    = actuator ? `&actuator=${actuator}` : "";
    const res  = await fetch(`/api/history/events?page=${page}&limit=${EVENT_LIMIT}${q}`);
    const data = await res.json();

    totLbl.textContent = `${data.total.toLocaleString()} records`;

    if (data.records.length === 0) {
      tbody.innerHTML = '<tr><td colspan="4" class="table-loading">No records yet.</td></tr>';
      pager.innerHTML = "";
      return;
    }

    tbody.innerHTML = data.records.map(r => {
      const actTag    = r.actuator === "buzzer"
        ? '<span class="tag tag-buzzer">🔔 Buzzer</span>'
        : '<span class="tag tag-motor">⚙️ DC Motor</span>';

      const actionTag = buildActionTag(r.action);
      const trigTag   = r.trigger === "auto"
        ? '<span class="tag tag-auto">🤖 Auto</span>'
        : '<span class="tag tag-manual">🖐 Manual</span>';

      return `
        <tr>
          <td>${r.timestamp}</td>
          <td>${actTag}</td>
          <td>${actionTag}</td>
          <td>${trigTag}</td>
        </tr>
      `;
    }).join("");

    renderPagination(pager, data.page, data.pages, (p) => loadEvents(p, eventActuator));
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="4" class="table-loading">Error loading data: ${e.message}</td></tr>`;
  }
}

function buildActionTag(action) {
  switch (action) {
    case "on":         return '<span class="tag tag-on">ON</span>';
    case "off":        return '<span class="tag tag-off">OFF</span>';
    case "rotate_180": return '<span class="tag tag-rotate">↻ Rotate 180°</span>';
    case "stop":       return '<span class="tag tag-stop">⏹ Stop</span>';
    default:           return `<span class="tag">${action}</span>`;
  }
}


// ── Pagination renderer ───────────────────────────────────────────────────────

function renderPagination(container, current, total, onPage) {
  if (total <= 1) { container.innerHTML = ""; return; }

  let html = "";

  // Prev
  html += `<button class="page-btn" ${current === 1 ? "disabled" : ""}
    onclick="(${onPage.name})(${current - 1})">‹ Prev</button>`;

  // Page numbers — show up to 7 around current
  const range = pageRange(current, total);
  for (const p of range) {
    if (p === "…") {
      html += `<span style="padding:0 4px;color:#7a5c00;">…</span>`;
    } else {
      html += `<button class="page-btn ${p === current ? "active" : ""}"
        onclick="(${onPage.name})(${p})">${p}</button>`;
    }
  }

  // Next
  html += `<button class="page-btn" ${current === total ? "disabled" : ""}
    onclick="(${onPage.name})(${current + 1})">Next ›</button>`;

  container.innerHTML = html;
}

function pageRange(current, total) {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  const pages = [];
  pages.push(1);
  if (current > 3) pages.push("…");
  for (let p = Math.max(2, current - 1); p <= Math.min(total - 1, current + 1); p++) {
    pages.push(p);
  }
  if (current < total - 2) pages.push("…");
  pages.push(total);
  return pages;
}


// ── Init ──────────────────────────────────────────────────────────────────────
loadSensors(1);
loadEvents(1, "");
