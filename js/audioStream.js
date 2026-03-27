const MIME_TYPE = 'audio/webm;codecs=opus';

const DEFAULT_CONFIG = {
    bitrate: 64000,
    sampleRate: 48000,
    channelCount: 2,
    timeslice: 100,
};

// ─────────────────────────────────────────────────────────────────────────────
// RemoteAudioPlayer — one per remote user
// Manages its own <audio>, MediaSource, SourceBuffer and chunk queue.
// ─────────────────────────────────────────────────────────────────────────────
class RemoteAudioPlayer {
    /**
     * @param {string} userId
     * @param {HTMLElement} container  DOM element to append the <audio> tag to
     */
    constructor(userId, container, audioContext) {
        this.userId = userId;
        this.mediaSource = null;
        this.sourceBuffer = null;
        this.queue = [];
        this._playbackStarted = false;
        this._hasInitSegment = false; // true once we receive a valid EBML header
        this._dead = false; // set on destroy to stop async work

        // Audio analysis
        this._audioContext = audioContext || null;
        this._analyser = null;
        this._mediaElementSource = null;

        // Create <audio> element
        this.audioElement = document.createElement('audio');
        this.audioElement.autoplay = true;
        this.audioElement.dataset.userId = userId;
        container.appendChild(this.audioElement);

        // Wire up MediaSource
        this._initMediaSource();
    }

    // --- EBML header detection ---------------------------------------------------

    /**
     * Check if an ArrayBuffer starts with the EBML magic bytes (0x1A 0x45 0xDF 0xA3).
     * A valid WebM init segment always begins with this 4-byte sequence.
     */
    static _isEBMLHeader(buffer) {
        if (buffer.byteLength < 4) return false;
        const v = new DataView(buffer);
        return (
            v.getUint8(0) === 0x1A &&
            v.getUint8(1) === 0x45 &&
            v.getUint8(2) === 0xDF &&
            v.getUint8(3) === 0xA3
        );
    }

    // --- MediaSource lifecycle ---------------------------------------------------

    _initMediaSource() {
        if (!MediaSource.isTypeSupported(MIME_TYPE)) {
            console.warn(`[${this.userId}] MediaSource does not support: ${MIME_TYPE}`);
            return;
        }

        this.mediaSource = new MediaSource();
        this.audioElement.src = URL.createObjectURL(this.mediaSource);

        this.mediaSource.addEventListener('sourceopen', () => {
            if (this._dead) return;
            console.log(`[${this.userId}] MediaSource opened. Creating SourceBuffer.`);
            try {
                this.sourceBuffer = this.mediaSource.addSourceBuffer(MIME_TYPE);
                this.sourceBuffer.mode = 'sequence';
            } catch (e) {
                console.error(`[${this.userId}] Failed to create SourceBuffer:`, e);
                return;
            }

            this.sourceBuffer.addEventListener('error', (e) => {
                console.error(`[${this.userId}] SourceBuffer error:`, e);
            });

            this.sourceBuffer.addEventListener('updateend', () => {
                if (this._dead) return;
                // Kick playback after the first successful append
                if (!this._playbackStarted) {
                    this._playbackStarted = true;
                    this._attachAnalyser();
                    this.audioElement.play().catch(e =>
                        console.warn(`[${this.userId}] Audio play failed:`, e)
                    );
                }
                this._processQueue();
            });

            // Flush any chunks that arrived before sourceopen
            this._processQueue();
        });
    }

    // --- Queue management --------------------------------------------------------

    /**
     * Enqueue an audio chunk (ArrayBuffer).
     * If we haven't received the init segment yet, non-EBML chunks are discarded.
     * Once the init segment arrives, all subsequent chunks are accepted.
     */
    enqueue(chunk) {
        if (this._dead) return;

        // Guard: the very first chunk MUST be an EBML init segment.
        // If the server sends cluster data before the header (e.g. user joined
        // mid-stream), we discard it — the SourceBuffer would error anyway.
        if (!this._hasInitSegment) {
            if (RemoteAudioPlayer._isEBMLHeader(chunk)) {
                this._hasInitSegment = true;
                const bytes = new Uint8Array(chunk.slice(0, 16));
                const hex = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join(' ');
                console.log(`[${this.userId}] Init segment received: ${chunk.byteLength} bytes, header: ${hex}`);
            } else {
                console.warn(`[${this.userId}] Discarding ${chunk.byteLength}-byte chunk (no init segment yet)`);
                return;
            }
        }

        this.queue.push(chunk);
        if (this.sourceBuffer) {
            this._processQueue();
        }
    }

    _processQueue() {
        if (!this.sourceBuffer || this.sourceBuffer.updating || this.queue.length === 0) return;
        if (!this.mediaSource || this.mediaSource.readyState !== 'open') return;

        const chunk = this.queue.shift();

        try {
            this.sourceBuffer.appendBuffer(chunk);
        } catch (e) {
            console.error(`[${this.userId}] appendBuffer error:`, e, 'chunk size:', chunk.byteLength);
        }
    }

    // --- Audio analysis ----------------------------------------------------------

    _attachAnalyser() {
        if (!this._audioContext || !this.audioElement || this._analyser) return;
        try {
            this._analyser = this._audioContext.createAnalyser();
            this._analyser.fftSize = 256;
            this._mediaElementSource = this._audioContext.createMediaElementSource(this.audioElement);
            this._mediaElementSource.connect(this._analyser);
            this._analyser.connect(this._audioContext.destination); // so audio still plays
        } catch (e) {
            console.warn(`[${this.userId}] Failed to attach analyser:`, e);
        }
    }

    getLevel() {
        if (!this._analyser) return 0;
        const data = new Uint8Array(this._analyser.frequencyBinCount);
        this._analyser.getByteFrequencyData(data);
        const sum = data.reduce((a, b) => a + b, 0);
        return Math.min(100, (sum / data.length) * (100 / 128));
    }

    // --- Cleanup -----------------------------------------------------------------

    destroy() {
        this._dead = true;
        this.queue = [];

        if (this.sourceBuffer) {
            try {
                if (this.mediaSource && this.mediaSource.readyState === 'open') {
                    this.mediaSource.removeSourceBuffer(this.sourceBuffer);
                }
            } catch (_) { /* ignore */ }
        }

        if (this.mediaSource && this.mediaSource.readyState === 'open') {
            try { this.mediaSource.endOfStream(); } catch (_) { /* ignore */ }
        }

        if (this._mediaElementSource) {
            try { this._mediaElementSource.disconnect(); } catch (_) { /* ignore */ }
        }
        if (this._analyser) {
            try { this._analyser.disconnect(); } catch (_) { /* ignore */ }
        }

        if (this.audioElement) {
            this.audioElement.pause();
            this.audioElement.removeAttribute('src');
            this.audioElement.remove();
        }

        this.mediaSource = null;
        this.sourceBuffer = null;
        this._analyser = null;
        this._mediaElementSource = null;
        this.audioElement = null;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// AudioStreamer — main class
// Records local mic → WS, receives multi-user binary frames → per-user players
// ─────────────────────────────────────────────────────────────────────────────

export class AudioStreamer {
    constructor(url) {
        this.url = url;
        this.mediaRecorder = null;
        this.websocket = null;
        this.deviceId = null;
        this.config = { ...DEFAULT_CONFIG };

        // Multi-user playback — userId → RemoteAudioPlayer
        /** @type {Map<string, RemoteAudioPlayer>} */
        this.players = new Map();

        // Container element for dynamically created <audio> tags
        this._audioContainer = null;

        // Audio analysis (Web Audio API) — local mic only
        this.audioContext = null;
        this.localAnalyser = null;
        this.localSource = null;

        // Data throughput tracking
        this._bytesSent = 0;
        this._bytesReceived = 0;
        this._lastStatsTime = 0;
        this._lastSentRate = 0;
        this._lastRecvRate = 0;

        // Shared TextDecoder (reused for every incoming frame)
        this._textDecoder = new TextDecoder('utf-8');
    }

    // --- Configuration -----------------------------------------------------------

    setDeviceId(deviceId) {
        this.deviceId = deviceId;
    }

    /**
     * Set / override the DOM container for remote <audio> tags.
     * Defaults to document.body if not called.
     * @param {HTMLElement} container
     */
    setAudioContainer(container) {
        this._audioContainer = container;
    }

    setConfig(config) {
        this.config = { ...DEFAULT_CONFIG, ...config };
    }

    // --- Audio constraints -------------------------------------------------------

    _getAudioConstraints() {
        const audio = {
            sampleRate: this.config.sampleRate,
            channelCount: this.config.channelCount,
        };
        if (this.deviceId) {
            audio.deviceId = { exact: this.deviceId };
        }
        return { audio };
    }

    // --- Mute controls -----------------------------------------------------------

    muteMic(muted) {
        if (this.mediaRecorder && this.mediaRecorder.stream) {
            this.mediaRecorder.stream.getAudioTracks().forEach(track => {
                track.enabled = !muted;
            });
        }
    }

    muteSpeakers(muted) {
        for (const player of this.players.values()) {
            if (player.audioElement) {
                player.audioElement.muted = muted;
            }
        }
    }

    // --- Audio context & analysers (local mic only) ------------------------------

    _ensureAudioContext() {
        if (!this.audioContext) {
            this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
        }
        if (this.audioContext.state === 'suspended') {
            this.audioContext.resume();
        }
    }

    _setupLocalAnalyser(stream) {
        this._ensureAudioContext();
        if (this.localSource) {
            this.localSource.disconnect();
        }
        this.localAnalyser = this.audioContext.createAnalyser();
        this.localAnalyser.fftSize = 256;
        this.localSource = this.audioContext.createMediaStreamSource(stream);
        this.localSource.connect(this.localAnalyser);
    }

    /** Returns volume level 0–100 for the local mic */
    getLocalLevel() {
        return this._getLevel(this.localAnalyser);
    }

    /** Returns max volume level 0–100 across all remote players */
    getRemoteLevel() {
        let max = 0;
        for (const player of this.players.values()) {
            const level = player.getLevel();
            if (level > max) max = level;
        }
        return max;
    }

    _getLevel(analyser) {
        if (!analyser) return 0;
        const data = new Uint8Array(analyser.frequencyBinCount);
        analyser.getByteFrequencyData(data);
        const sum = data.reduce((a, b) => a + b, 0);
        return Math.min(100, (sum / data.length) * (100 / 128));
    }

    // --- Stats -------------------------------------------------------------------

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

    // --- Binary protocol parser --------------------------------------------------
    //
    // Frame layout:
    //   [0]         Uint8   — length of userId (N)
    //   [1 .. N]    UTF-8   — userId string
    //   [1+N .. ]   bytes   — raw audio chunk (WebM/Opus)
    //

    /**
     * Parse an incoming binary frame and route the audio chunk to the correct
     * RemoteAudioPlayer (creating one on the fly if needed).
     * @param {ArrayBuffer} buffer
     */
    _handleBinaryFrame(buffer) {
        if (buffer.byteLength < 2) return; // too small to be valid

        const view = new DataView(buffer);
        const idLen = view.getUint8(0);

        // Sanity: frame must contain at least 1 + idLen + 1 bytes
        if (buffer.byteLength < 1 + idLen + 1) return;

        const idBytes = new Uint8Array(buffer, 1, idLen);
        const userId = this._textDecoder.decode(idBytes);

        const audioData = buffer.slice(1 + idLen);

        // Route to existing player or create a new one
        let player = this.players.get(userId);
        if (!player) {
            const container = this._audioContainer || document.body;
            this._ensureAudioContext();
            player = new RemoteAudioPlayer(userId, container, this.audioContext);
            this.players.set(userId, player);
            console.log(`[AudioRouter] New player created for user "${userId}". Total players: ${this.players.size}`);
        }

        player.enqueue(audioData);
    }

    // --- Recording (sending audio) -----------------------------------------------

    _startRecording(stream) {
        if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
            this.mediaRecorder.stop();
            this.mediaRecorder.stream.getTracks().forEach(track => track.stop());
        }

        this._setupLocalAnalyser(stream);

        this.mediaRecorder = new MediaRecorder(stream, {
            mimeType: MIME_TYPE,
            audioBitsPerSecond: this.config.bitrate,
        });

        this.mediaRecorder.ondataavailable = (event) => {
            if (event.data.size > 0 && this.websocket && this.websocket.readyState === WebSocket.OPEN) {
                this._bytesSent += event.data.size;
                this.websocket.send(event.data);
            }
        };

        this.mediaRecorder.start(this.config.timeslice);
    }

    // --- Main start --------------------------------------------------------------

    async start(onConnected, onDisconnected, onError) {
        try {
            const stream = await navigator.mediaDevices.getUserMedia(this._getAudioConstraints());
            this.websocket = new WebSocket(this.url);
            this.websocket.binaryType = 'arraybuffer';

            this.websocket.onopen = () => {
                if (onConnected) onConnected();
                this._startRecording(stream);
            };

            // Receive audio from server — parse binary protocol, route per user
            this.websocket.onmessage = (event) => {
                const data = event.data;

                // Skip non-binary messages (e.g. JSON control messages)
                if (typeof data === 'string') {
                    console.log('WS text message:', data);
                    return;
                }

                this._bytesReceived += data.byteLength || 0;
                this._handleBinaryFrame(data);
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

    // --- Live mic switching ------------------------------------------------------

    async switchMicrophone(deviceId) {
        this.deviceId = deviceId;
        if (!this.websocket || this.websocket.readyState !== WebSocket.OPEN) return;
        const stream = await navigator.mediaDevices.getUserMedia(this._getAudioConstraints());
        this._startRecording(stream);
    }

    // --- Remove a single remote player (e.g. user left the room) -----------------

    removePlayer(userId) {
        const player = this.players.get(userId);
        if (player) {
            player.destroy();
            this.players.delete(userId);
            console.log(`[AudioRouter] Player removed for user "${userId}". Remaining: ${this.players.size}`);
        }
    }

    // --- Stop & full cleanup -----------------------------------------------------

    stop() {
        if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
            this.mediaRecorder.stop();
            this.mediaRecorder.stream.getTracks().forEach(track => track.stop());
        }
        if (this.websocket) {
            this.websocket.close();
        }

        // Destroy all remote players
        for (const [userId, player] of this.players) {
            player.destroy();
        }
        this.players.clear();

        if (this.localSource) {
            this.localSource.disconnect();
        }
        if (this.audioContext) {
            this.audioContext.close();
            this.audioContext = null;
        }
        this.localAnalyser = null;
    }
}
