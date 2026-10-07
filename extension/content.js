// Chess Thought Recorder — content script (the ENGINE).
// Owns the microphone, the VAD state machine, continuous audio recording,
// and JSON/TXT/WebM export.
//
// This file is site-agnostic: everything about the chess site lives in the
// site adapter (lichess.js), which exposes window.CTR_SITE = {
//   detectGame(), getBoardState(), detectGameOver()
// }. Supporting another chess site = a new adapter file + one line in the
// manifest.
//
// The whole script lives in an IIFE so we can early-return in iframes
// (chess pages contain iframes, and the content script runs in all of them).

(function () {
  if (window !== window.top) return; // only run in the top-level page

  const SITE = window.CTR_SITE;
  if (!SITE) {
    console.error('[CTR] no site adapter (window.CTR_SITE) — did lichess.js load first?');
    return;
  }

  // ---------- VAD configuration (live-tunable from the popup) ----------
  const VAD = {
    frameMs: 100,        // analyse the level every 100ms (fixed)
    onsetFrames: 5,      // consecutive loud frames to start a segment (500ms)
    silenceMs: 2000,     // silence required to finish a segment
    maxSegmentMs: 120000,// safety cut: no segment longer than 2 minutes
    noiseFactor: 4.0,    // threshold = noise floor x this (tunable via popup)
    minThreshold: 0.02,  // never go below this, even in a silent room
    noiseWindow: 100,    // how many silent samples to remember (~10s)
  };
  let sessionLanguage = 'auto'; // 'auto' | 'en' | 'es' | 'de' — for Whisper
  let sessionSaveAudio = false; // debug option: keep the session's audio file

  // Raw PCM tap (16 kHz mono) mirrored to the background page for live
  // transcription. Resampled from the AudioContext's native rate to
  // exactly 16 kHz by the ScriptProcessor tap set up in startMic().
  const PCM_SR = 16000;
  let tapNode = null;      // ScriptProcessorNode (CSP-safe PCM tap)
  let tapMute = null;      // zero-gain node routing the tap to the destination
  let tapBase = 0;         // session-relative samples already sent
  let tapBatches = 0;      // batches sent this session (for logging)
  let micEpoch = 0;        // increments each session; stale PCM is dropped

  // ---------- state ----------
  let stream = null;
  let audioCtx = null;
  let analyser = null;
  // (audio is only recorded to a file when the "Save audio file (debug)"
  // popup setting is on — see startMic/exportSession)
  let recorder = null;
  let audioChunks = [];
  let audioMime = null;    // captured while `recorder` is alive (see startMic)
  let micActive = false;
  let debugTimer = null;
  let vadTimer = null;

  let vadState = 'idle';       // 'idle' | 'speaking'
  let noiseSamples = [];       // rolling list of silent levels
  let speechStreak = 0;        // consecutive loud frames while idle
  let speechStartMs = 0;       // segment start (ms since session start)
  let lastVoiceMs = 0;         // last moment we heard voice
  let currentBoard = null;     // board state captured at speech onset
  let sessionStartMs = 0;      // performance.now() at recording start
  let sessionStartedAtISO = null; // wall clock at session start (for JSON)
  let gameId = null;           // game id from the site adapter
  let gameUrl = null;          // full URL of the game page
  let segmentSeq = 0;
  let segments = [];           // [{id, start, end, duration, fen, move_number, ...}]
  let checkTimer = null;       // polls the game status while recording
  let gameEnding = false;      // game-over detected, waiting to save
  let sessionExported = false; // auto-export happens once per session

  // ---------- BTN: on-page indicator/button ----------
  const btn = document.createElement('div');
  btn.style.cssText = [
    'position: fixed',
    'bottom: 12px',
    'left: 12px',
    'z-index: 2147483647',
    'display: flex',
    'align-items: center',
    'gap: 6px',
    'padding: 6px 10px',
    'font: 12px sans-serif',
    'background: rgba(30,30,30,0.9)',
    'color: #fff',
    'border-radius: 999px',
    'cursor: pointer',
    'user-select: none',
    'box-shadow: 0 1px 4px rgba(0,0,0,0.5)'
  ].join(';');

  const dot = document.createElement('span');
  dot.style.cssText = 'width:8px;height:8px;border-radius:50%;background:#888;display:inline-block;';
  const label = document.createElement('span');
  label.textContent = 'CTR: off';
  btn.appendChild(dot);
  btn.appendChild(label);
  document.body.appendChild(btn);

  // The pill is only shown on an actual game page.
  // Chess sites are SPAs: clicking a game changes the URL without a page
  // reload, so we watch for URL changes and toggle the pill live.
  function refreshGameGate() {
    const g = SITE.detectGame();
    btn.style.display = g.gameId ? 'flex' : 'none';
  }
  refreshGameGate();
  window.addEventListener('popstate', refreshGameGate);
  window.addEventListener('hashchange', refreshGameGate);
  const _push = history.pushState;
  history.pushState = function (...a) {
    const r = _push.apply(this, a);
    setTimeout(refreshGameGate, 0);
    return r;
  };
  const _replace = history.replaceState;
  history.replaceState = function (...a) {
    const r = _replace.apply(this, a);
    setTimeout(refreshGameGate, 0);
    return r;
  };

  function setBtn(on, customLabel) {
    dot.style.background = on ? '#e53935' : '#888';
    if (customLabel) {
      label.textContent = 'CTR: ' + customLabel;
    } else {
      label.textContent = on ? 'CTR: recording' : 'CTR: off';
    }
  }

  btn.addEventListener('click', async () => {
    if (micActive) {
      await stopMic();
      autoExport('manual stop');
    } else {
      try {
        await startMic();
      } catch (e) {
        console.log('[CTR] content: button start failed:', e);
        setBtn(false, e.name || String(e));
      }
    }
    setBtn(micActive);
  });
  // ---------- end BTN ----------

  // Fallback: if the mic was started from the popup (no page gesture yet),
  // resume the AudioContext on the first click/keypress anywhere on the page.
  function onFirstGesture() {
    if (audioCtx && audioCtx.state === 'suspended') {
      audioCtx.resume().catch(() => {});
      console.log('[CTR] content: AudioContext resumed by gesture');
    }
    document.removeEventListener('pointerdown', onFirstGesture, true);
    document.removeEventListener('keydown', onFirstGesture, true);
  }

  function armGestureListeners() {
    document.addEventListener('pointerdown', onFirstGesture, true);
    document.addEventListener('keydown', onFirstGesture, true);
  }

  // ---------- settings ----------

  async function loadConfig() {
    const data = await browser.storage.local.get('settings');
    if (data.settings) {
      if (data.settings.vad) Object.assign(VAD, data.settings.vad);
      if (data.settings.language) sessionLanguage = data.settings.language;
      sessionSaveAudio = !!data.settings.saveAudio;
    }
  }

  // ---------- VAD ----------

  function noiseFloor() {
    if (noiseSamples.length < 5) return 0.01; // default until we collect samples
    const sorted = [...noiseSamples].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length * 0.75)]; // 75th percentile
  }

  function threshold() {
    return Math.max(noiseFloor() * VAD.noiseFactor, VAD.minThreshold);
  }

  function endSegment(endMs) {
    const seg = {
      id: ++segmentSeq,
      start: +(speechStartMs / 1000).toFixed(3),
      end: +(endMs / 1000).toFixed(3),
      duration: +((endMs - speechStartMs) / 1000).toFixed(3),
      // The position at the moment the thought started (before the move
      // being considered) — captured from the board's FEN, not estimated.
      fen: currentBoard ? currentBoard.fen : null,
      move_number: currentBoard ? currentBoard.move_number : null,
      side_to_move: currentBoard ? currentBoard.side_to_move : null,
      text: null, // filled by the transcription pipeline (MVP 2)
    };
    segments.push(seg);
    console.log('[CTR] VAD: segment #' + seg.id + ': ' +
      seg.start.toFixed(2) + 's -> ' + seg.end.toFixed(2) + 's (' +
      seg.duration.toFixed(1) + 's)' +
      (seg.move_number ? ' | move ' + seg.move_number + ' ' + seg.side_to_move : ''));
    vadState = 'idle';
    speechStreak = 0;
    currentBoard = null;
    setBtn(true);
    transcribeSegment(seg);
  }

  // ---------- live transcription (background-page Whisper) ----------

  const TRANSCRIBE_TIMEOUT_MS = 120000; // give up per segment after 2 min

  function transcribeSegment(seg) {
    seg.transcribing = true;
    const fromSample = Math.floor(seg.start * PCM_SR);
    const toSample = Math.floor(seg.end * PCM_SR);
    const timeout = setTimeout(() => {
      if (seg.transcribing) {
        seg.transcribing = false;
        console.warn('[CTR] transcribe #' + seg.id +
          ': timed out after ' + (TRANSCRIBE_TIMEOUT_MS / 1000) + 's');
      }
    }, TRANSCRIBE_TIMEOUT_MS);
    try {
      browser.runtime.sendMessage({
        type: 'TRANSCRIBE_SEGMENT',
        id: seg.id,
        fromSample: fromSample,
        toSample: toSample,
        language: sessionLanguage,
        // Position at the moment the thought started — the server renders
        // its legal moves into Whisper's initial_prompt (see server.py).
        fen: seg.fen,
      }, resp => {
        clearTimeout(timeout);
        if (browser.runtime.lastError) {
          console.warn('[CTR] transcribe #' + seg.id + ':',
            browser.runtime.lastError.message);
          seg.transcribing = false;
          return;
        }
        seg.transcribing = false;
        if (resp && resp.ok && resp.text) {
          seg.text = resp.text;
          // (Word-level timestamps are no longer kept or exported —
          // seg.start/end + the FEN are the timing reference.)
          console.log('[CTR] transcribed #' + seg.id + ': "' +
            resp.text.slice(0, 80) + '"');
        } else {
          console.warn('[CTR] transcribe #' + seg.id + ' failed:',
            resp && resp.error);
        }
      });
    } catch (e) {
      seg.transcribing = false;
      console.warn('[CTR] transcribe #' + seg.id + ' send failed:', e);
    }
  }

  function vadFrame() {
    if (!micActive) return;
    const level = getLevel();
    const nowMs = performance.now() - sessionStartMs;
    const thr = threshold();

    if (vadState === 'idle') {
      if (level < thr) {
        // Silence: remember it to adapt the noise floor
        noiseSamples.push(level);
        if (noiseSamples.length > VAD.noiseWindow) noiseSamples.shift();
        speechStreak = 0;
      } else {
        speechStreak++;
        if (speechStreak >= VAD.onsetFrames) {
          // Speech detected — estimate the true onset and capture the board
          // position NOW (before the move is played).
          //
          // The rewind has three parts:
          //   1. (streak-1) frames — the confirmation window;
          //   2. the AnalyserNode lag — getLevel() reports the level of the
          //      PREVIOUS fftSize samples (fftSize/sampleRate ≈ 128ms at a
          //      16 kHz context, ≈43ms at 48 kHz), so the first
          //      above-threshold reading arrives up to a whole window late;
          //   3. one extra frame of margin, because a soft onset dilutes
          //      the RMS over the analyser window and can delay the
          //      threshold crossing further.
          // Total rewind is ~0.5–0.6s. Safe: the VAD only fires after
          // >=2s of below-threshold silence, so the rewind can never reach
          // the previous thought. (The server also pads 0.6s of leading
          // audio, so the first word's audio is in the clip even if this
          // estimate is still a bit late.)
          const lagMs = analyser
            ? (analyser.fftSize / audioCtx.sampleRate) * 1000 : 0;
          vadState = 'speaking';
          speechStartMs = Math.max(0, nowMs - (speechStreak - 1) * VAD.frameMs
                                    - lagMs - VAD.frameMs);
          lastVoiceMs = nowMs;
          currentBoard = SITE.getBoardState();
          console.log('[CTR] VAD: speech started at ' + (speechStartMs / 1000).toFixed(2) +
            's (threshold ' + thr.toFixed(4) + ')' +
            (currentBoard ? ' | move ' + currentBoard.move_number + ' ' + currentBoard.side_to_move
                           : ' | (no board found)'));
          setBtn(true, 'speaking');
        }
      }
      return;
    }

    // ---- speaking ----
    if (level >= thr) {
      lastVoiceMs = nowMs;
    } else {
      // Low enough to be background: also learn the floor while speaking
      noiseSamples.push(level);
      if (noiseSamples.length > VAD.noiseWindow) noiseSamples.shift();
      if (nowMs - lastVoiceMs >= VAD.silenceMs) {
        endSegment(lastVoiceMs); // end at the last moment of actual voice
        return;
      }
    }
    if (nowMs - speechStartMs >= VAD.maxSegmentMs) {
      console.log('[CTR] VAD: max segment length reached, cutting');
      endSegment(nowMs);
    }
  }

  // ---------- game-over detection + auto-save ----------
  // While recording, check the site adapter for a final game outcome
  // (Lichess: the "White resigned • Black is victorious" banner, which
  // updates instantly; the adapter also falls back to the public API).
  // Recording ends the instant either happens first: the game ends, or
  // the user stops it manually (the pill / popup Stop button) — no grace
  // period in either case.

  async function checkGameStatus() {
    if (!micActive || !gameId || gameEnding) return;
    let result = null;
    try {
      result = await SITE.detectGameOver();
    } catch (e) {
      // network hiccup — try again on the next tick
    }
    if (result) onGameOver(result);
  }

  async function onGameOver(result) {
    console.log('[CTR] game ended (' + result + ') — stopping now');
    gameEnding = true;
    if (checkTimer) { clearInterval(checkTimer); checkTimer = null; }
    setBtn(true, 'game over — saving...');
    await stopMic();
    autoExport('game end');
  }

  function pendingTranscripts() {
    return segments.reduce((n, s) => n + (s.transcribing ? 1 : 0), 0);
  }

  async function autoExport(reason) {
    if (sessionExported) return;
    if (!segments.length) {
      console.log('[CTR] auto-export skipped (nothing recorded):', reason);
      return;
    }
    // Transcription runs in the background page. On the FIRST run the
    // Whisper model is still downloading while you play, so at game end
    // some segments may still be pending. Wait for them (capped) so the
    // exported JSON actually contains the texts.
    const WAIT_CAP_MS = 120000;
    let waited = 0;
    while (pendingTranscripts() > 0 && waited < WAIT_CAP_MS) {
      setBtn(false, 'transcribing ' + pendingTranscripts() + '… saving after');
      await new Promise(r => setTimeout(r, 1000));
      waited += 1000;
    }
    if (pendingTranscripts() > 0) {
      console.warn('[CTR] export: ' + pendingTranscripts() +
        ' segment(s) still pending after ' + (WAIT_CAP_MS / 1000) + 's — saving without text');
    }
    sessionExported = true;
    try {
      exportSession();
      console.log('[CTR] auto-saved:', reason);
      setBtn(false, 'saved ✓');
    } catch (e) {
      console.log('[CTR] auto-export FAILED:', e);
      setBtn(false, 'save error');
    }
  }

  // ---------- export ----------

  function fmtHMS(s) {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = (s % 60).toFixed(3).padStart(6, '0');
    return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0') + ':' + sec;
  }

  function buildJSON() {
    // Drop transient UI flags (transcribing) from the exported copy
    const clean = segments.map(s => {
      const c = Object.assign({}, s);
      delete c.transcribing;
      return c;
    });
    return JSON.stringify({
      game: {
        platform: 'lichess',
        game_id: gameId,
        game_url: gameUrl,
      },
      session: {
        recording_started_at: sessionStartedAtISO,
        language: sessionLanguage,
        segments: clean,
      },
    }, null, 2);
  }

  function buildTXT() {
    let out = 'CHESS THOUGHTS\n';
    out += 'Game: ' + (gameId || 'unknown') + '\n';
    out += 'URL: ' + gameUrl + '\n';
    out += 'Recorded: ' + sessionStartedAtISO + '\n';
    out += 'Language: ' + sessionLanguage + '\n';
    out += 'Thoughts: ' + segments.length + '\n\n';
    for (const s of segments) {
      out += '[' + fmtHMS(s.start) + '] (' + s.duration.toFixed(1) + 's)';
      if (s.move_number) {
        out += '  Move ' + s.move_number + ' (' +
          (s.side_to_move === 'w' ? 'White' : 'Black') + ' to move)';
      }
      out += '\n';
      out += (s.text || '(no transcript yet)') + '\n';
      if (s.fen) out += 'FEN: ' + s.fen + '\n';
      out += '\n';
    }
    return out;
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }

  function exportSession() {
    const stamp = (sessionStartedAtISO || new Date().toISOString())
      .replace(/[:.]/g, '-').slice(0, 19);
    const name = gameId
      ? 'thoughts-' + gameId + '-' + stamp
      : 'thoughts-' + stamp;
    downloadBlob(new Blob([buildJSON()], { type: 'application/json' }),
      name + '.json');
    downloadBlob(new Blob([buildTXT()], { type: 'text/plain' }),
      name + '.txt');
    // The audio file is opt-in: only written when the popup's "Save audio
    // file (debug)" setting is on (default off). Whisper's transcription
    // never needs it — it's purely for manually re-listening when a
    // segment's text looks wrong.
    if (audioChunks.length) {
      const mime = audioMime || 'audio/ogg';
      // Firefox encodes audio-only MediaRecorder output as Ogg (.ogx in
      // current builds); name the file accordingly so the extension is
      // never a lie.
      const ext = /ogg|opus/.test(mime) ? '.ogx' : '.webm';
      downloadBlob(new Blob(audioChunks, { type: mime }), name + ext);
    }
    console.log('[CTR] export: ' + segments.length + ' segment(s), ' +
      audioChunks.length + ' audio chunk(s)');
    return { ok: true, segments: segments.length, audio: audioChunks.length > 0 };
  }

  // ---------- mic lifecycle ----------

  async function startMic() {
    if (micActive) return { ok: true };

    // Only record on an actual game page
    const g = SITE.detectGame();
    if (!g.gameId) {
      const err = 'Not on a game page (no game id in the URL)';
      console.log('[CTR] startMic refused:', err);
      return { ok: false, error: err };
    }
    gameId = g.gameId;
    gameUrl = g.gameUrl;

    await loadConfig();
    console.log('[CTR] VAD config:', JSON.stringify({
      noiseFactor: VAD.noiseFactor, silenceMs: VAD.silenceMs,
      onsetFrames: VAD.onsetFrames, language: sessionLanguage
    }));

    // IMPORTANT: create the AudioContext FIRST, synchronously inside the
    // user's click gesture. If we awaited getUserMedia before creating it,
    // Firefox's autoplay policy would keep it suspended forever.
    audioCtx = new AudioContext();
    console.log('[CTR] content: AudioContext created, state:', audioCtx.state);

    console.log('[CTR] content: requesting microphone...');
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      await audioCtx.close().catch(() => {});
      audioCtx = null;
      throw e;
    }
    console.log('[CTR] content: got stream, tracks:', stream.getTracks().length);

    if (audioCtx.state === 'suspended') {
      await audioCtx.resume().catch(() => {});
    }
    if (audioCtx.state === 'suspended') {
      console.log('[CTR] content: AudioContext still suspended — waiting for a gesture on the page');
      armGestureListeners();
    }

    const source = audioCtx.createMediaStreamSource(stream);
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 2048;
    source.connect(analyser);

    // Raw PCM mirror for Whisper: taps the mic, resamples to 16 kHz and
    // forwards 0.1s batches to the background page.
    //
    // Why ScriptProcessorNode and not AudioWorklet: Lichess's page CSP
    // blocks blob: scripts, and AudioWorklet modules must load from a URL
    // in the page context — so the worklet was CSP-killed ("operation was
    // aborted"). ScriptProcessorNode's onaudioprocess callback runs
    // directly inside the content script: no external script, nothing for
    // the CSP to block. (Spec-deprecated, but universally supported and
    // adequate for this use.)
    //
    // Two invariants, same as before:
    //  * the tap is routed to the destination through a ZERO-GAIN node, so
    //    it is actively processed (pull-based graph) and stays inaudible.
    //  * we resample the context rate (48k, sometimes 44.1k/96k) to exactly
    //    16 kHz: integer factor uses a box filter, fractional (44100) uses
    //    linear interpolation.
    try {
      tapBase = 0;
      tapBatches = 0;
      const factor = audioCtx.sampleRate / PCM_SR;
      const integer = Number.isInteger(factor);
      let win = null, wi = 0, sum = 0, nextIn = 0;
      if (integer) win = new Float32Array(factor);

      tapNode = audioCtx.createScriptProcessor(4096, 1, 1);
      tapNode.onaudioprocess = e => {
        if (!micActive) return;
        const ch = e.inputBuffer.getChannelData(0);
        let out;
        if (integer) {
          // Box decimation with the window state CARRIED ACROSS callbacks:
          // process every sample (not just whole windows) — the partial
          // window at the block boundary is completed by the next block.
          // This gives the exact 16 kHz output rate, no dropped samples.
          out = new Float32Array(Math.ceil(ch.length / factor));
          let o = 0;
          for (let i = 0; i < ch.length; i++) {
            win[wi] = ch[i];
            wi = (wi + 1) % factor;
            sum += ch[i];
            if (wi === 0) { out[o++] = sum / factor; sum = 0; }
          }
          out = out.subarray(0, o);
        } else {
          // fractional: linear interpolation, step `factor` per output
          const arr = [];
          for (;;) {
            const i0 = Math.floor(nextIn);
            if (i0 >= ch.length) break;
            const i1 = i0 + 1;
            const frac = nextIn - i0;
            arr.push(i1 < ch.length
              ? ch[i0] + (ch[i1] - ch[i0]) * frac
              : ch[i0]);
            nextIn += factor;
          }
          nextIn -= ch.length;
          out = arr;
        }
        if (!out.length) return;
        const samples = out instanceof Float32Array ? out : Float32Array.from(out);
        const base = tapBase;
        tapBase += samples.length;
        tapBatches++;
        if (tapBatches === 1 || tapBatches % 100 === 0) {
          console.log('[CTR] PCM: batch #' + tapBatches +
            ' (' + samples.length + ' samples)');
        }
        try {
          browser.runtime.sendMessage(
            { type: 'PCM_AUDIO', epoch: micEpoch, base: base, samples: samples },
            () => void browser.runtime.lastError);
        } catch (_) { /* background gone — ignore */ }
      };

      tapMute = audioCtx.createGain();
      tapMute.gain.value = 0; // silent — the tap output is never heard
      source.connect(tapNode);
      tapNode.connect(tapMute);
      tapMute.connect(audioCtx.destination);
      console.log('[CTR] content: PCM tap active (ScriptProcessor, muted, ' +
        audioCtx.sampleRate + ' Hz -> 16 kHz)');
    } catch (e) {
      console.warn('[CTR] content: PCM tap unavailable:', e);
      tapNode = null;
    }

    // Optional debug recording: a full-session audio file, only kept when
    // the popup's "Save audio file (debug)" setting is on (default off —
    // Whisper's transcription doesn't need it; this is purely for
    // manually re-listening when a segment's text looks wrong).
    audioChunks = [];
    audioMime = null;
    if (sessionSaveAudio) {
      recorder = new MediaRecorder(stream);
      recorder.ondataavailable = e => {
        if (e.data && e.data.size > 0) audioChunks.push(e.data);
      };
      recorder.start(1000); // deliver a chunk every second
      // Capture the mime NOW: by export time stopMic() has already nulled
      // `recorder`, and Firefox often reports an empty mimeType anyway
      // even though it is actually recording Ogg — default the fallback
      // to that reality, not to webm (which it never actually produces).
      audioMime = recorder.mimeType || 'audio/ogg';
      console.log('[CTR] content: MediaRecorder started (mime:', recorder.mimeType + ')');
    } else {
      recorder = null;
    }

    // Reset VAD state for the new session
    vadState = 'idle';
    noiseSamples = [];
    speechStreak = 0;
    segments = [];
    currentBoard = null;
    segmentSeq = 0;
    sessionStartMs = performance.now();
    sessionStartedAtISO = new Date().toISOString();
    sessionExported = false;
    gameEnding = false;
    // The tap's sample counter restarts at 0 each session — tell the
    // background to clear its PCM buffer to match. The epoch tag lets the
    // background drop late/stale PCM or transcription replies from a
    // previous session (e.g. a queued job that finishes after you start a
    // new game).
    micEpoch++;
    try {
      browser.runtime.sendMessage({ type: 'AUDIO_RESET', epoch: micEpoch },
        () => void browser.runtime.lastError);
    } catch (_) {}
    console.log('[CTR] game detected:', gameId, gameUrl);

    micActive = true;
    console.log('[CTR] content: mic active, ctx state:', audioCtx.state);
    console.log('[CTR] VAD: session started, listening for speech...');

    vadTimer = setInterval(vadFrame, VAD.frameMs);
    checkTimer = setInterval(checkGameStatus, 2000); // auto-stop at game end
    // DEBUG: log the live level and current threshold to the page console
    debugTimer = setInterval(() => {
      console.log('[CTR] level:', getLevel().toFixed(4),
        'thr:', threshold().toFixed(4),
        'noiseFloor:', noiseFloor().toFixed(4),
        'ctx:', audioCtx.state);
    }, 500);
    return { ok: true };
  }

  async function stopMic() {
    if (!micActive) return { ok: true };
    // Drain before cutting: the PCM tap streams to the server in ~85ms
    // batches, and the tap callback drops everything once micActive goes
    // false. If a thought is still open, its last ~0.25-0.5s of audio is
    // in flight — without this wait it is silently discarded and the
    // server can't transcribe the final segment ("audio not in buffer").
    // Keeping the mic active for a moment lets the tap flush those
    // batches; they arrive at the server before the transcribe request
    // (WebSocket message order is preserved).
    if (vadState === 'speaking') {
      await new Promise(r => setTimeout(r, 500));
    }
    micActive = false;
    if (vadTimer) { clearInterval(vadTimer); vadTimer = null; }
    if (debugTimer) { clearInterval(debugTimer); debugTimer = null; }
    if (checkTimer) { clearInterval(checkTimer); checkTimer = null; }
    if (vadState === 'speaking') {
      endSegment(performance.now() - sessionStartMs); // close open segment
    }
    if (recorder && recorder.state !== 'inactive') {
      await new Promise(resolve => {
        recorder.onstop = resolve;
        recorder.stop();
      });
    }
    recorder = null;
    if (tapNode) { tapNode.disconnect(); tapNode = null; }
    if (tapMute) { tapMute.disconnect(); tapMute = null; }
    if (stream) stream.getTracks().forEach(t => t.stop());
    if (audioCtx) await audioCtx.close();
    stream = null;
    audioCtx = null;
    analyser = null;
    console.log('[CTR] content: mic off — ' + segments.length + ' segment(s)');
    return { ok: true };
  }

  function getLevel() {
    if (!micActive || !analyser) return 0;
    if (audioCtx.state !== 'running') return 0; // suspended ctx reads silence
    const buf = new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    return Math.min(1, Math.sqrt(sum / buf.length) * 4);
  }

  // ---------- messaging ----------

  browser.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'START_MIC') {
      startMic()
        .then(() => { setBtn(micActive); sendResponse({ ok: true }); })
        .catch(e => {
          console.log('[CTR] content: START_MIC FAILED:', e);
          setBtn(false, e.name || String(e));
          sendResponse({ ok: false, error: String(e) });
        });
    } else if (msg.type === 'STOP_MIC') {
      stopMic().then(() => { setBtn(false); autoExport('manual stop'); sendResponse({ ok: true }); });
    } else if (msg.type === 'GET_STATUS') {
      // polled 10x/s by the popup: keep it light, no words[] included
      const lite = segments.map(s => ({
        id: s.id,
        start: s.start,
        end: s.end,
        duration: s.duration,
        text: s.text,
        transcribing: !!s.transcribing,
        move_number: s.move_number,
      }));
      sendResponse({
        active: micActive,
        level: micActive ? getLevel() : 0,
        vadState: micActive ? vadState : null,
        threshold: threshold(),
        segments: lite,
        gameEnding: gameEnding,
        exported: sessionExported,
      });
    }
    return true;
  });

  console.log('[CTR] content.js loaded on', location.hostname);
})();
