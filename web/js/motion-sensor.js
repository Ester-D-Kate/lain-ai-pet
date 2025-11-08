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
            orientation: { alpha: 0, beta: 0, gamma: 0 }
        };
        
        // Smoothing - lighter for Xiaomi phones
        this.smoothingFactor = this.isMIUI ? 0.7 : 0.85;
        this.previousOrientation = { alpha: 0, beta: 0, gamma: 0 };
        
        // Drift compensation - stricter for Xiaomi
        this.driftThreshold = this.isMIUI ? 0.2 : 0.15;
        
        // Gyroscope integration (for MIUI devices)
        this.useGyroIntegration = this.isMIUI;
        this.integratedAngles = { alpha: 0, beta: 0, gamma: 0 };
        this.lastGyroTimestamp = null;
        
        // Sensor fusion - complementary filter weights
        // Higher gyro weight = more responsive, lower = more drift correction
        this.gyroWeight = 0.98; // 98% gyro, 2% accel/mag correction
        this.accelFilterWeight = 0.9; // Smoothing for accelerometer
        this.filteredAccel = { x: 0, y: 0, z: 0 };
        
        // Track if we're getting data
        this.hasGyroData = false;
        this.hasAccelData = false;
        this.hasOrientationData = false;
        
        // Callbacks
        this.onUpdate = null;
        this.onError = null;
        
        // Bind methods
        this.handleMotion = this.handleMotion.bind(this);
        this.handleOrientation = this.handleOrientation.bind(this);
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
                this.integratedAngles = { 
                    alpha: 0,  // Can't get from accel
                    beta: accelAngles.beta, 
                    gamma: accelAngles.gamma 
                };
                
                this.current.orientation = {
                    alpha: 0,
                    beta: this.cleanValue(this.integratedAngles.beta),
                    gamma: this.cleanValue(this.integratedAngles.gamma)
                };
                
                console.log('🔧 Sensor fusion initialized with accel angles:', accelAngles);
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
        
        this.hasGyroData = true;
        const currentTime = Date.now();
        
        // Accelerometer data - PROCESS FIRST for drift correction
        if (event.accelerationIncludingGravity) {
            this.hasAccelData = true;
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
        }
        
        // Gyroscope (rotation rate in degrees/second)
        if (event.rotationRate) {
            const rawAlpha = event.rotationRate.alpha || 0;
            const rawBeta = event.rotationRate.beta || 0;
            const rawGamma = event.rotationRate.gamma || 0;
            
            // Apply drift threshold - ignore tiny movements
            const alpha = Math.abs(rawAlpha) > this.driftThreshold ? rawAlpha : 0;
            const beta = Math.abs(rawBeta) > this.driftThreshold ? rawBeta : 0;
            const gamma = Math.abs(rawGamma) > this.driftThreshold ? rawGamma : 0;
            
            // Store for display
            this.current.gyro = {
                alpha: this.cleanValue(alpha),
                beta: this.cleanValue(beta),
                gamma: this.cleanValue(gamma)
            };
            
            // SENSOR FUSION: Gyroscope integration + Accelerometer correction
            if (this.useGyroIntegration && this.calibrated && this.hasAccelData) {
                const dt = (currentTime - this.lastGyroTimestamp) / 1000; // seconds
                
                // Step 1: Integrate gyroscope (primary orientation source)
                this.integratedAngles.alpha += rawAlpha * dt;
                this.integratedAngles.beta += rawBeta * dt;
                this.integratedAngles.gamma += rawGamma * dt;
                
                // Step 2: Calculate orientation from accelerometer (drift correction)
                const accelAngles = this.getAccelerometerAngles();
                
                // Step 3: Complementary filter - blend gyro and accel
                // Alpha stays with gyro (no accel reference for Z rotation)
                // Beta and Gamma corrected by accelerometer
                this.integratedAngles.beta = this.gyroWeight * this.integratedAngles.beta + 
                                              (1 - this.gyroWeight) * accelAngles.beta;
                this.integratedAngles.gamma = this.gyroWeight * this.integratedAngles.gamma + 
                                               (1 - this.gyroWeight) * accelAngles.gamma;
                
                // Normalize alpha to 0-360
                while (this.integratedAngles.alpha < 0) this.integratedAngles.alpha += 360;
                while (this.integratedAngles.alpha >= 360) this.integratedAngles.alpha -= 360;
                
                // Keep beta and gamma in -180 to 180
                this.integratedAngles.beta = this.normalizeAngle(this.integratedAngles.beta);
                this.integratedAngles.gamma = this.normalizeAngle(this.integratedAngles.gamma);
                
                // Update current orientation with fused values
                this.current.orientation = {
                    alpha: this.cleanValue(this.integratedAngles.alpha),
                    beta: this.cleanValue(this.integratedAngles.beta),
                    gamma: this.cleanValue(this.integratedAngles.gamma)
                };
                
                // Debug log every 50 updates
                if (!this._debugCounter) this._debugCounter = 0;
                this._debugCounter++;
                if (this._debugCounter % 50 === 0) {
                    console.log('📊 Sensor Fusion Update #' + this._debugCounter + ':', {
                        integrated: this.integratedAngles,
                        current: this.current.orientation,
                        accelAngles: accelAngles
                    });
                }
                
                // Update timestamp for next iteration
                this.lastGyroTimestamp = currentTime;
                
                // Trigger update with integrated orientation
                if (this.onUpdate) {
                    this.onUpdate(this.getData());
                }
            } else if (this.useGyroIntegration && !this.calibrated) {
                // Waiting for calibration
                if (!this._loggedWaiting) {
                    console.log('⏳ Waiting for calibration to start sensor fusion...');
                    this._loggedWaiting = true;
                }
            } else if (this.useGyroIntegration && !this.hasAccelData) {
                // Waiting for accelerometer data
                if (!this._loggedNoAccel) {
                    console.log('⏳ Waiting for accelerometer data...');
                    this._loggedNoAccel = true;
                }
            }
        }
        
        // Trigger update for non-MIUI devices
        if (!this.useGyroIntegration && this.onUpdate) {
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
        let rawAlpha = event.alpha;
        let rawBeta = event.beta;
        let rawGamma = event.gamma;
        
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
        
        // Use gyroscope integration for MIUI devices
        if (this.useGyroIntegration) {
            // Use integrated gyroscope data instead of orientation API
            alpha = this.integratedAngles.alpha;
            beta = this.integratedAngles.beta;
            gamma = this.integratedAngles.gamma;
        } else {
            // Use orientation API for non-MIUI devices
            alpha = rawAlpha || 0;
            beta = rawBeta || 0;
            gamma = rawGamma || 0;
            
            // Handle alpha wraparound (0-360 degrees)
            let alphaDiff = alpha - this.previousOrientation.alpha;
            if (alphaDiff > 180) alphaDiff -= 360;
            if (alphaDiff < -180) alphaDiff += 360;
            
            // Smooth alpha with wraparound handling
            alpha = this.previousOrientation.alpha + alphaDiff * (1 - this.smoothingFactor);
            if (alpha < 0) alpha += 360;
            if (alpha >= 360) alpha -= 360;
            
            // Smooth beta and gamma normally
            beta = this.smoothValue(beta, this.previousOrientation.beta, this.smoothingFactor);
            gamma = this.smoothValue(gamma, this.previousOrientation.gamma, this.smoothingFactor);
        }
        
        this.previousOrientation = { alpha, beta, gamma };
        
        // Store values
        this.current.orientation = {
            alpha: this.cleanValue(alpha),
            beta: this.cleanValue(beta),
            gamma: this.cleanValue(gamma)
        };
        
        // Trigger update even without motion event (important for MIUI)
        if (this.onUpdate && this.calibrated) {
            this.onUpdate(this.getData());
        }
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
                relative: this.getRelativeAngles()
            },
            calibrated: this.calibrated
        };
    }
}

// Export for use in main app
window.MotionSensor = MotionSensor;
