import os
import serial
import threading
import time
import json
from datetime import datetime, timezone
from flask import Flask, render_template, jsonify, request
from dotenv import load_dotenv
from pymongo import MongoClient, DESCENDING

load_dotenv()

app = Flask(__name__)

# ── MongoDB ───────────────────────────────────────────────────────────────────
MONGO_URI = os.getenv("MONGO_URI", "mongodb://localhost:27017/FaminiDemo")
mongo_client = MongoClient(MONGO_URI)
db           = mongo_client["FaminiDemo"]
col_sensors  = db["sensor_readings"]   # TOF + IR readings
col_events   = db["actuator_events"]   # Buzzer / Motor events

# ── Serial config ─────────────────────────────────────────────────────────────
SERIAL_PORT = os.getenv("SERIAL_PORT", "/dev/ttyUSB0")
BAUD_RATE   = int(os.getenv("BAUD_RATE", 115200))

ser         = None
serial_lock = threading.Lock()

# ── Auto logic thresholds ─────────────────────────────────────────────────────
TOF_ALERT_MM      = 60     # buzzer triggers when TOF < 60 mm
BUZZER_AUTO_SEC   = 2      # buzzer stays on for 2 s in auto mode
MOTOR_ROTATE_SEC  = 1.5    # approx time for 180° rotation (tune to your motor)

# ── Shared state ──────────────────────────────────────────────────────────────
state = {
    "tof":      {"distance_mm": None, "status": "Waiting..."},
    "ir":       {"detected": None,    "status": "Waiting..."},
    "buzzer":   {"active": False},
    "dc_motor": {"running": False, "direction": "stopped", "speed": 0},
    "mode":     "manual",   # "manual" | "auto"
    "connected":   False,
    "last_update": "--:--:--",
}

# Internal auto-mode timer flags
_buzzer_timer  = None
_motor_timer   = None
_auto_lock     = threading.Lock()


# ── DB helpers ────────────────────────────────────────────────────────────────

def log_sensor(tof_mm, ir_detected):
    """Store a sensor reading in MongoDB."""
    try:
        col_sensors.insert_one({
            "timestamp":    datetime.now(timezone.utc),
            "tof_mm":       tof_mm,
            "ir_detected":  ir_detected,
        })
    except Exception as e:
        print(f"[DB sensor log] {e}")


def log_event(actuator: str, action: str, trigger: str):
    """
    Store an actuator event in MongoDB.
    trigger = 'auto' | 'manual'
    """
    try:
        col_events.insert_one({
            "timestamp": datetime.now(timezone.utc),
            "actuator":  actuator,   # 'buzzer' | 'dc_motor'
            "action":    action,     # 'on' | 'off' | 'rotate_180' | 'stop'
            "trigger":   trigger,
        })
    except Exception as e:
        print(f"[DB event log] {e}")


# ── Serial helpers ────────────────────────────────────────────────────────────

def connect_serial():
    global ser
    while True:
        try:
            with serial_lock:
                if ser is None or not ser.is_open:
                    ser = serial.Serial(SERIAL_PORT, BAUD_RATE, timeout=1)
                    state["connected"] = True
                    print(f"[Serial] Connected → {SERIAL_PORT} @ {BAUD_RATE}")
        except serial.SerialException as e:
            state["connected"] = False
            print(f"[Serial] {e} — retrying in 3 s…")
        time.sleep(3)


def read_serial():
    global ser
    while True:
        try:
            with serial_lock:
                if ser and ser.is_open and ser.in_waiting > 0:
                    raw = ser.readline().decode("utf-8", errors="ignore").strip()
                    if raw:
                        _parse(raw)
        except Exception as e:
            print(f"[Read] {e}")
            state["connected"] = False
        time.sleep(0.05)


_last_log_time = 0
LOG_INTERVAL   = 2   # log sensor readings every 2 s to avoid flooding DB

def _parse(raw: str):
    global _last_log_time
    try:
        d = json.loads(raw)

        tof_mm      = None
        ir_detected = None

        if "tof" in d:
            tof_mm = round(float(d["tof"]), 1)
            state["tof"]["distance_mm"] = tof_mm
            state["tof"]["status"] = "Active"

        if "ir" in d:
            ir_detected = bool(d["ir"])
            state["ir"]["detected"] = ir_detected
            state["ir"]["status"] = "Object Detected" if ir_detected else "Clear"

        if "buzzer" in d:
            state["buzzer"]["active"] = bool(d["buzzer"])
        if "motor_running" in d:
            state["dc_motor"]["running"] = bool(d["motor_running"])
        if "motor_dir" in d:
            state["dc_motor"]["direction"] = str(d["motor_dir"])
        if "motor_speed" in d:
            state["dc_motor"]["speed"] = int(d["motor_speed"])

        state["connected"]   = True
        state["last_update"] = time.strftime("%H:%M:%S")

        # Throttled DB logging
        now = time.time()
        if now - _last_log_time >= LOG_INTERVAL:
            _last_log_time = now
            if tof_mm is not None or ir_detected is not None:
                threading.Thread(
                    target=log_sensor,
                    args=(tof_mm, ir_detected),
                    daemon=True
                ).start()

        # Auto-mode logic
        if state["mode"] == "auto":
            _run_auto_logic(tof_mm, ir_detected)

    except (json.JSONDecodeError, ValueError, KeyError) as e:
        print(f"[Parse] '{raw}' → {e}")


# ── Auto-mode logic ───────────────────────────────────────────────────────────

def _run_auto_logic(tof_mm, ir_detected):
    global _buzzer_timer, _motor_timer

    with _auto_lock:
        # TOF < 60 mm → buzzer ON for 2 s
        if tof_mm is not None and tof_mm < TOF_ALERT_MM:
            if not state["buzzer"]["active"]:
                _trigger_buzzer_auto()

        # IR detected → motor rotate 180°
        if ir_detected:
            if not state["dc_motor"]["running"]:
                _trigger_motor_auto()


def _trigger_buzzer_auto():
    global _buzzer_timer
    send_cmd({"cmd": "buzzer", "active": True})
    state["buzzer"]["active"] = True
    log_event("buzzer", "on", "auto")

    # Cancel any existing timer
    if _buzzer_timer and _buzzer_timer.is_alive():
        _buzzer_timer.cancel()

    def _off():
        send_cmd({"cmd": "buzzer", "active": False})
        state["buzzer"]["active"] = False
        log_event("buzzer", "off", "auto")

    _buzzer_timer = threading.Timer(BUZZER_AUTO_SEC, _off)
    _buzzer_timer.daemon = True
    _buzzer_timer.start()


def _trigger_motor_auto():
    global _motor_timer
    send_cmd({"cmd": "motor", "action": "rotate180", "speed": 180})
    state["dc_motor"]["running"]   = True
    state["dc_motor"]["direction"] = "rotate180"
    state["dc_motor"]["speed"]     = 180
    log_event("dc_motor", "rotate_180", "auto")

    if _motor_timer and _motor_timer.is_alive():
        _motor_timer.cancel()

    def _stop():
        send_cmd({"cmd": "motor", "action": "stop", "speed": 0})
        state["dc_motor"]["running"]   = False
        state["dc_motor"]["direction"] = "stopped"
        state["dc_motor"]["speed"]     = 0
        log_event("dc_motor", "stop", "auto")

    _motor_timer = threading.Timer(MOTOR_ROTATE_SEC, _stop)
    _motor_timer.daemon = True
    _motor_timer.start()


def send_cmd(cmd: dict) -> bool:
    global ser
    try:
        with serial_lock:
            if ser and ser.is_open:
                ser.write((json.dumps(cmd) + "\n").encode("utf-8"))
                return True
    except Exception as e:
        print(f"[Write] {e}")
    return False


# ── Routes — pages ────────────────────────────────────────────────────────────

@app.route("/")
def index():
    return render_template("index.html")


@app.route("/history")
def history():
    return render_template("history.html")


# ── Routes — API ──────────────────────────────────────────────────────────────

@app.route("/api/state")
def api_state():
    return jsonify(state)


@app.route("/api/mode", methods=["POST"])
def api_mode():
    """Switch between auto and manual mode. Body: { "mode": "auto"|"manual" }"""
    body = request.get_json(force=True)
    m    = body.get("mode", "manual")
    if m not in ("auto", "manual"):
        return jsonify({"error": "mode must be 'auto' or 'manual'"}), 400
    state["mode"] = m
    return jsonify({"success": True, "mode": state["mode"]})


@app.route("/api/buzzer", methods=["POST"])
def api_buzzer():
    """
    Manual buzzer control.
    Body: { "action": "on_3s" | "off" }
    on_3s → turns buzzer on for 3 seconds then auto-off
    off   → turns buzzer off immediately
    """
    body   = request.get_json(force=True)
    action = body.get("action", "off")

    if action == "on_3s":
        ok = send_cmd({"cmd": "buzzer", "active": True})
        state["buzzer"]["active"] = True
        log_event("buzzer", "on", "manual")

        def _off():
            send_cmd({"cmd": "buzzer", "active": False})
            state["buzzer"]["active"] = False
            log_event("buzzer", "off", "manual")

        t = threading.Timer(3.0, _off)
        t.daemon = True
        t.start()
        return jsonify({"success": ok, "buzzer_active": True, "auto_off_in": 3})

    else:  # "off"
        ok = send_cmd({"cmd": "buzzer", "active": False})
        state["buzzer"]["active"] = False
        log_event("buzzer", "off", "manual")
        return jsonify({"success": ok, "buzzer_active": False})


@app.route("/api/motor", methods=["POST"])
def api_motor():
    """
    Manual motor control.
    Body: { "action": "rotate180" | "stop" }
    rotate180 → rotates 180° then stops automatically
    stop      → stops immediately
    """
    body   = request.get_json(force=True)
    action = body.get("action", "stop")

    if action == "rotate180":
        ok = send_cmd({"cmd": "motor", "action": "rotate180", "speed": 180})
        state["dc_motor"]["running"]   = True
        state["dc_motor"]["direction"] = "rotate180"
        state["dc_motor"]["speed"]     = 180
        log_event("dc_motor", "rotate_180", "manual")

        def _stop():
            send_cmd({"cmd": "motor", "action": "stop", "speed": 0})
            state["dc_motor"]["running"]   = False
            state["dc_motor"]["direction"] = "stopped"
            state["dc_motor"]["speed"]     = 0
            log_event("dc_motor", "stop", "manual")

        t = threading.Timer(MOTOR_ROTATE_SEC, _stop)
        t.daemon = True
        t.start()
        return jsonify({"success": ok, "motor": state["dc_motor"]})

    else:  # "stop"
        ok = send_cmd({"cmd": "motor", "action": "stop", "speed": 0})
        state["dc_motor"]["running"]   = False
        state["dc_motor"]["direction"] = "stopped"
        state["dc_motor"]["speed"]     = 0
        log_event("dc_motor", "stop", "manual")
        return jsonify({"success": ok, "motor": state["dc_motor"]})


# ── Routes — History API ──────────────────────────────────────────────────────

@app.route("/api/history/sensors")
def api_history_sensors():
    """
    GET /api/history/sensors?page=1&limit=20
    Returns paginated sensor readings from MongoDB.
    """
    page  = max(1, int(request.args.get("page",  1)))
    limit = max(1, min(100, int(request.args.get("limit", 20))))
    skip  = (page - 1) * limit

    cursor = col_sensors.find(
        {},
        {"_id": 0}
    ).sort("timestamp", DESCENDING).skip(skip).limit(limit)

    records = []
    for doc in cursor:
        doc["timestamp"] = doc["timestamp"].strftime("%Y-%m-%d %H:%M:%S UTC")
        records.append(doc)

    total = col_sensors.count_documents({})
    return jsonify({
        "page":    page,
        "limit":   limit,
        "total":   total,
        "pages":   -(-total // limit),  # ceiling division
        "records": records,
    })


@app.route("/api/history/events")
def api_history_events():
    """
    GET /api/history/events?page=1&limit=20&actuator=buzzer
    Returns paginated actuator events from MongoDB.
    """
    page     = max(1, int(request.args.get("page",  1)))
    limit    = max(1, min(100, int(request.args.get("limit", 20))))
    actuator = request.args.get("actuator", "")
    skip     = (page - 1) * limit

    query = {}
    if actuator in ("buzzer", "dc_motor"):
        query["actuator"] = actuator

    cursor = col_events.find(
        query,
        {"_id": 0}
    ).sort("timestamp", DESCENDING).skip(skip).limit(limit)

    records = []
    for doc in cursor:
        doc["timestamp"] = doc["timestamp"].strftime("%Y-%m-%d %H:%M:%S UTC")
        records.append(doc)

    total = col_events.count_documents(query)
    return jsonify({
        "page":    page,
        "limit":   limit,
        "total":   total,
        "pages":   -(-total // limit),
        "records": records,
    })


# ── Start ─────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    threading.Thread(target=connect_serial, daemon=True).start()
    threading.Thread(target=read_serial,    daemon=True).start()

    host = os.getenv("FLASK_HOST", "0.0.0.0")
    port = int(os.getenv("FLASK_PORT", 5000))
    print(f"[Flask] Running on http://{host}:{port}")
    app.run(host=host, port=port, debug=False)
