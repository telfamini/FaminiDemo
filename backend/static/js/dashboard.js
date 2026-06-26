/**
 * dashboard.js — FaminiDemo
 * Polls /api/state every second. Handles manual/auto mode switching.
 */

const POLL_MS = 1000;
let currentMode = "manual";

// ── DOM refs ──────────────────────────────────────────────────────────────────
const connDot      = document.getElementById("conn-dot");
const connLabel    = document.getElementById("conn-label");
const lastUpdate   = document.getElementById("last-update");

const tofValue     = document.getElementById("tof-value");
const tofBadge     = document.getElementById("tof-badge");
const tofGauge     = document.getElementById("tof-gauge");
const cardTof      = document.getElementById("card-tof");

const buzzerBadge  = document.getElementById("buzzer-badge");
const buzzerPulse  = document.getElementById("buzzer-pulse");
const buzzerDesc   = document.getElementById("buzzer-desc");
const cardBuzzer   = document.getElementById("card-buzzer");
const buzzerCtrls  = document.getElementById("buzzer-controls");
const buzzerAuto   = document.getElementById("buzzer-auto-note");

const irBadge      = document.getElementById("ir-badge");
const irBeam       = document.getElementById("ir-beam");
const irStatusText = document.getElementById("ir-status-text");
const irDetectVal  = document.getElementById("ir-detect-val");
const cardIr       = document.getElementById("card-ir");

const motorBadge      = document.getElementById("motor-badge");
const motorGear       = document.getElementById("motor-gear");
const motorStatusText = document.getElementById("motor-status-text");
const cardMotor       = document.getElementById("card-motor");
const motorCtrls      = document.getElementById("motor-controls");
const motorAuto       = document.getElementById("motor-auto-note");

const btnManual    = document.getElementById("btn-manual");
const btnAuto      = document.getElementById("btn-auto");
const modeDesc     = document.getElementById("mode-desc");


// ── Mode switching ────────────────────────────────────────────────────────────

async function setMode(mode) {
  try {
    const res = await fetch("/api/mode", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ mode })
    });
    const data = await res.json();
    applyMode(data.mode);
  } catch (e) {
    console.error("setMode failed:", e);
  }
}

function applyMode(mode) {
  currentMode = mode;

  btnManual.classList.toggle("active", mode === "manual");
  btnAuto.classList.toggle("active",   mode === "auto");

  const isManual = mode === "manual";

  // Show/hide controls
  buzzerCtrls.style.display = isManual ? "flex" : "none";
  motorCtrls.style.display  = isManual ? "flex" : "none";
  buzzerAuto.style.display  = isManual ? "none" : "block";
  motorAuto.style.display   = isManual ? "none" : "block";

  // Disable buttons in auto mode (already hidden but defensive)
  document.querySelectorAll(".manual-controls .btn").forEach(b => {
    b.disabled = !isManual;
  });

  modeDesc.textContent = isManual
    ? "Manual — you control the actuators"
    : "Automatic — actuators respond to sensor readings";
}

// Init mode on load
applyMode("manual");


// ── State polling ─────────────────────────────────────────────────────────────

async function poll() {
  try {
    const res  = await fetch("/api/state");
    const data = await res.json();
    updateUI(data);
  } catch (e) {
    setDisconnected();
  }
}

function updateUI(d) {
  // Keep mode in sync with server
  if (d.mode && d.mode !== currentMode) {
    applyMode(d.mode);
  }

  // Connection
  if (d.connected) {
    connDot.className     = "dot dot-on";
    connLabel.textContent = "Connected";
  } else {
    setDisconnected();
  }
  lastUpdate.textContent = d.last_update || "--:--:--";

  // ── TOF ──────────────────────────────────────────────────────────────────
  const dist = d.tof.distance_mm;
  if (dist !== null && dist !== undefined) {
    tofValue.textContent = dist;
    tofBadge.textContent = d.tof.status;
    // max gauge range = 2000 mm
    const pct = Math.min(100, (dist / 2000) * 100).toFixed(1);
    tofGauge.style.width = pct + "%";
    cardTof.classList.toggle("alert",  dist < 60);
    cardTof.classList.toggle("active", dist >= 60);
  } else {
    tofValue.textContent = "--";
    tofBadge.textContent = "Waiting";
    tofGauge.style.width = "0%";
    cardTof.classList.remove("alert", "active");
  }

  // ── Buzzer ────────────────────────────────────────────────────────────────
  const bOn = d.buzzer.active;
  buzzerBadge.textContent = bOn ? "ON" : "OFF";
  buzzerDesc.textContent  = bOn ? "🔔 Buzzer is ON!" : "Buzzer is OFF";
  buzzerPulse.classList.toggle("pulsing", bOn);
  cardBuzzer.classList.toggle("alert",  bOn);
  cardBuzzer.classList.remove("active");

  // ── IR ────────────────────────────────────────────────────────────────────
  const irDet = d.ir.detected;
  if (irDet !== null && irDet !== undefined) {
    irBadge.textContent      = d.ir.status;
    irStatusText.textContent = irDet ? "⚠️ Object Detected!" : "✅ Path Clear";
    irDetectVal.textContent  = irDet ? "YES" : "NO";
    irBeam.className         = irDet ? "ir-beam detected" : "ir-beam clear";
    cardIr.classList.toggle("alert",  irDet);
    cardIr.classList.toggle("active", !irDet);
  } else {
    irBadge.textContent      = "Waiting";
    irStatusText.textContent = "No reading yet";
    irDetectVal.textContent  = "—";
    irBeam.className         = "ir-beam";
    cardIr.classList.remove("alert", "active");
  }

  // ── Motor ─────────────────────────────────────────────────────────────────
  const mDir = d.dc_motor.direction;
  const mSpd = d.dc_motor.speed;
  const mRun = d.dc_motor.running;

  motorBadge.textContent = mRun
    ? (mDir === "rotate180" ? "ROTATING 180°" : mDir.toUpperCase())
    : "STOPPED";

  motorStatusText.textContent = mRun
    ? (mDir === "rotate180" ? "Rotating 180°…" : `Running ${mDir}`)
    : "Motor stopped";

  motorGear.classList.remove("spin-cw", "spin-ccw");
  if (mRun) motorGear.classList.add("spin-cw");

  cardMotor.classList.toggle("active", mRun);
  cardMotor.classList.remove("alert");
}

function setDisconnected() {
  connDot.className     = "dot dot-off";
  connLabel.textContent = "Disconnected";
}


// ── Actuator controls (manual only) ──────────────────────────────────────────

async function buzzerOn3s() {
  try {
    await fetch("/api/buzzer", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ action: "on_3s" })
    });
  } catch (e) { console.error("buzzerOn3s:", e); }
}

async function buzzerOff() {
  try {
    await fetch("/api/buzzer", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ action: "off" })
    });
  } catch (e) { console.error("buzzerOff:", e); }
}

async function motorRotate180() {
  try {
    await fetch("/api/motor", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ action: "rotate180" })
    });
  } catch (e) { console.error("motorRotate180:", e); }
}

async function motorStop() {
  try {
    await fetch("/api/motor", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ action: "stop" })
    });
  } catch (e) { console.error("motorStop:", e); }
}


// ── Start ─────────────────────────────────────────────────────────────────────
poll();
setInterval(poll, POLL_MS);
