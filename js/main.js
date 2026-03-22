import { AudioStreamer } from './audioStream.js';

document.addEventListener('DOMContentLoaded', async () => {
    const startBtn = document.getElementById('startBtn');
    const stopBtn = document.getElementById('stopBtn');
    const statusDiv = document.getElementById('status');

    // Ask for microphone permission early
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        statusDiv.innerText = "⚠️ Microphone API unavailable. Page must be served over HTTPS or localhost.";
        startBtn.disabled = true;
    } else {
        try {
            const permissionStream = await navigator.mediaDevices.getUserMedia({ audio: true });
            // Stop the stream immediately — we only needed the permission grant
            permissionStream.getTracks().forEach(track => track.stop());
            statusDiv.innerText = "Microphone access granted. Ready to record.";
        } catch (err) {
            statusDiv.innerText = "Microphone permission denied: " + err.message;
            startBtn.disabled = true;
        }
    }

    let streamer = null;

    startBtn.onclick = async () => {
        streamer = new AudioStreamer('ws://localhost:8080/stream');

        await streamer.start(
            () => {
                statusDiv.innerText = "Connected to Go server! Sending audio...";
                startBtn.disabled = true;
                stopBtn.disabled = false;
            },
            () => {
                statusDiv.innerText = "Disconnected from server.";
            },
            (err) => {
                statusDiv.innerText = "Microphone access error: " + err;
            }
        );
    };

    stopBtn.onclick = () => {
        if (streamer) {
            streamer.stop();
        }
        startBtn.disabled = false;
        stopBtn.disabled = true;
        statusDiv.innerText = "Stopped.";
    };
});
