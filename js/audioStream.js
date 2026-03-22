export class AudioStreamer {
    constructor(url) {
        this.url = url;
        this.mediaRecorder = null;
        this.websocket = null;
    }

    async start(onConnected, onDisconnected, onError) {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            this.websocket = new WebSocket(this.url);

            this.websocket.onopen = () => {
                if (onConnected) onConnected();

                this.mediaRecorder = new MediaRecorder(stream);

                this.mediaRecorder.ondataavailable = (event) => {
                    if (event.data.size > 0 && this.websocket.readyState === WebSocket.OPEN) {
                        this.websocket.send(event.data);
                    }
                };

                this.mediaRecorder.start(250);
            };

            this.websocket.onclose = () => {
                if (onDisconnected) onDisconnected();
            };

        } catch (err) {
            if (onError) onError(err);
        }
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
