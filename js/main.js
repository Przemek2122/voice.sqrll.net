import { AudioStreamer } from './audioStream.js';

document.addEventListener('DOMContentLoaded', async () => {
    const startBtn = document.getElementById('startBtn');
    const stopBtn = document.getElementById('stopBtn');
    const statusDiv = document.getElementById('status');
    const micSelect = document.getElementById('micSelect');

    let streamer = null;

    // --- Microphone enumeration ---
    async function populateMicList() {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const audioInputs = devices.filter(d => d.kind === 'audioinput');

        micSelect.innerHTML = '';

        if (audioInputs.length === 0) {
            micSelect.innerHTML = '<option value="">No microphones found</option>';
            return;
        }

        audioInputs.forEach((device, i) => {
            const option = document.createElement('option');
            option.value = device.deviceId;
            option.textContent = device.label || `Microphone ${i + 1}`;
            micSelect.appendChild(option);
        });

        micSelect.disabled = false;
    }

    // --- Permission & device init ---
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        statusDiv.innerText = "⚠️ Microphone API unavailable. Page must be served over HTTPS or localhost.";
        startBtn.disabled = true;
    } else {
        try {
            const permissionStream = await navigator.mediaDevices.getUserMedia({ audio: true });
            permissionStream.getTracks().forEach(track => track.stop());
            await populateMicList();
            statusDiv.innerText = "Microphone access granted. Ready to record.";
        } catch (err) {
            statusDiv.innerText = "Microphone permission denied: " + err.message;
            startBtn.disabled = true;
        }
    }

    // Re-populate mic list when devices change (e.g. plugging in a USB mic)
    if (navigator.mediaDevices) {
        navigator.mediaDevices.ondevicechange = () => populateMicList();
    }

    // --- Mic switching during stream ---
    micSelect.onchange = async () => {
        if (streamer) {
            try {
                await streamer.switchMicrophone(micSelect.value);
                statusDiv.innerText = "Switched microphone. Sending audio...";
            } catch (err) {
                statusDiv.innerText = "Error switching microphone: " + err.message;
            }
        }
    };

    // --- Start / Stop ---
    startBtn.onclick = async () => {
        streamer = new AudioStreamer('ws://localhost:8080/stream');
        streamer.setDeviceId(micSelect.value);

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
            streamer = null;
        }
        startBtn.disabled = false;
        stopBtn.disabled = true;
        statusDiv.innerText = "Stopped.";
    };
});
