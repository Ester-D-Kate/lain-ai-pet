/**
 * Speaker Module
 * Handles audio output and test sounds
 */

class SpeakerModule {
    constructor() {
        this.audioContext = null;
    }
    
    /**
     * Play a test tone
     */
    playTestTone(frequency = 440, duration = 0.5, volume = 0.3) {
        try {
            const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            const oscillator = audioCtx.createOscillator();
            const gainNode = audioCtx.createGain();
            
            oscillator.connect(gainNode);
            gainNode.connect(audioCtx.destination);
            
            oscillator.frequency.value = frequency;
            oscillator.type = 'sine';
            
            gainNode.gain.setValueAtTime(volume, audioCtx.currentTime);
            gainNode.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + duration);
            
            oscillator.start(audioCtx.currentTime);
            oscillator.stop(audioCtx.currentTime + duration);
            
            // Cleanup
            setTimeout(() => {
                audioCtx.close();
            }, (duration + 0.1) * 1000);
            
            return { success: true, message: 'Playing test tone' };
        } catch (error) {
            console.error('Speaker error:', error);
            return { success: false, message: error.message };
        }
    }
    
    /**
     * Play a melody
     */
    playMelody() {
        const notes = [
            { freq: 523.25, duration: 0.2 }, // C5
            { freq: 587.33, duration: 0.2 }, // D5
            { freq: 659.25, duration: 0.2 }, // E5
            { freq: 698.46, duration: 0.2 }, // F5
            { freq: 783.99, duration: 0.3 }  // G5
        ];
        
        let delay = 0;
        notes.forEach(note => {
            setTimeout(() => {
                this.playTestTone(note.freq, note.duration, 0.2);
            }, delay * 1000);
            delay += note.duration + 0.05;
        });
        
        return { success: true, message: 'Playing melody' };
    }
    
    /**
     * Play beep
     */
    playBeep() {
        return this.playTestTone(800, 0.1, 0.3);
    }
    
    /**
     * Play success sound
     */
    playSuccess() {
        this.playTestTone(600, 0.1, 0.2);
        setTimeout(() => this.playTestTone(800, 0.15, 0.2), 100);
        return { success: true, message: 'Playing success sound' };
    }
    
    /**
     * Play error sound
     */
    playError() {
        this.playTestTone(300, 0.2, 0.3);
        setTimeout(() => this.playTestTone(250, 0.2, 0.3), 150);
        return { success: true, message: 'Playing error sound' };
    }
}

// Export for use in main app
window.SpeakerModule = SpeakerModule;
