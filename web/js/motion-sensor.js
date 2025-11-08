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
        
        // Track if we're getting data
        this.hasGyroData = false;
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
        // Store current orientation as zero reference for all axes
        this.zeroPoint = {
            alpha: this.current.orientation.alpha,
            beta: this.current.orientation.beta,
            gamma: this.current.orientation.gamma
        };
        
        this.calibrated = true;
        console.log('Motion sensor calibrated - zero point:', this.zeroPoint);
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
        
        // Gyroscope (rotation rate in degrees/second) - for display only
        if (event.rotationRate) {
            const rawAlpha = event.rotationRate.alpha || 0;
            const rawBeta = event.rotationRate.beta || 0;
            const rawGamma = event.rotationRate.gamma || 0;
            
            // Log first gyro reading for debugging
            if (!this.hasGyroData) {
                console.log('First gyro reading:', { rawAlpha, rawBeta, rawGamma });
            }
            
            // Apply drift threshold - ignore tiny movements
            const alpha = Math.abs(rawAlpha) > this.driftThreshold ? rawAlpha : 0;
            const beta = Math.abs(rawBeta) > this.driftThreshold ? rawBeta : 0;
            const gamma = Math.abs(rawGamma) > this.driftThreshold ? rawGamma : 0;
            
            // Store for display only (not used for angle calculation)
            this.current.gyro = {
                alpha: this.cleanValue(alpha),
                beta: this.cleanValue(beta),
                gamma: this.cleanValue(gamma)
            };
        }
        
        // Accelerometer
        if (event.accelerationIncludingGravity) {
            this.current.accel = {
                x: this.cleanValue(event.accelerationIncludingGravity.x),
                y: this.cleanValue(event.accelerationIncludingGravity.y),
                z: this.cleanValue(event.accelerationIncludingGravity.z)
            };
        }
        
        if (this.onUpdate) {
            this.onUpdate(this.getData());
        }
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
        }
        
        // Check if alpha is available
        if (rawAlpha === null || rawAlpha === undefined) {
            console.warn('⚠️ Alpha not available on this device! Using fallback.');
            rawAlpha = this.previousOrientation.alpha || 0;
        }
        
        // Get all three orientation angles (or defaults)
        let alpha = rawAlpha || 0;
        let beta = rawBeta || 0;
        let gamma = rawGamma || 0;
        
        // MIUI FIX: Alpha has severe drift on MIUI devices
        // Detect when device is stationary and lock alpha
        if (this.isMIUI && this.calibrated) {
            const betaDiff = Math.abs(beta - this.previousOrientation.beta);
            const gammaDiff = Math.abs(gamma - this.previousOrientation.gamma);
            
            // If beta and gamma are stable (device not moving), lock alpha
            if (betaDiff < 0.1 && gammaDiff < 0.1) {
                // Device is stationary - keep alpha locked
                alpha = this.previousOrientation.alpha || 0;
            }
        }
        
        // Handle alpha wraparound (0-360 degrees)
        let alphaDiff = alpha - this.previousOrientation.alpha;
        if (alphaDiff > 180) alphaDiff -= 360;
        if (alphaDiff < -180) alphaDiff += 360;
        
        // Smooth alpha with wraparound handling
        let smoothedAlpha = this.previousOrientation.alpha + alphaDiff * (1 - this.smoothingFactor);
        if (smoothedAlpha < 0) smoothedAlpha += 360;
        if (smoothedAlpha >= 360) smoothedAlpha -= 360;
        
        // Smooth beta and gamma normally
        beta = this.smoothValue(beta, this.previousOrientation.beta, this.smoothingFactor);
        gamma = this.smoothValue(gamma, this.previousOrientation.gamma, this.smoothingFactor);
        
        this.previousOrientation = { alpha: smoothedAlpha, beta, gamma };
        
        // Store values
        this.current.orientation = {
            alpha: this.cleanValue(smoothedAlpha),
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
