/*
 * ========================================
 *   ESP12E PHONE-CONTROLLED BOT
 *   With IR Obstacle Avoidance
 * ========================================
 */

// ==================== LIBRARIES ====================
#include <ESP8266WiFi.h>
#include <PubSubClient.h>
#include <ESP8266WebServer.h>
#include <EEPROM.h>
#include <ArduinoJson.h>
#include <Servo.h>

// ==================== HARDWARE PIN DEFINITIONS ====================
const int ENA_PIN = 2;      // Left motor speed (PWM)
const int ENB_PIN = 1;      // Right motor speed (PWM) - GPIO1/TX
const int IN1_PIN = 14;     // Left motor direction 1
const int IN2_PIN = 12;     // Left motor direction 2
const int IN3_PIN = 13;     // Right motor direction 1
const int IN4_PIN = 16;     // Right motor direction 2
const int SERVO_PIN = 15;   // Camera servo

// IR SENSORS (Diagonal front-mounted)
const int IR_LEFT_PIN = A0; 
const int IR_RIGHT_PIN = 3;  

// ==================== GLOBAL VARIABLES ====================
String ssid_stored = "";
String password_stored = "";
String control_password_stored = "1234";
bool configMode = false;
int wifiConnectionAttempts = 0;
const int MAX_WIFI_ATTEMPTS = 5;

const char* mqtt_server = "broker.emqx.io";
const int mqtt_port = 1883;
const char* mqtt_user = "";
const char* mqtt_password = "";
const char* command_topic = "carbot/command";
const char* status_topic = "carbot/status";
const char* sensor_topic = "carbot/sensors";  // NEW: Sensor alerts

const int EEPROM_MAGIC = 0xAB12;

WiFiClient espClient;
PubSubClient mqttClient(espClient);
ESP8266WebServer server(80);
Servo servoMotor;

// ==================== MOTOR STATE ====================
int leftSpeed = 0;      // -100 to +100 (negative = reverse)
int rightSpeed = 0;     // -100 to +100 (negative = reverse)
int servoAngle = 90;

// ==================== SENSOR STATE ====================
bool irLeftBlocked = false;
bool irRightBlocked = false;
bool autonomousMode = false;
unsigned long lastSensorCheck = 0;
unsigned long lastStatusTime = 0;
unsigned long lastObstacleAction = 0;  
const unsigned long OBSTACLE_COOLDOWN = 1000; 

bool serialEnabled = true;

// ==================== IR SENSOR THRESHOLD ====================
const float IR_THRESHOLD_VOLTAGE = 0.45;  // 0.45V threshold
const int IR_THRESHOLD_ADC = (int)(IR_THRESHOLD_VOLTAGE / 3.3 * 1023);  // ~140

// ==================== FUNCTION DECLARATIONS ====================
void clearEEPROM();
void loadCredentials();
void saveCredentials(String ssid, String password);
void saveControlPassword(String password);
bool validateControlPassword(String password);
bool connectToWiFi();
void startConfigMode();
void handleRoot();
void handleScan();
void handleConnect();
void handleSetPassword();
void setupWebServer();
void setupMQTT();
void reconnectMQTT();
void mqttCallback(char* topic, byte* payload, unsigned int length);
void publishStatus();
void publishSensorAlert(String alertType, String side);
void readIRSensors();
void handleObstacles();
void setMotorSpeeds(int left, int right);
void stopMotors();
void updateServo(int angle);
void disableSerial();

// ==================== SERIAL HELPER ====================
void disableSerial() {
  if (serialEnabled) {
    Serial.flush();
    delay(100);
    Serial.end();
    serialEnabled = false;
  }
}

// ==================== IR SENSOR READING ====================
void readIRSensors() {
  // Read LEFT sensor (A0 - analog)
  int leftValue = analogRead(IR_LEFT_PIN);
  float leftVoltage = (leftValue / 1023.0) * 3.3;
  irLeftBlocked = (leftVoltage > IR_THRESHOLD_VOLTAGE);  // HIGH = obstacle/no surface
  
  // Read RIGHT sensor (GPIO3 - digital)
  irRightBlocked = digitalRead(IR_RIGHT_PIN);  // HIGH = obstacle/no surface
}

// ==================== OBSTACLE AVOIDANCE (WITH COOLDOWN) ====================
void handleObstacles() {
  if (!autonomousMode) return;  // Only act if autonomous mode enabled
  
  // ========== COOLDOWN CHECK - Prevent re-triggering ==========
  if (millis() - lastObstacleAction < OBSTACLE_COOLDOWN) {
    return;  // Still in cooldown period, skip
  }
  
  readIRSensors();
  
  // ==================== ANY SENSOR DETECTS EDGE ====================
  if (irLeftBlocked || irRightBlocked) {
    
    // Set cooldown IMMEDIATELY before maneuver starts
    lastObstacleAction = millis();
    
    // ========== CALCULATE AVERAGE SPEED ==========
    int avgSpeed = (abs(leftSpeed) + abs(rightSpeed)) / 2;
    
    // ========== SMART BRAKING - Speed-dependent multiplier ==========
    float brakeMultiplier = (avgSpeed > 65) ? 1.5 : 1.0;
    
    int brakeLeft = constrain((int)(-leftSpeed * brakeMultiplier), -100, 100);
    int brakeRight = constrain((int)(-rightSpeed * brakeMultiplier), -100, 100);
    
    setMotorSpeeds(brakeLeft, brakeRight);
    delay(100);  // Brake for 100ms
    stopMotors();
    delay(70);   // Stabilization 70ms
    
    // ==================== DETERMINE RESPONSE ====================
    if (irLeftBlocked && irRightBlocked) {
      // ========== BOTH EDGES DETECTED ==========
      publishSensorAlert("no_forward_path", "both");
      
      // Continue backing up
      setMotorSpeeds(-60, -60);
      delay(500);
      stopMotors();
      
    } else if (irLeftBlocked && !irRightBlocked) {
      // ========== LEFT EDGE DETECTED ==========
      publishSensorAlert("no_surface_left", "left");
      
      // Turn away: left 60% forward, right 40% backward (differential 20)
      setMotorSpeeds(60, -40);
      delay(400);
      stopMotors();
      
      // Move forward 400ms
      setMotorSpeeds(60, 60);
      delay(400);
      stopMotors();
      
    } else if (!irLeftBlocked && irRightBlocked) {
      // ========== RIGHT EDGE DETECTED ==========
      publishSensorAlert("no_surface_right", "right");
      
      // Turn away: right 60% forward, left 40% backward (differential 20)
      setMotorSpeeds(-40, 60);
      delay(400);
      stopMotors();
      
      // Move forward 400ms
      setMotorSpeeds(60, 60);
      delay(400);
      stopMotors();
    }
    
    return;  // Keep monitoring
  }
}


// ==================== MOTOR CONTROL ====================
void setMotorSpeeds(int left, int right) {
  leftSpeed = constrain(left, -100, 100);
  rightSpeed = constrain(right, -100, 100);
  
  // ========== LEFT MOTOR ==========
  int leftPWM;
  if (leftSpeed > 0) {
    // Forward - apply minimum threshold + scaling
    // Map 1-100 to 85-255 (minimum 85 PWM)
    leftPWM = map(leftSpeed, 1, 100, 85, 255);
    digitalWrite(IN1_PIN, LOW);
    digitalWrite(IN2_PIN, HIGH);
    analogWrite(ENA_PIN, leftPWM);
    
  } else if (leftSpeed < 0) {
    // Backward - apply minimum threshold + scaling
    // Map -1 to -100 to 85-255 (minimum 85 PWM)
    leftPWM = map(abs(leftSpeed), 1, 100, 85, 255);
    digitalWrite(IN1_PIN, HIGH);
    digitalWrite(IN2_PIN, LOW);
    analogWrite(ENA_PIN, leftPWM);
    
  } else {
    // Stop (speed = 0)
    digitalWrite(IN1_PIN, LOW);
    digitalWrite(IN2_PIN, LOW);
    analogWrite(ENA_PIN, 0);
  }
  
  // ========== RIGHT MOTOR ==========
  int rightPWM;
  if (rightSpeed > 0) {
    // Forward - apply minimum threshold + scaling
    rightPWM = map(rightSpeed, 1, 100, 85, 255);
    digitalWrite(IN3_PIN, HIGH);
    digitalWrite(IN4_PIN, LOW);
    analogWrite(ENB_PIN, rightPWM);
    
  } else if (rightSpeed < 0) {
    // Backward - apply minimum threshold + scaling
    rightPWM = map(abs(rightSpeed), 1, 100, 85, 255);
    digitalWrite(IN3_PIN, LOW);
    digitalWrite(IN4_PIN, HIGH);
    analogWrite(ENB_PIN, rightPWM);
    
  } else {
    // Stop (speed = 0)
    digitalWrite(IN3_PIN, LOW);
    digitalWrite(IN4_PIN, LOW);
    analogWrite(ENB_PIN, 0);
  }
}


void stopMotors() {
  setMotorSpeeds(0, 0);
}

void updateServo(int angle) {
  servoAngle = constrain(angle, 60, 180);  // ← Changed from (0, 180) to (60, 180)
  servoMotor.write(servoAngle);
}

// ==================== MQTT SENSOR ALERT ====================
void publishSensorAlert(String alertType, String side) {
  if (!mqttClient.connected() || configMode) return;
  
  JsonDocument doc;
  doc["alert_type"] = alertType;
  doc["side"] = side;
  doc["timestamp"] = millis();
  
  String output;
  serializeJson(doc, output);
  mqttClient.publish(sensor_topic, output.c_str());
}

// ==================== EEPROM FUNCTIONS ====================
// (Keep all existing EEPROM functions - clearEEPROM, loadCredentials, saveCredentials, etc.)
void clearEEPROM() {
  if (serialEnabled) Serial.println("Clearing EEPROM...");
  for (int i = 0; i < 512; i++) {
    EEPROM.write(i, 0);
  }
  EEPROM.commit();
  if (serialEnabled) Serial.println("✓ EEPROM cleared");
}

void loadCredentials() {
  if (serialEnabled) Serial.println("Loading credentials from EEPROM...");
  int magic = (EEPROM.read(200) << 8) | EEPROM.read(201);
  if (magic != EEPROM_MAGIC) {
    if (serialEnabled) Serial.println("No valid credentials found");
    return;
  }
  
  int ssidLength = EEPROM.read(0);
  if (ssidLength > 0 && ssidLength < 100) {
    ssid_stored = "";
    for (int i = 0; i < ssidLength; i++) {
      ssid_stored += char(EEPROM.read(1 + i));
    }
  }
  
  int passwordLength = EEPROM.read(100);
  if (passwordLength > 0 && passwordLength < 100) {
    password_stored = "";
    for (int i = 0; i < passwordLength; i++) {
      password_stored += char(EEPROM.read(101 + i));
    }
  }
  
  int controlPasswordLength = EEPROM.read(300);
  if (controlPasswordLength > 0 && controlPasswordLength < 50) {
    control_password_stored = "";
    for (int i = 0; i < controlPasswordLength; i++) {
      control_password_stored += char(EEPROM.read(301 + i));
    }
  }
  
  if (serialEnabled) {
    Serial.println("✓ Credentials loaded");
    if (ssid_stored.length() > 0) {
      Serial.println("  SSID: " + ssid_stored);
    }
  }
}

void saveCredentials(String ssid, String password) {
  if (serialEnabled) Serial.println("Saving WiFi credentials to EEPROM...");
  for (int i = 0; i < 200; i++) {
    EEPROM.write(i, 0);
  }
  
  EEPROM.write(0, ssid.length());
  for (unsigned int i = 0; i < ssid.length(); i++) {
    EEPROM.write(1 + i, ssid[i]);
  }
  
  EEPROM.write(100, password.length());
  for (unsigned int i = 0; i < password.length(); i++) {
    EEPROM.write(101 + i, password[i]);
  }
  
  EEPROM.write(200, (EEPROM_MAGIC >> 8) & 0xFF);
  EEPROM.write(201, EEPROM_MAGIC & 0xFF);
  EEPROM.commit();
  
  ssid_stored = ssid;
  password_stored = password;
  if (serialEnabled) Serial.println("✓ WiFi credentials saved");
}

void saveControlPassword(String password) {
  if (serialEnabled) Serial.println("Saving control password to EEPROM...");
  EEPROM.write(300, password.length());
  for (unsigned int i = 0; i < password.length(); i++) {
    EEPROM.write(301 + i, password[i]);
  }
  EEPROM.commit();
  control_password_stored = password;
  if (serialEnabled) Serial.println("✓ Control password saved");
}

bool validateControlPassword(String password) {
  return (password == control_password_stored);
}

// ==================== MQTT FUNCTIONS ====================
void setupMQTT() {
  mqttClient.setServer(mqtt_server, mqtt_port);
  mqttClient.setCallback(mqttCallback);
}

void reconnectMQTT() {
  if (configMode) return;
  int attempts = 0;
  while (!mqttClient.connected() && attempts < 3) {
    String clientId = "ESP12E_CarBot_" + String(random(0xffff), HEX);
    if (mqttClient.connect(clientId.c_str(), mqtt_user, mqtt_password)) {
      mqttClient.subscribe(command_topic);
      mqttClient.publish(status_topic, "{\"status\":\"online\"}");
    } else {
      attempts++;
      delay(2000);
    }
  }
}

void mqttCallback(char* topic, byte* payload, unsigned int length) {
  JsonDocument doc;
  DeserializationError error = deserializeJson(doc, payload, length);
  if (error) return;
  
  String receivedPassword = doc["password"] | "";
  if (!validateControlPassword(receivedPassword)) return;
  
  // ==================== PROCESS ALL ARGUMENTS (NO RETURN) ====================
  
  // 1. AUTONOMOUS MODE TOGGLE (Process but don't return)
  if (doc["autonomous"].is<bool>()) {
    autonomousMode = doc["autonomous"];
  }
  
  // 2. SERVO CONTROL (Process but don't return)
  if (doc["servo"].is<int>()) {
    int angle = doc["servo"];
    updateServo(angle);
  }
  
  // 3. DIRECT WHEEL SPEED CONTROL
  if (doc["left"].is<int>() && doc["right"].is<int>()) {
    int left = doc["left"];    // -100 to +100
    int right = doc["right"];  // -100 to +100
    
    setMotorSpeeds(left, right);
    return;  // Can return here since motors are set
  }
  
  // 4. SIMPLE DIRECTION COMMANDS (FALLBACK)
  String cmd = doc["cmd"] | "";
  int speed = doc["speed"] | 50;
  
  if (cmd == "F") {
    setMotorSpeeds(speed, speed);
  } else if (cmd == "B") {
    setMotorSpeeds(-speed, -speed);
  } else if (cmd == "L") {
    setMotorSpeeds(-speed, speed);  // Left backward, right forward
  } else if (cmd == "R") {
    setMotorSpeeds(speed, -speed);  // Left forward, right backward
  } else if (cmd == "S") {
    stopMotors();
  }
}


void publishStatus() {
  if (!mqttClient.connected() || configMode) return;
  
  JsonDocument doc;
  doc["device_id"] = "esp12e_carbot";
  doc["status"] = "online";
  doc["left_speed"] = leftSpeed;
  doc["right_speed"] = rightSpeed;
  doc["servo_angle"] = servoAngle;
  doc["autonomous_mode"] = autonomousMode;
  
  // Sensor status
  readIRSensors();
  doc["ir_left_blocked"] = irLeftBlocked;
  doc["ir_right_blocked"] = irRightBlocked;
  
  doc["rssi"] = WiFi.RSSI();
  doc["uptime"] = millis() / 1000;
  
  String output;
  serializeJson(doc, output);
  mqttClient.publish(status_topic, output.c_str());
}
void handleRoot() {
  String html = R"rawliteral(
<!DOCTYPE html>
<html>
<head>
  <meta charset='UTF-8'>
  <meta name='viewport' content='width=device-width, initial-scale=1.0'>
  <title>CarBot WiFi Setup</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: 'Segoe UI', Arial, sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      min-height: 100vh;
      display: flex;
      justify-content: center;
      align-items: center;
      padding: 20px;
    }
    .container {
      background: white;
      border-radius: 20px;
      padding: 40px;
      box-shadow: 0 20px 60px rgba(0,0,0,0.3);
      max-width: 500px;
      width: 100%;
    }
    h1 {
      color: #667eea;
      text-align: center;
      margin-bottom: 10px;
      font-size: 28px;
    }
    h2 {
      color: #666;
      font-size: 18px;
      margin-top: 30px;
      margin-bottom: 15px;
      border-bottom: 2px solid #667eea;
      padding-bottom: 10px;
    }
    .form-group {
      margin-bottom: 20px;
    }
    label {
      display: block;
      margin-bottom: 8px;
      color: #333;
      font-weight: 600;
    }
    input, select {
      width: 100%;
      padding: 12px;
      border: 2px solid #ddd;
      border-radius: 8px;
      font-size: 16px;
      transition: border-color 0.3s;
    }
    input:focus, select:focus {
      outline: none;
      border-color: #667eea;
    }
    button {
      width: 100%;
      padding: 14px;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      border: none;
      border-radius: 8px;
      font-size: 16px;
      font-weight: 600;
      cursor: pointer;
      transition: transform 0.2s, box-shadow 0.2s;
      margin-top: 10px;
    }
    button:hover {
      transform: translateY(-2px);
      box-shadow: 0 5px 15px rgba(102, 126, 234, 0.4);
    }
    .btn-secondary {
      background: linear-gradient(135deg, #f093fb 0%, #f5576c 100%);
    }
    .status {
      text-align: center;
      margin-top: 20px;
      padding: 15px;
      border-radius: 8px;
      background: #f0f0f0;
      display: none;
    }
    .status.show { display: block; }
    .status.success { background: #d4edda; color: #155724; }
    .status.error { background: #f8d7da; color: #721c24; }
    .checkbox-group {
      display: flex;
      align-items: center;
      margin-top: 10px;
    }
    .checkbox-group input[type="checkbox"] {
      width: auto;
      margin-right: 8px;
    }
    .info-box {
      background: #e7f3ff;
      border-left: 4px solid #2196F3;
      padding: 12px;
      margin-bottom: 20px;
      border-radius: 4px;
      font-size: 14px;
      color: #1976D2;
    }
  </style>
</head>
<body>
  <div class='container'>
    <h1>🚗 CarBot Setup</h1>
    <div class='info-box'>
      📡 Phone-controlled bot with IR obstacle detection
    </div>
    <h2>📶 WiFi Configuration</h2>
    <div class='form-group'>
      <button onclick='scanNetworks()'>Scan for Networks</button>
    </div>
    <div class='form-group'>
      <label for='ssid'>WiFi Network:</label>
      <select id='ssid'>
        <option value=''>Select a network...</option>
      </select>
    </div>
    <div class='form-group'>
      <label for='password'>WiFi Password:</label>
      <input type='password' id='password' placeholder='Enter WiFi password'>
      <div class='checkbox-group'>
        <input type='checkbox' id='showPass' onclick='togglePassword("password", "showPass")'>
        <label for='showPass' style='margin:0; font-weight:normal;'>Show password</label>
      </div>
    </div>
    <div class='form-group'>
      <button onclick='connectWiFi()'>Save & Connect</button>
    </div>
    <h2>🔐 MQTT Control Password</h2>
    <div class='form-group'>
      <label for='controlPassword'>Control Password:</label>
      <input type='password' id='controlPassword' placeholder='Min 4 characters' value='1234'>
      <div class='checkbox-group'>
        <input type='checkbox' id='showControl' onclick='togglePassword("controlPassword", "showControl")'>
        <label for='showControl' style='margin:0; font-weight:normal;'>Show password</label>
      </div>
    </div>
    <div class='form-group'>
      <button class='btn-secondary' onclick='setControlPassword()'>Update Password</button>
    </div>
    <div id='status' class='status'></div>
  </div>
  <script>
    function togglePassword(inputId, checkboxId) {
      const input = document.getElementById(inputId);
      const checkbox = document.getElementById(checkboxId);
      input.type = checkbox.checked ? 'text' : 'password';
    }
    function showStatus(message, type) {
      const status = document.getElementById('status');
      status.textContent = message;
      status.className = 'status show ' + type;
      setTimeout(() => {
        status.classList.remove('show');
      }, 5000);
    }
    function scanNetworks() {
      showStatus('Scanning...', '');
      fetch('/scan')
        .then(response => response.json())
        .then(data => {
          const select = document.getElementById('ssid');
          select.innerHTML = '<option value="">Select a network...</option>';
          data.networks.forEach(network => {
            const option = document.createElement('option');
            option.value = network.ssid;
            option.textContent = network.ssid + ' (' + network.rssi + ' dBm)';
            select.appendChild(option);
          });
          showStatus('Found ' + data.networks.length + ' networks', 'success');
        })
        .catch(error => {
          showStatus('Scan failed', 'error');
        });
    }
    function connectWiFi() {
      const ssid = document.getElementById('ssid').value;
      const password = document.getElementById('password').value;
      if (!ssid) {
        showStatus('Please select a network', 'error');
        return;
      }
      showStatus('Saving and connecting...', '');
      fetch('/connect', {
        method: 'POST',
        headers: {'Content-Type': 'application/x-www-form-urlencoded'},
        body: 'ssid=' + encodeURIComponent(ssid) + '&password=' + encodeURIComponent(password)
      })
        .then(response => response.json())
        .then(data => {
          if (data.success) {
            showStatus('Saved! Restarting...', 'success');
            setTimeout(() => {
              window.location.reload();
            }, 3000);
          } else {
            showStatus('Failed: ' + data.message, 'error');
          }
        })
        .catch(error => {
          showStatus('Error occurred', 'error');
        });
    }
    function setControlPassword() {
      const password = document.getElementById('controlPassword').value;
      if (password.length < 4) {
        showStatus('Password must be at least 4 characters', 'error');
        return;
      }
      showStatus('Updating...', '');
      fetch('/setpassword', {
        method: 'POST',
        headers: {'Content-Type': 'application/x-www-form-urlencoded'},
        body: 'password=' + encodeURIComponent(password)
      })
        .then(response => response.json())
        .then(data => {
          if (data.success) {
            showStatus('Password updated!', 'success');
          } else {
            showStatus('Update failed', 'error');
          }
        })
        .catch(error => {
          showStatus('Error occurred', 'error');
        });
    }
  </script>
</body>
</html>
)rawliteral";
  server.send(200, "text/html", html);
}

// ==================== WIFI FUNCTIONS  ====================
bool connectToWiFi() {
  if (ssid_stored.length() == 0) {
    if (serialEnabled) Serial.println("No stored WiFi credentials");
    return false;
  }
  
  if (serialEnabled) {
    Serial.println("\n--- WiFi Connection Attempt ---");
    Serial.println("SSID: " + ssid_stored);
    Serial.println("Attempt: " + String(wifiConnectionAttempts + 1) + "/" + String(MAX_WIFI_ATTEMPTS));
  }
  
  WiFi.mode(WIFI_STA);
  WiFi.begin(ssid_stored.c_str(), password_stored.c_str());
  
  int timeout = 0;
  while (WiFi.status() != WL_CONNECTED && timeout < 20) {
    delay(500);
    if (serialEnabled) Serial.print(".");
    timeout++;
  }
  if (serialEnabled) Serial.println();
  
  if (WiFi.status() == WL_CONNECTED) {
    if (serialEnabled) {
      Serial.println("✓ WiFi Connected!");
      Serial.print("  IP Address: ");
      Serial.println(WiFi.localIP());
      Serial.print("  Signal: ");
      Serial.print(WiFi.RSSI());
      Serial.println(" dBm");
    }
    wifiConnectionAttempts = 0;
    configMode = false;
    return true;
  } else {
    if (serialEnabled) Serial.println("✗ Connection failed");
    wifiConnectionAttempts++;
    return false;
  }
}

void startConfigMode() {
  if (serialEnabled) {
    Serial.println("\n========================================");
    Serial.println("  STARTING AP CONFIGURATION MODE");
    Serial.println("========================================");
  }
  configMode = true;
  WiFi.mode(WIFI_AP);
  WiFi.softAP("CarBot_Config", "12345678");
  IPAddress IP = WiFi.softAPIP();
  if (serialEnabled) {
    Serial.println("AP SSID: CarBot_Config");
    Serial.println("AP Password: 12345678");
    Serial.print("Configuration URL: http://");
    Serial.println(IP);
    Serial.println("========================================\n");
  }
}

void handleScan() {
  int n = WiFi.scanNetworks();
  String json = "{\"networks\":[";
  for (int i = 0; i < n; i++) {
    if (i > 0) json += ",";
    json += "{\"ssid\":\"" + WiFi.SSID(i) + "\",\"rssi\":" + String(WiFi.RSSI(i)) + "}";
  }
  json += "]}";
  server.send(200, "application/json", json);
}

void handleConnect() {
  if (server.hasArg("ssid") && server.hasArg("password")) {
    String ssid = server.arg("ssid");
    String password = server.arg("password");
    saveCredentials(ssid, password);
    server.send(200, "application/json", "{\"success\":true,\"message\":\"Saved\"}");
    delay(1000);
    ESP.restart();
  } else {
    server.send(400, "application/json", "{\"success\":false,\"message\":\"Missing parameters\"}");
  }
}

void handleSetPassword() {
  if (server.hasArg("password")) {
    String password = server.arg("password");
    if (password.length() >= 4) {
      saveControlPassword(password);
      server.send(200, "application/json", "{\"success\":true}");
    } else {
      server.send(400, "application/json", "{\"success\":false,\"message\":\"Too short\"}");
    }
  } else {
    server.send(400, "application/json", "{\"success\":false,\"message\":\"Missing\"}");
  }
}

void setupWebServer() {
  server.on("/", handleRoot);
  server.on("/scan", handleScan);
  server.on("/connect", HTTP_POST, handleConnect);
  server.on("/setpassword", HTTP_POST, handleSetPassword);
  server.begin();
}

// ==================== SETUP ====================
void setup() {
  // ========== STEP 1: SECURE ALL MOTOR PINS IMMEDIATELY ==========
  pinMode(ENA_PIN, OUTPUT);
  pinMode(IN1_PIN, OUTPUT);
  pinMode(IN2_PIN, OUTPUT);
  pinMode(IN3_PIN, OUTPUT);
  pinMode(IN4_PIN, OUTPUT);
  
  digitalWrite(ENA_PIN, LOW);
  digitalWrite(IN1_PIN, LOW);
  digitalWrite(IN2_PIN, LOW);
  digitalWrite(IN3_PIN, LOW);
  digitalWrite(IN4_PIN, LOW);
  
  delayMicroseconds(100);
  
  // ========== STEP 2: SETUP IR SENSORS ==========
  pinMode(IR_RIGHT_PIN, INPUT);  // GPIO3 (RX) as digital input
  // A0 is analog by default, no pinMode needed
  
  // ========== STEP 3: START SERIAL ==========
  Serial.begin(115200);
  delay(100);
  EEPROM.begin(512);
  
  Serial.println("\n\n========================================");
  Serial.println("  ESP12E PHONE-CONTROLLED BOT v3.0");
  Serial.println("  Direct Wheel Speed Control + IR Sensors");
  Serial.println("========================================");
  Serial.println("✓ Motor pins secured");
  Serial.println("✓ IR sensors initialized (A0, GPIO3)");
  Serial.println("⏳ ENB (GPIO1) will init after WiFi...");
  
  // ========== STEP 4: INITIALIZE SERVO ==========
  servoMotor.attach(SERVO_PIN);
  servoMotor.write(servoAngle);
  Serial.println("✓ Servo initialized on GPIO15");
  
  // ========== STEP 5: LOAD CREDENTIALS ==========
  loadCredentials();
  
  // ========== STEP 6: WIFI CONNECTION ==========
  if (ssid_stored.length() > 0) {
    Serial.println("\n--- Attempting WiFi Connection ---");
    
    while (wifiConnectionAttempts < MAX_WIFI_ATTEMPTS) {
      if (connectToWiFi()) {
        Serial.println("\n✅ WiFi connected successfully!");
        
        // Setup MQTT
        setupMQTT();
        reconnectMQTT();
        
        if (mqttClient.connected()) {
          Serial.println("✅ MQTT connected to broker");
        } else {
          Serial.println("⚠ MQTT connection failed (will retry in loop)");
        }
        
        // ========== STEP 7: DISABLE SERIAL & INIT ENB ==========
        Serial.println("\n🔄 Disabling Serial to free GPIO1...");
        Serial.println("✅ GPIO1 (ENB) will control right motor");
        Serial.println("========================================");
        Serial.flush();
        delay(200);
        
        disableSerial();
        
        // NOW safe to initialize ENB on GPIO1
        pinMode(ENB_PIN, OUTPUT);
        digitalWrite(ENB_PIN, LOW);
        delay(50);
        
        break;
      }
      
      delay(1000);
    }
    
    // ========== WIFI FAILED - AP MODE ==========
    if (wifiConnectionAttempts >= MAX_WIFI_ATTEMPTS) {
      Serial.println("\n⚠ All WiFi attempts failed!");
      Serial.println("⚠ Starting AP mode...");
      startConfigMode();
      setupWebServer();
      Serial.println("✅ AP mode active at http://192.168.4.1");
    }
    
  } else {
    // ========== NO CREDENTIALS - AP MODE ==========
    Serial.println("\n⚠ No WiFi credentials found");
    Serial.println("⚠ Starting AP mode...");
    startConfigMode();
    setupWebServer();
    Serial.println("✅ AP mode active");
    Serial.println("   SSID: CarBot_Config");
    Serial.println("   Password: 12345678");
    Serial.println("   URL: http://192.168.4.1");
  }
  
  // ========== STEP 8: INITIALIZE TIMERS ==========
  lastSensorCheck = millis();
  lastStatusTime = millis();
  
  if (serialEnabled) {
    Serial.println("\n========================================");
    Serial.println("✅ SYSTEM READY!");
    Serial.println("========================================\n");
  }
}

// ==================== LOOP ====================
void loop() {
  if (configMode) {
    server.handleClient();
    
  } else {
    // ========== MQTT CONNECTION ==========
    if (!mqttClient.connected()) {
      reconnectMQTT();
    }
    mqttClient.loop();
    
    // ========== AUTONOMOUS OBSTACLE AVOIDANCE ==========
    if (autonomousMode) {
      if (millis() - lastSensorCheck > 100) {  // Check every 100ms
        handleObstacles();
        lastSensorCheck = millis();
      }
    }
    
    // ========== PUBLISH STATUS ==========
    if (millis() - lastStatusTime > 2000) {
      publishStatus();
      lastStatusTime = millis();
    }
  }
  
  delay(10);
}
