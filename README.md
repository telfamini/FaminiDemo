# Sensor Dashboard — Raspberry Pi + ESP32

Yellow-themed Flask web dashboard for:
- **TOF Sensor** (VL53L0X) paired with **Piezo Buzzer**
- **IR Sensor** paired with **DC Motor** (L298N driver)

---

## Project Structure

```
Demo Raspi/
├── backend/
│   ├── app.py              ← Flask server
│   ├── .env                ← Serial port config
│   ├── requirements.txt
│   ├── templates/
│   │   └── index.html      ← Dashboard UI (Jinja2)
│   └── static/
│       ├── css/style.css
│       └── js/dashboard.js
└── esp32/
    └── esp32_firmware.ino  ← Arduino sketch for ESP32
```

---

## Raspberry Pi Setup

### 1. Install Python deps
```bash
cd backend
pip install -r requirements.txt
```

### 2. Find your serial port
Plug ESP32 via USB, then:
```bash
ls /dev/ttyUSB*   # usually /dev/ttyUSB0
# or
ls /dev/ttyACM*
```
Update `SERIAL_PORT` in `.env` if different.

### 3. Give serial port permission (one-time)
```bash
sudo usermod -aG dialout $USER
# then log out and back in
```

### 4. Run the server
```bash
python app.py
```
Open a browser on any device on the same network:
```
http://<raspberry-pi-ip>:5000
```

---

## ESP32 Wiring

| Component       | ESP32 Pin |
|-----------------|-----------|
| VL53L0X SDA     | GPIO 21   |
| VL53L0X SCL     | GPIO 22   |
| VL53L0X VCC     | 3.3V      |
| IR Sensor OUT   | GPIO 34   |
| Piezo Buzzer +  | GPIO 25   |
| L298N IN1       | GPIO 26   |
| L298N IN2       | GPIO 27   |
| L298N ENA (PWM) | GPIO 14   |
| ESP32 → Raspi   | USB cable |

---

## ESP32 Arduino Libraries

Install via Arduino Library Manager:
- **Adafruit VL53L0X**
- **ArduinoJson** (by Benoit Blanchon)

---

## Frontend — Flask or Separate?

**Flask handles the frontend** via Jinja2 templates — no React/Vue needed.
The dashboard auto-refreshes every second using plain JavaScript (`fetch`).
