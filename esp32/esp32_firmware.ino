/**
 * ESP32 Firmware — FaminiDemo
 * ─────────────────────────────────────────────────────────────────────────────
 * Sensors  : VL53L0X TOF  (I2C → SDA=GPIO21, SCL=GPIO22)
 *            IR Sensor    (Digital → GPIO34)
 * Actuators: Piezo Buzzer (GPIO25)
 *            DC Motor via L298N
 *              IN1=GPIO26 | IN2=GPIO27 | ENA(PWM)=GPIO14
 *
 * Serial (USB, 115200 baud) — shared between Pi and Serial Monitor:
 *   Lines starting with '{' = JSON data → parsed by Raspberry Pi app.py
 *   All other lines        = human-readable debug → Serial Monitor only
 *
 * Auto logic (on-device):
 *   TOF < 60 mm → Buzzer ON for 3 s
 *
 * Libraries needed (Arduino Library Manager):
 *   - Adafruit VL53L0X
 *   - ArduinoJson v7 (by Benoit Blanchon)
 * ─────────────────────────────────────────────────────────────────────────────
 */

#include <Arduino.h>
#include <Wire.h>
#include <Adafruit_VL53L0X.h>
#include <ArduinoJson.h>

// ── Pins ──────────────────────────────────────────────────────────────────────
#define PIN_IR      34
#define PIN_BUZZER  25
#define PIN_IN1     26
#define PIN_IN2     27
#define PIN_ENA     14

// ── PWM (ESP32 core 3.x) ──────────────────────────────────────────────────────
#define PWM_FREQ  1000
#define PWM_RES   8      // 8-bit: 0–255

// ── Thresholds ────────────────────────────────────────────────────────────────
#define TOF_ALERT_MM      60     // buzzer triggers below this distance
#define AUTO_BUZZER_MS  3000     // buzzer stays on 3 seconds
#define AUTO_MOTOR_MS   1500     // motor runs for ~180° (tune to your motor)

// ── Globals ───────────────────────────────────────────────────────────────────
Adafruit_VL53L0X tof;
bool tofReady = false;

bool   buzzerOn     = false;
bool   motorRunning = false;
String motorDir     = "stopped";
int    motorSpeed   = 0;

// Timed 180° rotation
bool          rotating180    = false;
unsigned long rotateStart    = 0;
unsigned long rotateDurMs    = AUTO_MOTOR_MS;

// Auto-motor timer (IR detection → rotate 180°)
bool          autoMotorActive = false;
unsigned long autoMotorStart  = 0;

// Auto-buzzer timer
bool          autoBuzzerActive = false;
unsigned long autoBuzzerStart  = 0;

// Cached sensor values — JSON always sends last valid reading, never stale 0
float lastValidDistMm = 0;
bool  lastIrDetected  = false;

unsigned long lastSendMs  = 0;
unsigned long lastPrintMs = 0;
const unsigned long SEND_INTERVAL  =  200;  // JSON every 200 ms
const unsigned long PRINT_INTERVAL = 5000;  // status box every 5 s

// ── Forward declarations ──────────────────────────────────────────────────────
void sendJson();
void printStatus();
void handleCommand(const String& raw);
void setBuzzer(bool on);
void doMotorForward(int spd);
void doMotorBackward(int spd);
void doMotorStop();


// ── Setup ─────────────────────────────────────────────────────────────────────
void setup() {
  Serial.begin(115200);
  delay(500);

  Serial.println();
  Serial.println("╔══════════════════════════════════╗");
  Serial.println("║     FaminiDemo — ESP32 Boot      ║");
  Serial.println("╚══════════════════════════════════╝");

  // ── I2C + TOF ──────────────────────────────────────────────────────────────
  Wire.begin(21, 22);
  delay(100);

  Serial.println("[I2C]    Scanning bus...");
  uint8_t found = 0;
  for (uint8_t addr = 1; addr < 127; addr++) {
    Wire.beginTransmission(addr);
    if (Wire.endTransmission() == 0) {
      Serial.print("[I2C]    Device found at 0x");
      if (addr < 16) Serial.print("0");
      Serial.print(addr, HEX);
      if (addr == 0x29) Serial.print("  <- VL53L0X (expected)");
      Serial.println();
      found++;
    }
  }
  if (found == 0) Serial.println("[I2C]    No devices found! Check SDA=21 SCL=22 and 3.3V.");

  Serial.print("[TOF]    Initializing VL53L0X... ");
  if (tof.begin()) {
    tof.startRangeContinuous();
    tofReady = true;
    Serial.println("OK");
  } else {
    Serial.println("FAILED - check wiring");
  }

  // ── IR ─────────────────────────────────────────────────────────────────────
  pinMode(PIN_IR, INPUT);
  Serial.println("[IR]     Pin 34 ready");

  // ── Buzzer ─────────────────────────────────────────────────────────────────
  pinMode(PIN_BUZZER, OUTPUT);
  digitalWrite(PIN_BUZZER, LOW);
  Serial.print("[BUZZER] Testing beep... ");
  digitalWrite(PIN_BUZZER, HIGH); delay(150); digitalWrite(PIN_BUZZER, LOW);
  Serial.println("done  (if you heard it, buzzer is OK)");

  // ── Motor ──────────────────────────────────────────────────────────────────
  pinMode(PIN_IN1, OUTPUT);
  pinMode(PIN_IN2, OUTPUT);
  ledcAttach(PIN_ENA, PWM_FREQ, PWM_RES);
  doMotorStop();
  Serial.println("[MOTOR]  L298N pins ready");

  Serial.println();
  Serial.println("----------------------------------------------------------");
  Serial.println("  Status refreshes every 5 s");
  Serial.println("  NOTE: JSON lines below are data for the Raspberry Pi");
  Serial.println("----------------------------------------------------------");
  Serial.println();
}


// ── Main loop ─────────────────────────────────────────────────────────────────
void loop() {
  unsigned long now = millis();

  // ── Read IR ────────────────────────────────────────────────────────────────
  lastIrDetected = (digitalRead(PIN_IR) == LOW);

  // ── Read TOF — cache last valid value ──────────────────────────────────────
  if (tofReady && tof.isRangeComplete()) {
    uint16_t raw = tof.readRange();
    if (raw < 8190) {
      lastValidDistMm = (float)raw;
    } else {
      lastValidDistMm = 0;  // out of range
    }
  }

  // ── Auto-buzzer: TOF < 60 mm → ON for 3 s ──────────────────────────────────
  if (lastValidDistMm > 0 && lastValidDistMm < TOF_ALERT_MM) {
    if (!autoBuzzerActive) {
      autoBuzzerActive = true;
      autoBuzzerStart  = now;
      setBuzzer(true);
      Serial.println("[AUTO] TOF < 60mm — Buzzer ON for 3s");
    }
  }
  if (autoBuzzerActive && (now - autoBuzzerStart >= AUTO_BUZZER_MS)) {
    autoBuzzerActive = false;
    setBuzzer(false);
    Serial.println("[AUTO] Buzzer OFF");
  }

  // ── Auto-motor: IR detected → rotate 180° ──────────────────────────────────
  if (lastIrDetected) {
    if (!autoMotorActive && !rotating180) {
      autoMotorActive = true;
      autoMotorStart  = now;
      doMotorForward(180);
      rotating180 = true;
      rotateStart = now;
      Serial.println("[AUTO] IR detected — Motor rotate 180deg");
    }
  }
  // Reset auto-motor latch when IR clears (allows re-trigger next detection)
  if (!lastIrDetected) {
    autoMotorActive = false;
  }

  // ── Auto-stop after timed 180° rotation ────────────────────────────────────
  if (rotating180 && (now - rotateStart >= rotateDurMs)) {
    rotating180 = false;
    doMotorStop();
    Serial.println("[AUTO] Motor stopped after 180deg");
  }

  // ── Read commands from Pi ───────────────────────────────────────────────────
  if (Serial.available() > 0) {
    String line = Serial.readStringUntil('\n');
    line.trim();
    // Only process lines that look like commands (start with '{')
    if (line.length() > 0 && line.startsWith("{")) {
      handleCommand(line);
    }
  }

  // ── Send JSON to Pi ─────────────────────────────────────────────────────────
  if (now - lastSendMs >= SEND_INTERVAL) {
    lastSendMs = now;
    sendJson();
  }

  // ── Print human-readable status box ────────────────────────────────────────
  if (now - lastPrintMs >= PRINT_INTERVAL) {
    lastPrintMs = now;
    printStatus();
  }
}


// ── Send JSON ─────────────────────────────────────────────────────────────────
void sendJson() {
  JsonDocument doc;
  doc["tof"]           = lastValidDistMm;
  doc["ir"]            = lastIrDetected ? 1 : 0;
  doc["buzzer"]        = buzzerOn;
  doc["motor_running"] = motorRunning;
  doc["motor_dir"]     = motorDir;
  doc["motor_speed"]   = motorSpeed;
  serializeJson(doc, Serial);
  Serial.println();
}


// ── Human-readable status box (every 5 s) ────────────────────────────────────
void printStatus() {
  Serial.println();
  Serial.println("+-----------------------------------------+");

  // TOF
  Serial.print("| TOF Distance : ");
  if (!tofReady) {
    Serial.print("NOT CONNECTED            ");
  } else if (lastValidDistMm == 0) {
    Serial.print("Out of range             ");
  } else {
    char buf[26];
    snprintf(buf, sizeof(buf), "%.1f mm                  ", lastValidDistMm);
    buf[25] = '\0';
    Serial.print(buf);
  }
  Serial.println("|");

  // IR
  Serial.print("| IR Sensor    : ");
  Serial.print(lastIrDetected ? "OBJECT DETECTED          " :
                                "Clear                    ");
  Serial.println("|");

  // Buzzer
  Serial.print("| Buzzer       : ");
  Serial.print(buzzerOn ? "ON                       " :
                          "OFF                      ");
  Serial.println("|");

  // Motor
  Serial.print("| DC Motor     : ");
  if (motorRunning) {
    char buf[26];
    snprintf(buf, sizeof(buf), "%-8s spd=%-3d          ", motorDir.c_str(), motorSpeed);
    buf[25] = '\0';
    Serial.print(buf);
  } else {
    Serial.print("STOPPED                  ");
  }
  Serial.println("|");

  Serial.println("+-----------------------------------------+");
  Serial.println();
}


// ── Handle commands from Pi ────────────────────────────────────────────────────
void handleCommand(const String& raw) {
  JsonDocument doc;
  if (deserializeJson(doc, raw) != DeserializationError::Ok) return;

  const char* cmd = doc["cmd"] | "";

  if (strcmp(cmd, "buzzer") == 0) {
    bool on = doc["active"] | false;
    // If Pi sends buzzer command, cancel auto-buzzer timer so they don't fight
    autoBuzzerActive = false;
    setBuzzer(on);
  }
  else if (strcmp(cmd, "motor") == 0) {
    const char* action = doc["action"] | "stop";
    int spd = constrain((int)(doc["speed"] | 0), 0, 255);

    if (strcmp(action, "rotate180") == 0) {
      doMotorForward(spd);
      rotating180 = true;
      rotateStart = millis();
      Serial.println("[CMD] Motor -> rotate180");
    }
    else if (strcmp(action, "forward") == 0) {
      rotating180 = false;
      doMotorForward(spd);
      Serial.println("[CMD] Motor -> forward");
    }
    else if (strcmp(action, "backward") == 0) {
      rotating180 = false;
      doMotorBackward(spd);
      Serial.println("[CMD] Motor -> backward");
    }
    else {
      rotating180 = false;
      autoMotorActive = false;
      doMotorStop();
      Serial.println("[CMD] Motor -> stop");
    }
  }
}


// ── Buzzer ────────────────────────────────────────────────────────────────────
void setBuzzer(bool on) {
  buzzerOn = on;
  digitalWrite(PIN_BUZZER, on ? HIGH : LOW);
}


// ── Motor helpers ─────────────────────────────────────────────────────────────
void doMotorForward(int spd) {
  digitalWrite(PIN_IN1, HIGH);
  digitalWrite(PIN_IN2, LOW);
  ledcWrite(PIN_ENA, spd);
  motorRunning = true;
  motorDir     = "forward";
  motorSpeed   = spd;
}

void doMotorBackward(int spd) {
  digitalWrite(PIN_IN1, LOW);
  digitalWrite(PIN_IN2, HIGH);
  ledcWrite(PIN_ENA, spd);
  motorRunning = true;
  motorDir     = "backward";
  motorSpeed   = spd;
}

void doMotorStop() {
  digitalWrite(PIN_IN1, LOW);
  digitalWrite(PIN_IN2, LOW);
  ledcWrite(PIN_ENA, 0);
  motorRunning = false;
  motorDir     = "stopped";
  motorSpeed   = 0;
}
