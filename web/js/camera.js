/**
 * Camera Module
 * Handles camera access and switching
 */

class CameraModule {
    constructor() {
        this.isActive = false;
        this.currentFacing = 'user';
        this.stream = null;
        this.videoElement = null;
        
        // Callbacks
        this.onStatusChange = null;
        this.onError = null;
    }
    
    /**
     * Initialize with video element
     */
    init(videoElement) {
        this.videoElement = videoElement;
    }
    
    /**
     * Start camera
     */
    async start(facing = 'user') {
        try {
            this.currentFacing = facing;
            
            const constraints = {
                video: {
                    facingMode: this.currentFacing,
                    width: { ideal: 1280 },
                    height: { ideal: 720 }
                }
            };
            
            this.stream = await navigator.mediaDevices.getUserMedia(constraints);
            
            if (this.videoElement) {
                this.videoElement.srcObject = this.stream;
                this.videoElement.classList.add('active');
            }
            
            this.isActive = true;
            
            if (this.onStatusChange) {
                this.onStatusChange({
                    active: true,
                    facing: this.currentFacing,
                    message: `Camera active (${this.currentFacing === 'user' ? 'Front' : 'Back'})`
                });
            }
            
            return { success: true };
        } catch (error) {
            if (this.onError) this.onError(error);
            return { success: false, message: error.message };
        }
    }
    
    /**
     * Switch between front and back camera
     */
    async switch() {
        const newFacing = this.currentFacing === 'user' ? 'environment' : 'user';
        this.stop();
        return await this.start(newFacing);
    }
    
    /**
     * Stop camera
     */
    stop() {
        if (this.stream) {
            this.stream.getTracks().forEach(track => track.stop());
            this.stream = null;
        }
        
        if (this.videoElement) {
            this.videoElement.srcObject = null;
            this.videoElement.classList.remove('active');
        }
        
        this.isActive = false;
        
        if (this.onStatusChange) {
            this.onStatusChange({
                active: false,
                message: 'Camera stopped'
            });
        }
    }
    
    /**
     * Take a snapshot
     */
    takeSnapshot() {
        if (!this.isActive || !this.videoElement) return null;
        
        const canvas = document.createElement('canvas');
        canvas.width = this.videoElement.videoWidth;
        canvas.height = this.videoElement.videoHeight;
        
        const ctx = canvas.getContext('2d');
        ctx.drawImage(this.videoElement, 0, 0);
        
        return canvas.toDataURL('image/jpeg', 0.9);
    }
}

// Export for use in main app
window.CameraModule = CameraModule;
