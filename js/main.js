import { AudioStreamer } from './audioStream.js';

document.addEventListener('DOMContentLoaded', async () => {
    const startBtn = document.getElementById('startBtn');
    const stopBtn = document.getElementById('stopBtn');
    const statusDiv = document.getElementById('status');
    const micSelect = document.getElementById('micSelect');
    const localMeter = document.getElementById('localMeter');
    const remoteMeter = document.getElementById('remoteMeter');
    const sentRateEl = document.getElementById('sentRate');
    const recvRateEl = document.getElementById('recvRate');
    const bitrateEl = document.getElementById('bitrate');
    const sampleRateEl = document.getElementById('sampleRate');
    const channelsEl = document.getElementById('channels');
    const timesliceEl = document.getElementById('timeslice');
    const settingsPanel = document.getElementById('settingsPanel');
    const muteMicEl = document.getElementById('muteMic');
    const muteSpeakersEl = document.getElementById('muteSpeakers');

    let streamer = null;
    let meterAnimId = null;

    // --- Mute controls ---
    muteMicEl.onchange = () => {
        if (streamer) streamer.muteMic(muteMicEl.checked);
    };
    muteSpeakersEl.onchange = () => {
        if (streamer) streamer.muteSpeakers(muteSpeakersEl.checked);
    };

    // --- Volume meter & stats animation loop ---
    function formatRate(bytesPerSec) {
        if (bytesPerSec >= 1048576) return (bytesPerSec / 1048576).toFixed(1) + ' MB/s';
        if (bytesPerSec >= 1024) return (bytesPerSec / 1024).toFixed(1) + ' KB/s';
        return Math.round(bytesPerSec) + ' B/s';
    }

    function updateMeters() {
        if (streamer) {
            localMeter.style.width = streamer.getLocalLevel() + '%';
            remoteMeter.style.width = streamer.getRemoteLevel() + '%';

            const stats = streamer.getStats();
            sentRateEl.textContent = formatRate(stats.sentPerSec);
            recvRateEl.textContent = formatRate(stats.recvPerSec);
        }
        meterAnimId = requestAnimationFrame(updateMeters);
    }

    function stopMeters() {
        if (meterAnimId) {
            cancelAnimationFrame(meterAnimId);
            meterAnimId = null;
        }
        localMeter.style.width = '0%';
        remoteMeter.style.width = '0%';
        sentRateEl.textContent = '0 KB/s';
        recvRateEl.textContent = '0 KB/s';
    }

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
        const remoteAudio = document.getElementById('remoteAudio');
        streamer = new AudioStreamer('ws://localhost:8080/stream');
        streamer.setAudioElement(remoteAudio);
        streamer.setDeviceId(micSelect.value);
        streamer.setConfig({
            bitrate: parseInt(bitrateEl.value),
            sampleRate: parseInt(sampleRateEl.value),
            channelCount: parseInt(channelsEl.value),
            timeslice: parseInt(timesliceEl.value),
        });

        // Disable settings while recording
        settingsPanel.querySelectorAll('select').forEach(s => s.disabled = true);

        await streamer.start(
            () => {
                statusDiv.innerText = "Connected to Go server! Sending audio...";
                startBtn.disabled = true;
                stopBtn.disabled = false;
                updateMeters();
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
        stopMeters();
        if (streamer) {
            streamer.stop();
            streamer = null;
        }
        startBtn.disabled = false;
        stopBtn.disabled = true;
        statusDiv.innerText = "Stopped.";
        settingsPanel.querySelectorAll('select').forEach(s => s.disabled = false);
    };
});
