/**
 * Motion Sensor Module
 * Handles gyroscope, accelerometer, and orientation with zero-based calibration
 */

class MotionSensor {
    constructor() {
        this.isActive = false;
        this.calibrated = false;
        
        // Device detection
        this.isMIUI = /MIUI|Xiaomi|Redmi|MI/i.test(navigator.userAgent);
        this.isAndroid = /Android/i.test(navigator.userAgent);
        this.isIOS = /iPhone|iPad|iPod/i.test(navigator.userAgent);
        
        console.log('Device detected:', {
            MIUI: this.isMIUI,
            Android: this.isAndroid,
            iOS: this.isIOS,
            UA: navigator.userAgent
        });
        
        // Zero reference points (calibration)
        this.zeroPoint = {
            alpha: 0,
            beta: 0,
            gamma: 0
        };
        
        // Current readings
        this.current = {
            gyro: { alpha: 0, beta: 0, gamma: 0 },
            accel: { x: 0, y: 0, z: 0 },
            orientation: { alpha: 0, beta: 0, gamma: 0 },
            apiOrientation: { alpha: 0, beta: 0, gamma: 0 },
            magnetometer: { heading: 0, raw: 0, available: false, source: 'none' }
        };
        this.nativeOrientation = { alpha: 0, beta: 0, gamma: 0 };
        this.lastOrientationUpdate = 0;
        this.absoluteSensor = null;
        this.magnetometerSensor = null;
        this.usingAbsoluteSensor = false;
        this.filteredHeading = null;
        this.gyroBias = { alpha: 0, beta: 0, gamma: 0 };
        
        // Smoothing - lighter for Xiaomi phones
        this.smoothingFactor = this.isMIUI ? 0.7 : 0.85;
        this.previousOrientation = { alpha: 0, beta: 0, gamma: 0 };
        
        // Drift compensation - stricter for Xiaomi
        this.driftThreshold = this.isMIUI ? 0.2 : 0.15;
        this.stationaryRotationThreshold = 0.25; // deg/s total to consider still
        this.stationaryAccelThreshold = 0.6; // m/s^2 deviation from gravity
        this.biasLearningRate = 0.015; // how fast gyro bias adapts when stationary
        this.gravity = 9.80665;
        
        // Gyroscope integration (for MIUI devices)
        this.useGyroIntegration = this.isMIUI;
        this.integratedAngles = { alpha: 0, beta: 0, gamma: 0 };
        this.lastGyroTimestamp = null;
        
        // Sensor fusion - complementary filter weights
        // Higher gyro weight = more responsive, lower = more drift correction
        this.gyroWeight = 0.97; // slightly lower to allow more correction
        this.yawCorrectionWeight = this.isMIUI ? 0.3 : 0.18;
        this.orientationCorrectionWeight = this.isMIUI ? 0.35 : 0.15;
        this.accelFilterWeight = 0.9; // Smoothing for accelerometer
        this.filteredAccel = { x: 0, y: 0, z: 0 };
    this.magnetometerFilterWeight = 0.85;
        
        // Track if we're getting data
        this.hasGyroData = false;
        this.hasAccelData = false;
        this.hasOrientationData = false;
        this.hasMagData = false;
        this._loggedNoAccel = false;
        this._debugCounter = 0;
        
        // Callbacks
        this.onUpdate = null;
        this.onError = null;
        
        // Bind methods
        this.handleMotion = this.handleMotion.bind(this);
        this.handleOrientation = this.handleOrientation.bind(this);
    }
    
    startAbsoluteOrientationSensor() {
        if (!('AbsoluteOrientationSensor' in window)) {
            console.log('AbsoluteOrientationSensor not supported in this browser.');
            return;
        }

        try {
            const sensor = new AbsoluteOrientationSensor({ frequency: 60, referenceFrame: 'device' });
            sensor.onreading = () => this.handleAbsoluteOrientationSensor(sensor);
            sensor.onerror = (event) => {
                console.warn('AbsoluteOrientationSensor error:', event.error || event.name);
            };
            sensor.start();
            this.absoluteSensor = sensor;
            this.usingAbsoluteSensor = true;
            this.useGyroIntegration = false; // Use high fidelity orientation when available
            console.log('✅ AbsoluteOrientationSensor started');
        } catch (error) {
            console.warn('Absolute orientation sensor init failed:', error);
            this.absoluteSensor = null;
            this.usingAbsoluteSensor = false;
        }
    }

    handleAbsoluteOrientationSensor(sensor) {
        if (!sensor || !sensor.quaternion) return;

        const [qx, qy, qz, qw] = sensor.quaternion;
        if ([qx, qy, qz, qw].some((value) => value === null || Number.isNaN(value))) {
            return;
        }

        const ysqr = qy * qy;

        const t0 = 2 * (qw * qx + qy * qz);
        const t1 = 1 - 2 * (qx * qx + ysqr);
        const roll = Math.atan2(t0, t1);

        let t2 = 2 * (qw * qy - qz * qx);
        t2 = Math.min(1, Math.max(-1, t2));
        const pitch = Math.asin(t2);

        const t3 = 2 * (qw * qz + qx * qy);
        const t4 = 1 - 2 * (ysqr + qz * qz);
        const yaw = Math.atan2(t3, t4);

        const alpha = this.wrapAngle360(this.radiansToDegrees(yaw));
        const beta = this.normalizeAngle(this.radiansToDegrees(pitch));
        const gamma = this.normalizeAngle(this.radiansToDegrees(roll));

        this.hasOrientationData = true;
        this.nativeOrientation = { alpha, beta, gamma };
        this.current.apiOrientation = {
            alpha: this.roundToDecimal(alpha),
            beta: this.roundToDecimal(beta),
            gamma: this.roundToDecimal(gamma)
        };

        // Absolute sensor already handles drift; no need for manual fusion
        this.current.orientation = {
            alpha: this.cleanValue(alpha),
            beta: this.cleanValue(beta),
            gamma: this.cleanValue(gamma)
        };

        if (this.onUpdate) {
            this.onUpdate(this.getData());
        }
    }

    startMagnetometerSensor() {
        if (!('Magnetometer' in window)) {
            console.log('Magnetometer API not supported in this browser.');
            return;
        }

        try {
            const sensor = new Magnetometer({ frequency: 30 });
            sensor.onreading = () => this.handleMagnetometerSensor(sensor);
            sensor.onerror = (event) => {
                console.warn('Magnetometer error:', event.error || event.name);
            };
            sensor.start();
            this.magnetometerSensor = sensor;
            console.log('✅ Magnetometer sensor started');
        } catch (error) {
            console.warn('Magnetometer sensor init failed:', error);
            this.magnetometerSensor = null;
        }
    }

    handleMagnetometerSensor(sensor) {
        if (!sensor) return;

        const { x, y, z } = sensor;
        if ([x, y, z].some((value) => value === null || value === undefined || Number.isNaN(value))) {
            return;
        }

        // Basic tilt compensation using current accel orientation when available
        let headingRad;
        if (this.hasAccelData) {
            const accelAngles = this.getAccelerometerAngles();
            const pitchRad = accelAngles.beta * (Math.PI / 180);
            const rollRad = accelAngles.gamma * (Math.PI / 180);

            const compensatedX = x * Math.cos(pitchRad) + z * Math.sin(pitchRad);
            const compensatedY = x * Math.sin(rollRad) * Math.sin(pitchRad) + y * Math.cos(rollRad) - z * Math.sin(rollRad) * Math.cos(pitchRad);
            headingRad = Math.atan2(-compensatedY, compensatedX);
        } else {
            headingRad = Math.atan2(y, x);
        }

        let headingDeg = this.wrapAngle360(this.radiansToDegrees(headingRad));

        if (this.filteredHeading === null) {
            this.filteredHeading = headingDeg;
        } else {
            const smoothed = this.smoothHeading(headingDeg, this.filteredHeading, this.magnetometerFilterWeight);
            this.filteredHeading = smoothed;
        }

        const filteredHeading = this.filteredHeading ?? headingDeg;

        this.hasMagData = true;
        this.current.magnetometer = {
            heading: this.roundToDecimal(filteredHeading),
            raw: headingDeg,
            available: true,
            source: 'GenericSensor'
        };

        if (this.useGyroIntegration) {
            const correction = this.normalizeAngle(filteredHeading - this.integratedAngles.alpha);
            this.integratedAngles.alpha = this.wrapAngle360(
                this.integratedAngles.alpha + this.yawCorrectionWeight * correction
            );
            this.current.orientation.alpha = this.cleanValue(this.integratedAngles.alpha);
        }

        if (this.onUpdate) {
            this.onUpdate(this.getData());
        }
    }

    /**
     * Request permissions and start sensors
     */
    async start() {
        try {
            console.log('Starting motion sensors...');
            
            // Request permission for iOS 13+
            if (typeof DeviceMotionEvent.requestPermission === 'function') {
                console.log('Requesting iOS motion permission...');
                const motionPermission = await DeviceMotionEvent.requestPermission();
                if (motionPermission !== 'granted') {
                    throw new Error('Motion permission denied');
                }
            }
            
            if (typeof DeviceOrientationEvent.requestPermission === 'function') {
                console.log('Requesting iOS orientation permission...');
                const orientationPermission = await DeviceOrientationEvent.requestPermission();
                if (orientationPermission !== 'granted') {
                    throw new Error('Orientation permission denied');
                }
            }
            
            // For Android/MIUI - check if sensors are available
            if (this.isAndroid || this.isMIUI) {
                console.log('Android/MIUI detected - checking sensor availability...');
                
                // Test if DeviceMotionEvent fires
                const motionTest = new Promise((resolve) => {
                    const timeout = setTimeout(() => resolve(false), 1000);
                    const handler = () => {
                        clearTimeout(timeout);
                        window.removeEventListener('devicemotion', handler);
                        resolve(true);
                    };
                    window.addEventListener('devicemotion', handler);
                });
                
                const hasMotion = await motionTest;
                console.log('Motion sensor available:', hasMotion);
            }
            
            window.addEventListener('devicemotion', this.handleMotion);
            window.addEventListener('deviceorientation', this.handleOrientation);
            
            this.isActive = true;

            // Attempt to start higher fidelity sensors if available
            this.startAbsoluteOrientationSensor();
            this.startMagnetometerSensor();
            
            // Auto-calibrate after 1 second (longer for MIUI)
            const calibrationDelay = this.isMIUI ? 1000 : 500;
            setTimeout(() => {
                if (this.hasOrientationData || this.hasGyroData) {
                    this.calibrate();
                    console.log('Auto-calibration complete');
                } else {
                    console.warn('No sensor data received yet');
                }
            }, calibrationDelay);
            
            return { success: true, message: 'Motion sensors started' };
        } catch (error) {
            console.error('Sensor start error:', error);
            if (this.onError) this.onError(error);
            return { success: false, message: error.message };
        }
    }
    
    /**
     * Stop all sensors
     */
    stop() {
        window.removeEventListener('devicemotion', this.handleMotion);
        window.removeEventListener('deviceorientation', this.handleOrientation);
        this.isActive = false;
        this.calibrated = false;
        this.hasMagData = false;
        this.hasAccelData = false;
        this.hasGyroData = false;
    this.hasOrientationData = false;
    this.current.magnetometer = { heading: 0, raw: 0, available: false, source: 'none' };
        this.current.apiOrientation = { alpha: 0, beta: 0, gamma: 0 };
    this.nativeOrientation = { alpha: 0, beta: 0, gamma: 0 };
        this.lastGyroTimestamp = null;
    this.lastOrientationUpdate = 0;
        this.filteredHeading = null;
    this.gyroBias = { alpha: 0, beta: 0, gamma: 0 };

        if (this.absoluteSensor) {
            try { this.absoluteSensor.stop(); } catch (err) {
                console.warn('AbsoluteOrientationSensor stop error:', err);
            }
            this.absoluteSensor.onreading = null;
            this.absoluteSensor.onerror = null;
            this.absoluteSensor = null;
        }

        if (this.magnetometerSensor) {
            try { this.magnetometerSensor.stop(); } catch (err) {
                console.warn('Magnetometer stop error:', err);
            }
            this.magnetometerSensor.onreading = null;
            this.magnetometerSensor.onerror = null;
            this.magnetometerSensor = null;
        }

        this.usingAbsoluteSensor = false;
        this.useGyroIntegration = this.isMIUI;
    }
    
    /**
     * Calibrate - set current position as zero point
     */
    calibrate() {
        if (this.useGyroIntegration) {
            // Initialize accelerometer filter with current values
            if (this.hasAccelData) {
                this.filteredAccel = { ...this.current.accel };
                
                // Initialize orientation from accelerometer
                const accelAngles = this.getAccelerometerAngles();
                let initialAlpha = 0;
                if (this.hasMagData && this.current.magnetometer.available) {
                    initialAlpha = (typeof this.current.magnetometer.raw === 'number') ?
                        this.current.magnetometer.raw : this.current.magnetometer.heading;
                } else if (this.hasOrientationData && typeof this.nativeOrientation.alpha === 'number') {
                    initialAlpha = this.wrapAngle360(this.nativeOrientation.alpha);
                }
                this.integratedAngles = { 
                    alpha: initialAlpha,
                    beta: accelAngles.beta, 
                    gamma: accelAngles.gamma 
                };
                
                this.current.orientation = {
                    alpha: this.cleanValue(this.integratedAngles.alpha),
                    beta: this.cleanValue(this.integratedAngles.beta),
                    gamma: this.cleanValue(this.integratedAngles.gamma)
                };
                
                console.log('🔧 Sensor fusion initialized with accel angles:', accelAngles);
                if (this.hasMagData && this.current.magnetometer.available) {
                    console.log('🧭 Magnetometer heading locked at calibration:', this.current.magnetometer.heading);
                }
            }
            
            // Reset timestamp to start integration
            this.lastGyroTimestamp = Date.now();
            console.log('🔧 Gyro integration ready - timestamp set');
        }
        
        // Store current orientation as zero reference for all axes
        this.zeroPoint = {
            alpha: this.current.orientation.alpha,
            beta: this.current.orientation.beta,
            gamma: this.current.orientation.gamma
        };
        
        this.calibrated = true;
        console.log('✅ Motion sensor calibrated - zero point:', this.zeroPoint);
        console.log('📊 Current orientation:', this.current.orientation);
    }
    
    /**
     * Normalize angle to -180 to 180 range
     */
    normalizeAngle(angle) {
        while (angle > 180) angle -= 360;
        while (angle < -180) angle += 360;
        return angle;
    }

    wrapAngle360(angle) {
        if (angle === null || angle === undefined || Number.isNaN(angle)) return 0;
        let wrapped = angle % 360;
        if (wrapped < 0) wrapped += 360;
        return wrapped;
    }

    roundToDecimal(value) {
        if (value === null || value === undefined || Number.isNaN(value)) return 0;
        return Math.round(value * 10) / 10;
    }

    radiansToDegrees(radians) {
        return radians * (180 / Math.PI);
    }

    smoothHeading(current, previous, factor) {
        if (previous === null || previous === undefined) return current;
        const diff = this.normalizeAngle(current - previous);
        return this.wrapAngle360(previous + diff * (1 - factor));
    }

    updateBias(currentBias, measurement, rate) {
        return currentBias * (1 - rate) + measurement * rate;
    }
    
    /**
     * Apply smoothing filter to reduce noise
     */
    smoothValue(current, previous, factor) {
        return previous * factor + current * (1 - factor);
    }
    
    /**
     * Handle device motion (gyroscope and accelerometer)
     */
    handleMotion(event) {
        if (!this.isActive) return;

        const currentTime = Date.now();

        // Mark that motion data is flowing
        this.hasGyroData = true;

        // Accelerometer data - processed first for tilt reference
        let accelAngles = null;
        let accelMagnitude = null;
        if (event.accelerationIncludingGravity) {
            this.hasAccelData = true;
            if (this._loggedNoAccel) this._loggedNoAccel = false;

            const x = event.accelerationIncludingGravity.x || 0;
            const y = event.accelerationIncludingGravity.y || 0;
            const z = event.accelerationIncludingGravity.z || 0;

            // Smooth accelerometer data (reduce noise)
            this.filteredAccel.x = this.filteredAccel.x * this.accelFilterWeight + x * (1 - this.accelFilterWeight);
            this.filteredAccel.y = this.filteredAccel.y * this.accelFilterWeight + y * (1 - this.accelFilterWeight);
            this.filteredAccel.z = this.filteredAccel.z * this.accelFilterWeight + z * (1 - this.accelFilterWeight);

            this.current.accel = {
                x: this.cleanValue(this.filteredAccel.x),
                y: this.cleanValue(this.filteredAccel.y),
                z: this.cleanValue(this.filteredAccel.z)
            };

            accelAngles = this.getAccelerometerAngles();
            accelMagnitude = Math.sqrt(
                this.filteredAccel.x * this.filteredAccel.x +
                this.filteredAccel.y * this.filteredAccel.y +
                this.filteredAccel.z * this.filteredAccel.z
            );
        }

        // Gyroscope (rotation rate in degrees/second)
        let rawAlpha = 0;
        let rawBeta = 0;
        let rawGamma = 0;
        if (event.rotationRate) {
            rawAlpha = event.rotationRate.alpha ?? 0;
            rawBeta = event.rotationRate.beta ?? 0;
            rawGamma = event.rotationRate.gamma ?? 0;

            const rotationMagnitude = Math.abs(rawAlpha) + Math.abs(rawBeta) + Math.abs(rawGamma);
            const accelDeviation = accelMagnitude !== null ? Math.abs(accelMagnitude - this.gravity) : null;
            const isStationary = rotationMagnitude < this.stationaryRotationThreshold &&
                (accelDeviation === null || accelDeviation < this.stationaryAccelThreshold);

            if (isStationary) {
                this.gyroBias.alpha = this.updateBias(this.gyroBias.alpha, rawAlpha, this.biasLearningRate);
                this.gyroBias.beta = this.updateBias(this.gyroBias.beta, rawBeta, this.biasLearningRate);
                this.gyroBias.gamma = this.updateBias(this.gyroBias.gamma, rawGamma, this.biasLearningRate);
            }

            const correctedAlphaRaw = rawAlpha - this.gyroBias.alpha;
            const correctedBetaRaw = rawBeta - this.gyroBias.beta;
            const correctedGammaRaw = rawGamma - this.gyroBias.gamma;

            // Apply drift threshold for display purposes
            const alpha = Math.abs(correctedAlphaRaw) > this.driftThreshold ? correctedAlphaRaw : 0;
            const beta = Math.abs(correctedBetaRaw) > this.driftThreshold ? correctedBetaRaw : 0;
            const gamma = Math.abs(correctedGammaRaw) > this.driftThreshold ? correctedGammaRaw : 0;

            this.current.gyro = {
                alpha: this.cleanValue(alpha),
                beta: this.cleanValue(beta),
                gamma: this.cleanValue(gamma)
            };
        }

        // SENSOR FUSION: Gyroscope integration + Accelerometer + Magnetometer correction
        if (this.useGyroIntegration) {
            if (!this.hasAccelData) {
                if (!this._loggedNoAccel) {
                    console.log('⏳ Waiting for accelerometer data before starting fusion...');
                    this._loggedNoAccel = true;
                }
                return;
            }

            if (!this.lastGyroTimestamp) {
                this.lastGyroTimestamp = currentTime;
                return;
            }

            const dt = (currentTime - this.lastGyroTimestamp) / 1000; // seconds
            this.lastGyroTimestamp = currentTime;

            if (dt > 0) {
                // Integrate raw gyroscope (primary orientation source)
                const correctedAlphaRaw = rawAlpha - this.gyroBias.alpha;
                const correctedBetaRaw = rawBeta - this.gyroBias.beta;
                const correctedGammaRaw = rawGamma - this.gyroBias.gamma;

                this.integratedAngles.alpha += correctedAlphaRaw * dt;
                this.integratedAngles.beta += correctedBetaRaw * dt;
                this.integratedAngles.gamma += correctedGammaRaw * dt;
            }

            if (accelAngles) {
                // Complementary filter: accelerometer corrects pitch/roll drift
                this.integratedAngles.beta = this.gyroWeight * this.integratedAngles.beta +
                                              (1 - this.gyroWeight) * accelAngles.beta;
                this.integratedAngles.gamma = this.gyroWeight * this.integratedAngles.gamma +
                                               (1 - this.gyroWeight) * accelAngles.gamma;
            }

            // Magnetometer correction for yaw when available
            if (this.hasMagData && this.current.magnetometer.available) {
                const heading = (typeof this.current.magnetometer.raw === 'number') ?
                    this.current.magnetometer.raw : this.current.magnetometer.heading;
                const headingDiff = this.normalizeAngle(heading - this.integratedAngles.alpha);
                this.integratedAngles.alpha = this.wrapAngle360(
                    this.integratedAngles.alpha + this.yawCorrectionWeight * headingDiff
                );
            } else if (
                this.hasOrientationData &&
                typeof this.nativeOrientation.alpha === 'number' &&
                !Number.isNaN(this.nativeOrientation.alpha) &&
                currentTime - this.lastOrientationUpdate < 750
            ) {
                const orientationHeading = this.wrapAngle360(this.nativeOrientation.alpha);
                const orientationDiff = this.normalizeAngle(orientationHeading - this.integratedAngles.alpha);
                this.integratedAngles.alpha = this.wrapAngle360(
                    this.integratedAngles.alpha + this.orientationCorrectionWeight * orientationDiff
                );
            } else {
                this.integratedAngles.alpha = this.wrapAngle360(this.integratedAngles.alpha);
            }

            // Keep beta and gamma bounded
            this.integratedAngles.beta = this.normalizeAngle(this.integratedAngles.beta);
            this.integratedAngles.gamma = this.normalizeAngle(this.integratedAngles.gamma);

            // Update current orientation with fused values
            this.current.orientation = {
                alpha: this.cleanValue(this.integratedAngles.alpha),
                beta: this.cleanValue(this.integratedAngles.beta),
                gamma: this.cleanValue(this.integratedAngles.gamma)
            };

            // Debug log every 50 updates to trace fusion health
            if (!this._debugCounter) this._debugCounter = 0;
            this._debugCounter++;
            if (this._debugCounter % 50 === 0) {
                console.log('📊 Sensor Fusion Update #' + this._debugCounter + ':', {
                    integrated: { ...this.integratedAngles },
                    accelAngles,
                    magnetometer: this.current.magnetometer
                });
            }

            // Trigger update with fused orientation (even before calibration)
            if (this.onUpdate) {
                this.onUpdate(this.getData());
            }
        } else if (this.onUpdate) {
            // Non-MIUI devices rely on the orientation event, but keep data flowing
            this.onUpdate(this.getData());
        }
    }
    
    /**
     * Calculate pitch (beta) and roll (gamma) from accelerometer
     * Uses gravity vector to determine phone tilt - NO DRIFT!
     */
    getAccelerometerAngles() {
        const ax = this.filteredAccel.x;
        const ay = this.filteredAccel.y;
        const az = this.filteredAccel.z;
        
        // Calculate pitch (rotation around X-axis) - beta
        // Range: -180 to 180 degrees
        const pitch = Math.atan2(ay, Math.sqrt(ax * ax + az * az)) * (180 / Math.PI);
        
        // Calculate roll (rotation around Y-axis) - gamma
        // Range: -180 to 180 degrees
        const roll = Math.atan2(-ax, az) * (180 / Math.PI);
        
        return {
            beta: pitch,
            gamma: roll,
            alpha: 0 // Accelerometer can't measure yaw/compass heading
        };
    }
    
    /**
     * Handle device orientation
     */
    handleOrientation(event) {
        if (!this.isActive) return;
        
        this.hasOrientationData = true;
        
        // Get raw values
        const rawAlpha = typeof event.alpha === 'number' ? event.alpha : null;
        const rawBeta = typeof event.beta === 'number' ? event.beta : null;
        const rawGamma = typeof event.gamma === 'number' ? event.gamma : null;

        // Preserve native orientation for diagnostics/UI
        this.nativeOrientation = {
            alpha: rawAlpha,
            beta: rawBeta,
            gamma: rawGamma
        };
        this.lastOrientationUpdate = Date.now();
        this.current.apiOrientation = {
            alpha: this.roundToDecimal(rawAlpha ?? 0),
            beta: this.roundToDecimal(rawBeta ?? 0),
            gamma: this.roundToDecimal(rawGamma ?? 0)
        };
        
        // Log first orientation reading for debugging
        if (!this.previousOrientation.beta && !this.previousOrientation.gamma) {
            console.log('First orientation reading:', {
                alpha: rawAlpha,
                beta: rawBeta,
                gamma: rawGamma,
                alphaNull: rawAlpha === null,
                betaNull: rawBeta === null,
                gammaNull: rawGamma === null,
                isMIUI: this.isMIUI
            });
            
            // Enable gyroscope integration for MIUI devices
            if (this.isMIUI) {
                console.log('🔧 MIUI detected - Using gyroscope integration for orientation');
                this.useGyroIntegration = true;
            }
        }
        
        // Magnetometer heading extraction (webkitCompassHeading on iOS / absolute alpha elsewhere)
        let heading = null;
        let headingSource = null;
        if (typeof event.webkitCompassHeading === 'number') {
            heading = event.webkitCompassHeading;
            headingSource = 'webkit';
        } else if (event.absolute === true && rawAlpha !== null) {
            heading = rawAlpha;
            headingSource = 'absolute';
        }

        if (heading !== null) {
            const wrappedHeading = this.wrapAngle360(heading);
            this.hasMagData = true;
            if (this.filteredHeading === null) {
                this.filteredHeading = wrappedHeading;
            } else {
                this.filteredHeading = this.smoothHeading(wrappedHeading, this.filteredHeading, this.magnetometerFilterWeight);
            }
            this.current.magnetometer = {
                heading: this.roundToDecimal(this.filteredHeading ?? wrappedHeading),
                raw: wrappedHeading,
                available: true,
                source: headingSource || 'unknown'
            };
            if (this.useGyroIntegration) {
                const correction = this.normalizeAngle((this.filteredHeading ?? wrappedHeading) - this.integratedAngles.alpha);
                this.integratedAngles.alpha = this.wrapAngle360(
                    this.integratedAngles.alpha + this.yawCorrectionWeight * correction
                );
            }
        }

        if (this.usingAbsoluteSensor) {
            // AbsoluteOrientationSensor already updates orientation; only propagate magnetometer/debug info
            if (this.onUpdate) {
                this.onUpdate(this.getData());
            }
            return;
        }

        let alpha = rawAlpha ?? this.previousOrientation.alpha;
        let beta = rawBeta ?? this.previousOrientation.beta;
        let gamma = rawGamma ?? this.previousOrientation.gamma;

        if (this.useGyroIntegration) {
            // Keep orientation driven by fusion, but allow orientation event to prime beta/gamma if needed
            alpha = this.integratedAngles.alpha;
            beta = this.integratedAngles.beta;
            gamma = this.integratedAngles.gamma;

            this.current.orientation = {
                alpha: this.cleanValue(alpha),
                beta: this.cleanValue(beta),
                gamma: this.cleanValue(gamma)
            };

            // If magnetometer updated but no motion event fired yet, push update for UI
            if (this.onUpdate && this.current.magnetometer.available) {
                this.onUpdate(this.getData());
            }
        } else {
            // Non-MIUI: use orientation API directly with smoothing
            alpha = (alpha ?? 0);
            beta = (beta ?? 0);
            gamma = (gamma ?? 0);

            // Handle alpha wraparound (0-360 degrees)
            let alphaDiff = alpha - this.previousOrientation.alpha;
            if (alphaDiff > 180) alphaDiff -= 360;
            if (alphaDiff < -180) alphaDiff += 360;

            // Smooth alpha with wraparound handling
            alpha = this.previousOrientation.alpha + alphaDiff * (1 - this.smoothingFactor);
            alpha = this.wrapAngle360(alpha);

            // Smooth beta and gamma normally
            beta = this.smoothValue(beta, this.previousOrientation.beta, this.smoothingFactor);
            gamma = this.smoothValue(gamma, this.previousOrientation.gamma, this.smoothingFactor);

            this.current.orientation = {
                alpha: this.cleanValue(alpha),
                beta: this.cleanValue(beta),
                gamma: this.cleanValue(gamma)
            };

            if (this.onUpdate) {
                this.onUpdate(this.getData());
            }
        }

        this.previousOrientation = {
            alpha: this.cleanValue(alpha),
            beta: this.cleanValue(beta),
            gamma: this.cleanValue(gamma)
        };
    }
    
    /**
     * Clean value to 1 decimal place, treating values < 0.05 as zero
     */
    cleanValue(value) {
        if (!value || Math.abs(value) < 0.1) return 0; // Increased threshold from 0.05 to 0.1
        return Math.round(value * 10) / 10;
    }
    
    /**
     * Get relative angles (calibrated to zero point)
     */
    getRelativeAngles() {
        if (!this.calibrated) {
            return {
                alpha: 0,
                beta: 0,
                gamma: 0
            };
        }
        
        // All angles from orientation API relative to calibration point
        let relativeAlpha = this.current.orientation.alpha - this.zeroPoint.alpha;
        
        // Normalize alpha (handles 0-360 wraparound)
        relativeAlpha = this.normalizeAngle(relativeAlpha);
        
        return {
            alpha: this.cleanValue(relativeAlpha),
            beta: this.cleanValue(this.current.orientation.beta - this.zeroPoint.beta),
            gamma: this.cleanValue(this.current.orientation.gamma - this.zeroPoint.gamma)
        };
    }
    
    /**
     * Get all sensor data
     */
    getData() {
        return {
            gyro: this.current.gyro,
            accel: this.current.accel,
            orientation: {
                absolute: this.current.orientation,
                relative: this.getRelativeAngles(),
                api: this.current.apiOrientation
            },
            magnetometer: this.current.magnetometer,
            calibrated: this.calibrated
        };
    }
}

// Export for use in main app
window.MotionSensor = MotionSensor;
