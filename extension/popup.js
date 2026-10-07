// Popup: polls the background every 100ms, shows status + live level
// + the list of detected thought segments, and saves settings.

const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const statusEl = document.getElementById('status');
const meterFill = document.getElementById('meterFill');
const segmentsEl = document.getElementById('segments');
const sensNum = document.getElementById('sensNum');
const silNum = document.getElementById('silNum');
const langSel = document.getElementById('langSel');
const saveAudioChk = document.getElementById('saveAudioChk');

// Sensitivity S (0..10) maps to the VAD parameters:
//   higher S = more sensitive (easier to trigger)
//   noiseFactor = 6 - 0.5*S   (S=0 -> 6x noise, S=10 -> 1x)
//   minThreshold = 0.035 - 0.003*S (never below 0.005)
function sensitivityToVad(s) {
  s = Math.max(0, Math.min(10, s));
  return {
    sensitivity: s,
    noiseFactor: 6 - 0.5 * s,
    minThreshold: Math.max(0.005, 0.035 - 0.003 * s),
  };
}

function send(msg) {
  return new Promise((resolve, reject) => {
    browser.runtime.sendMessage(msg, resp => {
      if (browser.runtime.lastError) {
        reject(new Error(browser.runtime.lastError.message));
      } else {
        resolve(resp);
      }
    });
  });
}

function fmtTime(s) {
  const m = Math.floor(s / 60);
  const sec = (s % 60).toFixed(1).padStart(4, '0');
  return String(m).padStart(2, '0') + ':' + sec;
}

// ---- settings (persisted with browser.storage.local) ----

let currentSettings = { vad: {}, language: 'auto', saveAudio: false };

async function loadSettings() {
  const data = await browser.storage.local.get('settings');
  if (data.settings) {
    currentSettings = data.settings;
    const s = data.settings.vad && data.settings.vad.sensitivity;
    if (s !== undefined && s !== null) sensNum.value = String(s);
    const sil = data.settings.vad && data.settings.vad.silenceMs;
    if (sil) silNum.value = String(sil / 1000);
    if (data.settings.language) langSel.value = data.settings.language;
    // Default OFF: audio files are only useful for debugging and take
    // real disk space, so opt-in explicitly.
    saveAudioChk.checked = !!data.settings.saveAudio;
  }
}

function saveSettings() {
  const vad = sensitivityToVad(parseFloat(sensNum.value) || 0);
  const silenceSec = Math.max(0.5, Math.min(5, parseFloat(silNum.value) || 2));
  currentSettings = {
    vad: Object.assign({}, vad, { silenceMs: Math.round(silenceSec * 1000) }),
    language: langSel.value,
    saveAudio: saveAudioChk.checked,
  };
  browser.storage.local.set({ settings: currentSettings });
  // Settings apply on the next Start (VAD loads them at session start).
  if (startBtn.disabled) statusEl.textContent = 'Settings saved — restart to apply';
}

sensNum.addEventListener('change', saveSettings);
silNum.addEventListener('change', saveSettings);
langSel.addEventListener('change', saveSettings);
saveAudioChk.addEventListener('change', saveSettings);

// ---- main UI ----

async function updateUI() {
  let st;
  try {
    st = await send({ type: 'GET_STATUS' });
  } catch (e) {
    statusEl.textContent = 'No background: ' + e.message;
    return;
  }
  if (st.error) {
    statusEl.textContent = st.error;
  } else if (st.gameEnding) {
    statusEl.textContent = 'Game over — saving in 5s...';
  } else if (st.exported) {
    statusEl.textContent = 'Saved ✓ (' + (st.segments ? st.segments.length : 0) + ' thoughts)';
  } else {
    statusEl.textContent = st.active
      ? 'Microphone: ON — ' + st.vadState + ' (thr ' + (st.threshold || 0).toFixed(3) + ')'
      : 'Microphone: off';
  }
  meterFill.style.width = ((st.level || 0) * 100).toFixed(1) + '%';
  startBtn.disabled = !!st.active;
  stopBtn.disabled = !st.active;

  // ASR server connection state (relayed from background.js's WebSocket
  // client — see server/server.py for the actual transcription engine)
  const w = st.whisper || {};
  if (!st.whisper || !w.connected) {
    statusEl.textContent += ' · ASR server: ' +
      (!w.error || w.error === 'not connected'
        ? 'not running (start server.py)'
        : w.error);
  }

  // Segment list
  let html = '';
  if (st.segments && st.segments.length) {
    html = '<div class="seglist">';
    for (const s of st.segments) {
      html += '<div class="seg">#' + s.id + ' ' +
        fmtTime(s.start) + ' → ' + fmtTime(s.end) +
        ' (' + s.duration.toFixed(1) + 's)';
      if (s.move_number) html += ' · m' + s.move_number;
      html += '</div>';
      if (s.transcribing) {
        html += '<div class="seg text pending">… transcribing</div>';
      } else if (s.text) {
        html += '<div class="seg text">' +
          s.text.replace(/</g, '&lt;') + '</div>';
      }
    }
    html += '</div>';
  }
  segmentsEl.innerHTML = html;
}

startBtn.addEventListener('click', () => {
  send({ type: 'START_MIC' })
    .then(r => {
      if (r && !r.ok) statusEl.textContent = 'Error: ' + r.error;
      updateUI();
    })
    .catch(e => {
      statusEl.textContent = 'Send failed: ' + e.message;
    });
});

stopBtn.addEventListener('click', () => {
  send({ type: 'STOP_MIC' }).then(updateUI);
});

setInterval(updateUI, 100);
updateUI();
loadSettings();
