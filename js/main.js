import { AudioStreamer } from './audioStream.js';

document.addEventListener('DOMContentLoaded', () => {
    const startBtn = document.getElementById('startBtn');
    const stopBtn = document.getElementById('stopBtn');
    const statusDiv = document.getElementById('status');

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
