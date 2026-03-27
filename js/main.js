import { AudioStreamer } from './audioStream.js';

document.addEventListener('DOMContentLoaded', async () => {
    const startBtn = document.getElementById('startBtn');
    const stopBtn = document.getElementById('stopBtn');
    const statusDiv = document.getElementById('status');
    const micSelect = document.getElementById('micSelect');
    const speakerSelect = document.getElementById('speakerSelect');
    const userIdInput = document.getElementById('userId');
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

    // --- Device enumeration ---
    function buildDeviceOptions(deviceList, selectEl, fallbackPrefix) {
        selectEl.innerHTML = '';
        if (deviceList.length === 0) {
            selectEl.innerHTML = `<option value="">No ${fallbackPrefix.toLowerCase()}s found</option>`;
            return;
        }

        // Add "System Default" as the first option — uses the OS default device
        const defaultEntry = deviceList.find(d => d.deviceId === 'default');
        if (defaultEntry) {
            const opt = document.createElement('option');
            opt.value = 'default';
            // Extract the real device name from the default label if available
            // Chrome formats it as "Default - <device name>"
            const cleanLabel = defaultEntry.label
                ? defaultEntry.label.replace(/^Default\s*-\s*/i, '').trim()
                : '';
            opt.textContent = cleanLabel
                ? `System Default — ${cleanLabel}`
                : `System Default`;
            opt.selected = true;
            selectEl.appendChild(opt);
        }

        // List all real devices (skip 'default' and 'communications' pseudo-entries)
        const realDevices = deviceList.filter(d =>
            d.deviceId !== 'default' && d.deviceId !== 'communications'
        );

        realDevices.forEach((device, i) => {
            const option = document.createElement('option');
            option.value = device.deviceId;
            option.textContent = device.label || `${fallbackPrefix} ${i + 1}`;
            selectEl.appendChild(option);
        });

        selectEl.disabled = false;
    }

    async function populateDeviceLists() {
        const devices = await navigator.mediaDevices.enumerateDevices();
        buildDeviceOptions(devices.filter(d => d.kind === 'audioinput'), micSelect, 'Microphone');
        buildDeviceOptions(devices.filter(d => d.kind === 'audiooutput'), speakerSelect, 'Speaker');
    }

    // --- Permission & device init ---
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        statusDiv.innerText = "⚠️ Microphone API unavailable. Page must be served over HTTPS or localhost.";
        startBtn.disabled = true;
    } else {
        try {
            const permissionStream = await navigator.mediaDevices.getUserMedia({ audio: true });
            permissionStream.getTracks().forEach(track => track.stop());
            await populateDeviceLists();
            statusDiv.innerText = "Microphone access granted. Ready to record.";
        } catch (err) {
            statusDiv.innerText = "Microphone permission denied: " + err.message;
            startBtn.disabled = true;
        }
    }

    // Re-populate mic list when devices change (e.g. plugging in a USB mic)
    if (navigator.mediaDevices) {
        navigator.mediaDevices.ondevicechange = () => populateDeviceLists();
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

    // --- Speaker switching (apply to all remote <audio> elements) ---
    speakerSelect.onchange = async () => {
        if (!streamer) return;
        for (const player of streamer.players.values()) {
            if (player.audioElement && typeof player.audioElement.setSinkId === 'function') {
                try {
                    await player.audioElement.setSinkId(speakerSelect.value);
                } catch (err) {
                    console.warn('Error switching speaker for user', player.userId, err);
                }
            }
        }
        statusDiv.innerText = "Switched speaker output.";
    };

    // --- Start / Stop ---
    startBtn.onclick = async () => {
        // Container for dynamically created remote <audio> elements
        let audioContainer = document.getElementById('remoteAudioContainer');
        if (!audioContainer) {
            audioContainer = document.createElement('div');
            audioContainer.id = 'remoteAudioContainer';
            audioContainer.style.display = 'none'; // hidden — audio only
            document.body.appendChild(audioContainer);
        }

        const odGive = userIdInput.value.trim();
        if (!odGive) {
            statusDiv.innerText = '⚠️ Please enter a User ID before starting.';
            return;
        }

        const wsUrl = `ws://localhost:8080/api/rooms/stream?room=test&token=test&userid=${encodeURIComponent(odGive)}`;
        streamer = new AudioStreamer(wsUrl);
        streamer.setAudioContainer(audioContainer);
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
