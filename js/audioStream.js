const MIME_TYPE = 'audio/webm;codecs=opus';
const TIMESLICE_MS = 250;

export class AudioStreamer {
    constructor(url) {
        this.url = url;
        this.mediaRecorder = null;
        this.websocket = null;
        this.deviceId = null;

        // Playback state
        this.audioElement = null;
        this.mediaSource = null;
        this.sourceBuffer = null;
        this.queue = [];

        // Audio analysis (Web Audio API)
        this.audioContext = null;
        this.localAnalyser = null;
        this.remoteAnalyser = null;
        this.localSource = null;
        this.remoteSource = null;

        // Data throughput tracking
        this._bytesSent = 0;
        this._bytesReceived = 0;
        this._lastStatsTime = 0;
        this._lastSentRate = 0;
        this._lastRecvRate = 0;
    }

    setDeviceId(deviceId) {
        this.deviceId = deviceId;
    }

    setAudioElement(audioElement) {
        this.audioElement = audioElement;
    }

    _getAudioConstraints() {
        return this.deviceId
            ? { audio: { deviceId: { exact: this.deviceId } } }
            : { audio: true };
    }

    // --- Audio context & analysers ---
    _ensureAudioContext() {
        if (!this.audioContext) {
            this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
        }
    }

    _setupLocalAnalyser(stream) {
        this._ensureAudioContext();

        // Disconnect previous source if switching mic
        if (this.localSource) {
            this.localSource.disconnect();
        }

        this.localAnalyser = this.audioContext.createAnalyser();
        this.localAnalyser.fftSize = 256;

        this.localSource = this.audioContext.createMediaStreamSource(stream);
        this.localSource.connect(this.localAnalyser);
    }

    _setupRemoteAnalyser() {
        if (!this.audioElement) return;
        this._ensureAudioContext();

        this.remoteAnalyser = this.audioContext.createAnalyser();
        this.remoteAnalyser.fftSize = 256;

        this.remoteSource = this.audioContext.createMediaElementSource(this.audioElement);
        this.remoteSource.connect(this.remoteAnalyser);
        this.remoteAnalyser.connect(this.audioContext.destination); // so audio still plays
    }

    /** Returns volume level 0-100 for the local mic */
    getLocalLevel() {
        return this._getLevel(this.localAnalyser);
    }

    /** Returns volume level 0-100 for the remote audio */
    getRemoteLevel() {
        return this._getLevel(this.remoteAnalyser);
    }

    _getLevel(analyser) {
        if (!analyser) return 0;
        const data = new Uint8Array(analyser.frequencyBinCount);
        analyser.getByteFrequencyData(data);
        const sum = data.reduce((a, b) => a + b, 0);
        return Math.min(100, (sum / data.length) * (100 / 128));
    }

    /** Returns { sentPerSec, recvPerSec } in bytes, updated every ~1s */
    getStats() {
        const now = performance.now();
        const elapsed = now - this._lastStatsTime;
        if (elapsed >= 1000) {
            this._lastSentRate = (this._bytesSent / elapsed) * 1000;
            this._lastRecvRate = (this._bytesReceived / elapsed) * 1000;
            this._bytesSent = 0;
            this._bytesReceived = 0;
            this._lastStatsTime = now;
        }
        return { sentPerSec: this._lastSentRate, recvPerSec: this._lastRecvRate };
    }

    // --- Playback via MediaSource ---
    _setupPlayback() {
        this.mediaSource = new MediaSource();
        this.audioElement.src = URL.createObjectURL(this.mediaSource);

        this.mediaSource.addEventListener('sourceopen', () => {
            console.log('MediaSource opened. Creating SourceBuffer.');
            this.sourceBuffer = this.mediaSource.addSourceBuffer(MIME_TYPE);
            this.sourceBuffer.mode = 'sequence';
            this.sourceBuffer.addEventListener('updateend', () => this._processQueue());

            // Setup remote analyser after MediaSource is ready
            this._setupRemoteAnalyser();
        });
    }

    _processQueue() {
        if (this.sourceBuffer && !this.sourceBuffer.updating && this.queue.length > 0) {
            const chunk = this.queue.shift();
            try {
                this.sourceBuffer.appendBuffer(chunk);
            } catch (e) {
                console.error('Error appending to SourceBuffer:', e);
            }
        }
    }

    // --- Recording (sending audio) ---
    _startRecording(stream) {
        if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
            this.mediaRecorder.stop();
            this.mediaRecorder.stream.getTracks().forEach(track => track.stop());
        }

        // Setup analyser for local mic
        this._setupLocalAnalyser(stream);

        this.mediaRecorder = new MediaRecorder(stream, { mimeType: MIME_TYPE });

        this.mediaRecorder.ondataavailable = (event) => {
            if (event.data.size > 0 && this.websocket && this.websocket.readyState === WebSocket.OPEN) {
                this._bytesSent += event.data.size;
                this.websocket.send(event.data);
            }
        };

        this.mediaRecorder.start(TIMESLICE_MS);
    }

    // --- Main start ---
    async start(onConnected, onDisconnected, onError) {
        try {
            // Setup playback if audio element is provided
            if (this.audioElement) {
                this._setupPlayback();
            }

            const stream = await navigator.mediaDevices.getUserMedia(this._getAudioConstraints());
            this.websocket = new WebSocket(this.url);
            this.websocket.binaryType = 'arraybuffer';

            this.websocket.onopen = () => {
                if (onConnected) onConnected();
                this._startRecording(stream);
            };

            // Receive audio from server and queue for playback
            this.websocket.onmessage = (event) => {
                this._bytesReceived += event.data.byteLength || event.data.size || 0;
                if (this.mediaSource && this.mediaSource.readyState === 'open') {
                    this.queue.push(event.data);
                    this._processQueue();
                }
            };

            this.websocket.onclose = () => {
                if (onDisconnected) onDisconnected();
            };

            this.websocket.onerror = (err) => {
                console.error('WebSocket error:', err);
                if (onError) onError(err);
            };

        } catch (err) {
            if (onError) onError(err);
        }
    }

    // --- Live mic switching ---
    async switchMicrophone(deviceId) {
        this.deviceId = deviceId;

        if (!this.websocket || this.websocket.readyState !== WebSocket.OPEN) {
            return;
        }

        const stream = await navigator.mediaDevices.getUserMedia(this._getAudioConstraints());
        this._startRecording(stream);
    }

    // --- Stop & cleanup ---
    stop() {
        if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
            this.mediaRecorder.stop();
            this.mediaRecorder.stream.getTracks().forEach(track => track.stop());
        }
        if (this.websocket) {
            this.websocket.close();
        }
        if (this.localSource) {
            this.localSource.disconnect();
        }
        if (this.remoteSource) {
            this.remoteSource.disconnect();
        }
        if (this.audioContext) {
            this.audioContext.close();
            this.audioContext = null;
        }
        this.localAnalyser = null;
        this.remoteAnalyser = null;
        this.queue = [];
        this.mediaSource = null;
        this.sourceBuffer = null;
    }
}
