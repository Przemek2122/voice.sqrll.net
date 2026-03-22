export class AudioStreamer {
    constructor(url) {
        this.url = url;
        this.mediaRecorder = null;
        this.websocket = null;
        this.deviceId = null;
    }

    setDeviceId(deviceId) {
        this.deviceId = deviceId;
    }

    _getAudioConstraints() {
        return this.deviceId
            ? { audio: { deviceId: { exact: this.deviceId } } }
            : { audio: true };
    }

    async start(onConnected, onDisconnected, onError) {
        try {
            const stream = await navigator.mediaDevices.getUserMedia(this._getAudioConstraints());
            this.websocket = new WebSocket(this.url);

            this.websocket.onopen = () => {
                if (onConnected) onConnected();
                this._startRecording(stream);
            };

            this.websocket.onclose = () => {
                if (onDisconnected) onDisconnected();
            };

        } catch (err) {
            if (onError) onError(err);
        }
    }

    _startRecording(stream) {
        // Stop previous recorder if any
        if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
            this.mediaRecorder.stop();
            this.mediaRecorder.stream.getTracks().forEach(track => track.stop());
        }

        this.mediaRecorder = new MediaRecorder(stream);

        this.mediaRecorder.ondataavailable = (event) => {
            if (event.data.size > 0 && this.websocket && this.websocket.readyState === WebSocket.OPEN) {
                this.websocket.send(event.data);
            }
        };

        this.mediaRecorder.start(250);
    }

    async switchMicrophone(deviceId) {
        this.deviceId = deviceId;

        if (!this.websocket || this.websocket.readyState !== WebSocket.OPEN) {
            return; // Not currently streaming, just save the deviceId
        }

        // Get new stream with selected device and swap it in
        const stream = await navigator.mediaDevices.getUserMedia(this._getAudioConstraints());
        this._startRecording(stream);
    }

    stop() {
        if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
            this.mediaRecorder.stop();
            this.mediaRecorder.stream.getTracks().forEach(track => track.stop());
        }
        if (this.websocket) {
            this.websocket.close();
        }
    }
}
