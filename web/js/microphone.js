/**
 * Microphone Module
 * Handles audio input with visualization
 */

class MicrophoneModule {
    constructor() {
        this.isActive = false;
        this.stream = null;
        this.audioContext = null;
        this.analyser = null;
        this.source = null;
        this.animationId = null;
        
        // Canvas for visualization
        this.canvas = null;
        this.canvasContext = null;
        
        // Audio data
        this.dataArray = null;
        this.bufferLength = 0;
        
        // Callbacks
        this.onStatusChange = null;
        this.onAudioData = null;
        this.onError = null;
    }
    
    /**
     * Initialize with canvas element
     */
    init(canvasElement) {
        this.canvas = canvasElement;
        if (this.canvas) {
            this.canvasContext = this.canvas.getContext('2d');
        }
    }
    
    /**
     * Start microphone
     */
    async start() {
        try {
            // Request microphone permission
            const constraints = {
                audio: {
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true
                }
            };
            
            this.stream = await navigator.mediaDevices.getUserMedia(constraints);
            
            // Create audio context
            this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
            this.analyser = this.audioContext.createAnalyser();
            this.analyser.fftSize = 256;
            this.analyser.smoothingTimeConstant = 0.8;
            
            // Connect stream to analyser
            this.source = this.audioContext.createMediaStreamSource(this.stream);
            this.source.connect(this.analyser);
            
            this.bufferLength = this.analyser.frequencyBinCount;
            this.dataArray = new Uint8Array(this.bufferLength);
            
            this.isActive = true;
            
            if (this.onStatusChange) {
                this.onStatusChange({
                    active: true,
                    message: 'Microphone active'
                });
            }
            
            // Start visualization
            this.visualize();
            
            return { success: true };
        } catch (error) {
            console.error('Microphone error:', error);
            if (this.onError) this.onError(error);
            return { success: false, message: error.message };
        }
    }
    
    /**
     * Stop microphone
     */
    stop() {
        if (this.animationId) {
            cancelAnimationFrame(this.animationId);
            this.animationId = null;
        }
        
        if (this.source) {
            this.source.disconnect();
            this.source = null;
        }
        
        if (this.stream) {
            this.stream.getTracks().forEach(track => track.stop());
            this.stream = null;
        }
        
        if (this.audioContext && this.audioContext.state !== 'closed') {
            this.audioContext.close();
            this.audioContext = null;
        }
        
        this.isActive = false;
        
        // Clear canvas
        if (this.canvas && this.canvasContext) {
            this.canvasContext.clearRect(0, 0, this.canvas.width, this.canvas.height);
        }
        
        if (this.onStatusChange) {
            this.onStatusChange({
                active: false,
                message: 'Microphone stopped'
            });
        }
    }
    
    /**
     * Get current audio stats
     */
    getAudioStats() {
        if (!this.isActive || !this.dataArray) {
            return { volume: 0, frequency: 0 };
        }
        
        this.analyser.getByteFrequencyData(this.dataArray);
        
        // Calculate average volume
        let sum = 0;
        for (let i = 0; i < this.bufferLength; i++) {
            sum += this.dataArray[i];
        }
        const avgVolume = Math.round(sum / this.bufferLength);
        
        // Find dominant frequency
        let maxIndex = 0;
        let maxValue = 0;
        for (let i = 0; i < this.bufferLength; i++) {
            if (this.dataArray[i] > maxValue) {
                maxValue = this.dataArray[i];
                maxIndex = i;
            }
        }
        const frequency = Math.round(maxIndex * this.audioContext.sampleRate / this.analyser.fftSize);
        
        return { volume: avgVolume, frequency };
    }
    
    /**
     * Visualize audio on canvas
     */
    visualize() {
        if (!this.isActive) return;
        
        this.animationId = requestAnimationFrame(() => this.visualize());
        
        if (!this.canvas || !this.canvasContext) return;
        
        this.analyser.getByteFrequencyData(this.dataArray);
        
        // Set canvas size
        if (this.canvas.width !== this.canvas.offsetWidth) {
            this.canvas.width = this.canvas.offsetWidth;
            this.canvas.height = this.canvas.offsetHeight;
        }
        
        const ctx = this.canvasContext;
        const width = this.canvas.width;
        const height = this.canvas.height;
        
        // Clear with fade effect
        ctx.fillStyle = 'rgba(0, 0, 0, 0.3)';
        ctx.fillRect(0, 0, width, height);
        
        // Draw bars
        const barWidth = (width / this.bufferLength) * 2.5;
        let x = 0;
        
        for (let i = 0; i < this.bufferLength; i++) {
            const barHeight = (this.dataArray[i] / 255) * height;
            
            // Color gradient based on frequency
            const r = barHeight + 25 * (i / this.bufferLength);
            const g = 250 * (i / this.bufferLength);
            const b = 50;
            
            ctx.fillStyle = `rgb(${r}, ${g}, ${b})`;
            ctx.fillRect(x, height - barHeight, barWidth, barHeight);
            
            x += barWidth + 1;
        }
        
        // Callback with audio data
        if (this.onAudioData) {
            const stats = this.getAudioStats();
            this.onAudioData(stats);
        }
    }
}

// Export for use in main app
window.MicrophoneModule = MicrophoneModule;
