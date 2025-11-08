/**
 * Motion Sensor Module
 * Handles gyroscope, accelerometer, and orientation with zero-based calibration
 */

class MotionSensor {
    constructor() {
        this.isActive = false;
        this.calibrated = false;
        
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
        
        // Smoothing filter
        this.smoothingFactor = 0.9; // Higher = more smoothing (reduced from 0.8 for stability)
        this.previousOrientation = { alpha: 0, beta: 0, gamma: 0 };
        
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
            // Request permission for iOS 13+
            if (typeof DeviceMotionEvent.requestPermission === 'function') {
                const motionPermission = await DeviceMotionEvent.requestPermission();
                if (motionPermission !== 'granted') {
                    throw new Error('Motion permission denied');
                }
            }
            
            if (typeof DeviceOrientationEvent.requestPermission === 'function') {
                const orientationPermission = await DeviceOrientationEvent.requestPermission();
                if (orientationPermission !== 'granted') {
                    throw new Error('Orientation permission denied');
                }
            }
            
            window.addEventListener('devicemotion', this.handleMotion);
            window.addEventListener('deviceorientation', this.handleOrientation);
            
            this.isActive = true;
            
            // Auto-calibrate after 500ms
            setTimeout(() => this.calibrate(), 500);
            
            return { success: true, message: 'Motion sensors started' };
        } catch (error) {
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
        this.zeroPoint = {
            alpha: this.current.orientation.alpha,
            beta: this.current.orientation.beta,
            gamma: this.current.orientation.gamma
        };
        this.calibrated = true;
        console.log('Motion sensor calibrated:', this.zeroPoint);
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
        
        // Gyroscope (rotation rate)
        if (event.rotationRate) {
            this.current.gyro = {
                alpha: this.cleanValue(event.rotationRate.alpha),
                beta: this.cleanValue(event.rotationRate.beta),
                gamma: this.cleanValue(event.rotationRate.gamma)
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
        
        let alpha = event.alpha || 0;
        let beta = event.beta || 0;
        let gamma = event.gamma || 0;
        
        // Handle alpha wraparound (0-360 degrees)
        // Calculate shortest distance between current and previous alpha
        let alphaDiff = alpha - this.previousOrientation.alpha;
        if (alphaDiff > 180) alphaDiff -= 360;
        if (alphaDiff < -180) alphaDiff += 360;
        
        // Apply smoothing with wraparound handling
        let smoothedAlpha = this.previousOrientation.alpha + alphaDiff * (1 - this.smoothingFactor);
        // Normalize back to 0-360 range
        if (smoothedAlpha < 0) smoothedAlpha += 360;
        if (smoothedAlpha >= 360) smoothedAlpha -= 360;
        
        alpha = smoothedAlpha;
        beta = this.smoothValue(beta, this.previousOrientation.beta, this.smoothingFactor);
        gamma = this.smoothValue(gamma, this.previousOrientation.gamma, this.smoothingFactor);
        
        this.previousOrientation = { alpha, beta, gamma };
        
        // Store absolute values
        this.current.orientation = {
            alpha: this.cleanValue(alpha),
            beta: this.cleanValue(beta),
            gamma: this.cleanValue(gamma)
        };
        
        if (this.onUpdate) {
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
        
        // Calculate relative alpha with proper wraparound handling
        let relativeAlpha = this.current.orientation.alpha - this.zeroPoint.alpha;
        
        // Normalize to -180 to 180 range
        relativeAlpha = this.normalizeAngle(relativeAlpha);
        
        return {
            alpha: this.cleanValue(relativeAlpha),
            beta: this.cleanValue(this.normalizeAngle(this.current.orientation.beta - this.zeroPoint.beta)),
            gamma: this.cleanValue(this.normalizeAngle(this.current.orientation.gamma - this.zeroPoint.gamma))
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
