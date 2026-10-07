// Chess Thought Recorder (Server ASR) — background page.
//
// Two jobs:
//   1. Relay popup <-> content-script messages (START_MIC, STOP_MIC,
//      GET_STATUS) exactly like the original ChessRecorder's background.js.
//   2. Bridge PCM_AUDIO / AUDIO_RESET / TRANSCRIBE_SEGMENT messages from the
//      content script to the local Python server over a WebSocket, instead
//      of running Whisper in-browser.
//
// There is NO in-browser ASR engine in this version — all transcription
// happens in ../server/server.py (faster-whisper). If that server isn't
// running, PCM/AUDIO_RESET messages are silently dropped (harmless — they
// resume working the moment the server comes up and the socket reconnects)
// and TRANSCRIBE_SEGMENT fails fast with a clear error instead of hanging.

console.log('[CTR] background.js loaded (server-asr relay)');

const WS_URL = 'ws://127.0.0.1:8765';
const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 15000;
const TRANSCRIBE_TIMEOUT_MS = 125000; // slightly above content.js's own 120s cap

let ws = null;
let wsConnected = false;
let wsLastError = null;
let reconnectMs = RECONNECT_MIN_MS;
let reconnectTimer = null;

// Requests awaiting a reply from the server, keyed by segment id.
// { resolve(resp), timeout }
const pendingTranscribe = new Map();

function serverStatus() {
  return {
    connected: wsConnected,
    error: wsConnected ? null : (wsLastError || 'not connected'),
  };
}

function connectWS() {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  console.log('[CTR] server-asr: connecting to', WS_URL, '...');
  try {
    ws = new WebSocket(WS_URL);
  } catch (e) {
    scheduleReconnect(String(e));
    return;
  }

  ws.onopen = () => {
    wsConnected = true;
    wsLastError = null;
    reconnectMs = RECONNECT_MIN_MS;
    console.log('[CTR] server-asr: connected');
  };

  ws.onclose = () => {
    if (wsConnected) console.log('[CTR] server-asr: disconnected');
    wsConnected = false;
    failAllPending('server disconnected');
    scheduleReconnect('disconnected');
  };

  ws.onerror = (e) => {
    wsLastError = 'connection error';
    console.warn('[CTR] server-asr: socket error', e);
  };

  ws.onmessage = (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch (err) {
      console.warn('[CTR] server-asr: bad message from server', err);
      return;
    }
    if (msg.type === 'transcribe_result') {
      const pending = pendingTranscribe.get(msg.id);
      if (!pending) return; // late reply for a request we already timed out
      pendingTranscribe.delete(msg.id);
      clearTimeout(pending.timeout);
      pending.resolve({ ok: !!msg.ok, text: msg.text, error: msg.error });
    }
  };
}

function scheduleReconnect(reason) {
  wsConnected = false;
  wsLastError = reason || wsLastError;
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    reconnectMs = Math.min(RECONNECT_MAX_MS, reconnectMs * 2);
    connectWS();
  }, reconnectMs);
}

function failAllPending(reason) {
  for (const [id, pending] of pendingTranscribe) {
    clearTimeout(pending.timeout);
    pending.resolve({ ok: false, error: reason });
  }
  pendingTranscribe.clear();
}

function sendWS(obj) {
  if (!wsConnected || !ws || ws.readyState !== WebSocket.OPEN) return false;
  try {
    ws.send(JSON.stringify(obj));
    return true;
  } catch (e) {
    console.warn('[CTR] server-asr: send failed', e);
    return false;
  }
}

connectWS();

// ---------- content-script -> server bridge ----------

function handlePcmAudio(msg) {
  // Float32Array isn't JSON-serializable directly; send a plain array.
  // (Fine at localhost/short-clip scale; not worth the complexity of a
  // binary WS frame for this project.)
  sendWS({
    type: 'pcm_audio',
    epoch: msg.epoch,
    base: msg.base,
    samples: Array.from(msg.samples),
  });
}

function handleAudioReset(msg) {
  sendWS({ type: 'audio_reset', epoch: msg.epoch });
}

function handleTranscribeSegment(msg, sendResponse) {
  if (!wsConnected) {
    sendResponse({ ok: false, error: 'ASR server not connected — start server.py' });
    return;
  }
  const timeout = setTimeout(() => {
    pendingTranscribe.delete(msg.id);
    sendResponse({ ok: false, error: 'timed out waiting for server' });
  }, TRANSCRIBE_TIMEOUT_MS);
  pendingTranscribe.set(msg.id, { resolve: sendResponse, timeout });
  const sent = sendWS({
    type: 'transcribe_segment',
    id: msg.id,
    fromSample: msg.fromSample,
    toSample: msg.toSample,
    language: msg.language,
    fen: msg.fen || null,
  });
  if (!sent) {
    clearTimeout(timeout);
    pendingTranscribe.delete(msg.id);
    sendResponse({ ok: false, error: 'failed to reach ASR server' });
  }
}

// ---------- popup <-> content-script relay ----------

async function findLichessTab() {
  const tabs = await browser.tabs.query({ url: 'https://lichess.org/*' });
  return (tabs.find(t => t.active) || tabs[0] || null);
}

browser.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'PCM_AUDIO') {
    handlePcmAudio(msg);
    sendResponse({ ok: true });
    return false;
  }
  if (msg.type === 'AUDIO_RESET') {
    handleAudioReset(msg);
    sendResponse({ ok: true });
    return false;
  }
  if (msg.type === 'TRANSCRIBE_SEGMENT') {
    handleTranscribeSegment(msg, sendResponse);
    return true; // answered asynchronously
  }
  // Everything else (START_MIC, STOP_MIC, GET_STATUS, ...): relay to the
  // Lichess tab, same as the original ChessRecorder.
  (async () => {
    const tab = await findLichessTab();
    if (!tab) {
      sendResponse({ ok: false, active: false, error: 'No Lichess tab open' });
      return;
    }
    try {
      let resp = await browser.tabs.sendMessage(tab.id, msg);
      if (msg.type === 'GET_STATUS') {
        resp = Object.assign({}, resp, { whisper: serverStatus() });
      }
      sendResponse(resp);
    } catch (e) {
      sendResponse({ ok: false, active: false,
        error: 'Content script not ready - reload the Lichess tab' });
    }
  })();
  return true;
});
