#!/usr/bin/env python3
"""Chess Thought Recorder — local ASR server (faster-whisper).

Replaces the in-browser Whisper engine (transformers.js/WASM) used by the
original ChessRecorder project with a real Python process running
faster-whisper (CTranslate2) on CPU. Talks to the browser extension's
background.js over a plain WebSocket on 127.0.0.1:8765.

Run:
    python -m venv .venv && source .venv/bin/activate
    pip install -r requirements.txt
    python server.py

Protocol (JSON messages over the WebSocket, one connection per browser
session — background.js keeps it open for the lifetime of the extension):

  -> {"type": "audio_reset", "epoch": N}
       Start a new recording session: clears this connection's PCM buffer
       and tags subsequent audio/jobs with epoch N. Anything still queued
       from a previous epoch is dropped without touching the new buffer
       (mirrors ChessRecorder's whisper.js — a slow job from an old game
       must never corrupt a new game's audio).

  -> {"type": "pcm_audio", "epoch": N, "base": N, "samples": [float, ...]}
       Raw 16 kHz mono PCM, `base` = sample offset of `samples[0]` within
       this session (session-relative, restarts at 0 on audio_reset).

  -> {"type": "transcribe_segment", "id": N, "fromSample": N, "toSample": N,
      "language": "en"|"es"|"de"|"auto", "fen": "..."}
       Transcribe samples [fromSample, toSample) of 16 kHz audio.
       `fen` (optional) is the board position when the thought started;
       the server feeds its legal moves into Whisper's initial_prompt.
  <- {"type": "transcribe_result", "id": N, "ok": true, "text": "..."}
     or {"type": "transcribe_result", "id": N, "ok": false, "error": "..."}
"""

import asyncio
import json
import logging
import os
import time

import numpy as np
import websockets
from faster_whisper import WhisperModel

from chess_vocab import build_prompt, describe_legal_moves

HOST = "127.0.0.1"
PORT = 8765
SR = 16000
MODEL_SIZE = os.environ.get("CTR_MODEL", "large-v3")
DEVICE = os.environ.get("CTR_DEVICE", "auto")
COMPUTE_TYPE = os.environ.get("CTR_COMPUTE", None)
# Model/device selection (overridable via environment variables, so you can
# A/B test without editing code):
#   CTR_MODEL=large-v3 CTR_DEVICE=cuda CTR_COMPUTE=int8 python server.py
#
# Rules of thumb:
#   * no GPU                    -> CTR_DEVICE=cpu,  CTR_COMPUTE=int8
#   * modern NVIDIA GPU (Turing/Ampere or newer, 8+ GB) ->
#     CTR_DEVICE=cuda, CTR_COMPUTE=float16
#   * older Pascal GPU (GTX 10xx, e.g. GTX 1060): float16 and
#     int8_float16 are NOT supported (no Tensor Cores) ->
#     CTR_DEVICE=cuda, CTR_COMPUTE=int8 for any model incl. large-v3.
#     (the server also auto-falls back if you pick something the
#      card rejects, so it won't crash on this anymore)
# Padding around each segment. The LEADING pad must be generous: the VAD's
# onset estimate is up to ~250ms late (AnalyserNode fftSize=2048 = 128ms of
# audio lag at 16kHz, plus 100ms frame sampling, plus the 5-frame streak
# rewind), so a 0.32s pad can clip the first word at the source. 0.6s
# covers it with margin. Safe: the VAD only starts a segment after >=2s of
# silence, so the pad can never contain the previous segment's speech.
PAD_LEAD = int(0.60 * SR)
PAD_TAIL = int(0.32 * SR)
KEEP_TRAIL_S = 60      # keep this much audio past a job in case of retry

logging.basicConfig(level=logging.INFO, format="[%(asctime)s] %(message)s",
                     datefmt="%H:%M:%S")
log = logging.getLogger("server")

if DEVICE == "auto":
    try:
        import ctranslate2
        cuda_ok = ctranslate2.get_cuda_device_count() > 0
    except Exception:
        cuda_ok = False
    DEVICE = "cuda" if cuda_ok else "cpu"
    log.info("device=auto -> '%s' (CUDA available: %s)", DEVICE, cuda_ok)
if COMPUTE_TYPE is None:
    COMPUTE_TYPE = "float16" if DEVICE == "cuda" else "int8"
log.info("Loading faster-whisper model '%s' (compute_type=%s) on %s \u2014 "
         "first run downloads it, then it's cached locally...",
         MODEL_SIZE, COMPUTE_TYPE, DEVICE)
def _load_model(size, device, compute):
    return WhisperModel(size, device=device, compute_type=compute)

_t0 = time.time()
try:
    model = _load_model(MODEL_SIZE, DEVICE, COMPUTE_TYPE)
except ValueError as e:
    # Older GPUs (e.g. Pascal like a GTX 1060, compute capability 6.1)
    # have no Tensor Cores and reject "float16" as not efficient.
    # Fall back to int8, which is the recommended fast path there.
    for fallback in ("int8", "int8_float16"):
        if fallback == COMPUTE_TYPE:
            continue
        log.warning("compute_type=%s unsupported (%s) — retrying with %s",
                    COMPUTE_TYPE, e, fallback)
        try:
            COMPUTE_TYPE = fallback
            model = _load_model(MODEL_SIZE, DEVICE, COMPUTE_TYPE)
            break
        except ValueError:
            continue
    else:
        # GPU path failed entirely: last resort is CPU/int8, which
        # always works.
        log.warning("CUDA init failed for every compute type — "
                    "falling back to CPU/int8")
        DEVICE, COMPUTE_TYPE = "cpu", "int8"
        model = _load_model(MODEL_SIZE, DEVICE, COMPUTE_TYPE)
log.info("Model ready in %.1fs (device=%s, compute_type=%s)",
         time.time() - _t0, DEVICE, COMPUTE_TYPE)

# Only one transcription runs at a time (CPU-bound; matches the original
# in-browser engine's single-job-at-a-time queue, and keeps memory/CPU
# usage predictable).
_transcribe_lock = asyncio.Lock()


class Session:
    """Per-WebSocket-connection state: the PCM ring buffer and job queue."""

    def __init__(self, websocket):
        self.ws = websocket
        self.epoch = 0
        self.chunks = []      # list of (base:int, samples:np.ndarray)
        self.total = 0        # samples seen so far (session-relative)
        self.trim_floor = 0   # samples before this are gone
        self.queue = asyncio.Queue()

    def reset(self, epoch):
        self.epoch = epoch
        self.chunks.clear()
        self.total = 0
        self.trim_floor = 0

    def append(self, epoch, base, samples):
        if epoch != self.epoch:
            return  # stale session — drop
        n = len(samples)
        if base + n <= self.trim_floor:
            return
        self.chunks.append((base, np.asarray(samples, dtype=np.float32)))
        self.total = max(self.total, base + n)

    def trim(self, before):
        self.trim_floor = max(self.trim_floor, before)
        while self.chunks and self.chunks[0][0] + len(self.chunks[0][1]) <= self.trim_floor:
            self.chunks.pop(0)

    def slice(self, frm, to):
        frm = max(0, int(frm))
        to = min(self.total, int(to))
        if to <= frm:
            return None
        out = np.zeros(to - frm, dtype=np.float32)
        filled = np.zeros(to - frm, dtype=bool)
        for base, samples in self.chunks:
            c_end = base + len(samples)
            if c_end <= frm or base >= to:
                continue
            s = max(0, frm - base)
            e = min(len(samples), to - base)
            out[base + s - frm: base + e - frm] = samples[s:e]
            filled[base + s - frm: base + e - frm] = True
        if not filled.all():
            return None  # gap in the buffer — audio not fully available
        return out


async def run_job(session, job):
    """Transcribe one segment. Runs the blocking faster-whisper call in a
    worker thread so the asyncio event loop (and other connections) aren't
    blocked, while _transcribe_lock ensures only one runs at a time."""
    seg_id = job["id"]
    epoch = job["epoch"]
    from_sample = job["fromSample"]
    to_sample = job["toSample"]
    language = job.get("language") or "auto"

    if epoch != session.epoch:
        return {"type": "transcribe_result", "id": seg_id, "ok": False,
                "error": "stale: session changed while queued"}

    slice_start = max(0, from_sample - PAD_LEAD)
    # Drop old audio back to just before this clip so memory stays flat —
    # mirrors whisper.js's pre-transcribe trim.
    session.trim(slice_start - 1600)
    audio = session.slice(slice_start, to_sample + PAD_TAIL)
    if audio is None:
        # The audio may simply still be in flight: the client streams PCM
        # in ~85ms batches, and the final segment's transcribe request can
        # outrun the last few batches (e.g. the user stops mid-thought).
        # Retry for up to ~2s as long as the missing tail is recent
        # (within 3s of the newest audio); audio below trim_floor is gone
        # forever, so waiting then is pointless.
        want_to = to_sample + PAD_TAIL
        for _ in range(20):
            if want_to - session.total > 3 * SR:
                break
            await asyncio.sleep(0.1)
            if epoch != session.epoch:
                return {"type": "transcribe_result", "id": seg_id, "ok": False,
                        "error": "stale: session changed while queued"}
            audio = session.slice(slice_start, want_to)
            if audio is not None:
                break
    if audio is None:
        have_s = session.total / SR
        floor_s = session.trim_floor / SR
        want = f"{slice_start / SR:.1f}-{to_sample / SR:.1f}"
        return {"type": "transcribe_result", "id": seg_id, "ok": False,
                "error": f"audio not in buffer (have {have_s:.1f}s, "
                         f"floor {floor_s:.1f}s, want {want}s)"}

    # Guard: Whisper invents placeholder tokens ("[Música]", "[AUDIO_EN_BLANCO]")
    # when given near-silence, e.g. a 0.4s "thought" that was really just a
    # cough or a click. Skip segments that are too short or too quiet to
    # possibly contain real speech.
    seg_audio = audio[from_sample - slice_start:to_sample - slice_start]
    rms = float(np.sqrt(np.mean(np.square(seg_audio)))) if len(seg_audio) else 0.0
    if len(seg_audio) < 0.2 * SR or rms < 0.005:
        log.info("seg #%s skipped (len=%.2fs rms=%.4f)", seg_id,
                 len(seg_audio) / SR, rms)
        return {"type": "transcribe_result", "id": seg_id, "ok": False,
                "error": "segment too short or silent — skipped"}

    lang_arg = None if language == "auto" else language
    # initial_prompt = chess vocabulary (general bias) + the LEGAL MOVES of
    # this segment's position, rendered as spoken phrases ("caballo a
    # f6..."). The move list is position-specific and wins the token
    # budget; vocabulary terms get trimmed from the tail if needed.
    fen = job.get("fen")
    moves = describe_legal_moves(fen, language) if fen else None
    if moves:
        log.info("seg #%s: %d legal moves in prompt", seg_id, len(moves))
    prompt = build_prompt(language, moves,
                          tok_len=lambda s: len(model.hf_tokenizer.encode(s)))

    t0 = time.time()
    async with _transcribe_lock:
        loop = asyncio.get_event_loop()

        def _run():
            segs, info = model.transcribe(
                audio, language=lang_arg, initial_prompt=prompt,
                beam_size=5,
            )
            # segments is a lazy generator — the actual decoding happens
            # while iterating it, so that MUST happen here inside the
            # executor thread too, not back on the asyncio event loop.
            return list(segs), info

        segments, info = await loop.run_in_executor(None, _run)
    secs = time.time() - t0

    # No word timestamps (the JSON export no longer carries a words[]
    # field): just join the segment-level text of the FULL clipped clip.
    # That's exactly why the clip is padded (0.6s lead / 0.32s tail):
    # the text naturally includes the first/last word even when the VAD's
    # onset estimate is a bit late, and the >=2s silence before every
    # segment start guarantees the pad can't pull in the previous
    # thought.
    text = "".join(seg.text for seg in segments).strip()

    if not text:
        return {"type": "transcribe_result", "id": seg_id, "ok": False,
                "error": "empty transcription"}

    log.info("seg #%s in %.1fs (lang=%s) -> \"%s\"", seg_id, secs,
              info.language if lang_arg is None else lang_arg, text[:70])

    if session.epoch == epoch:
        session.trim(max(0, to_sample - KEEP_TRAIL_S * SR))

    return {"type": "transcribe_result", "id": seg_id, "ok": True,
            "text": text}


async def job_worker(session):
    while True:
        job = await session.queue.get()
        try:
            result = await run_job(session, job)
            await session.ws.send(json.dumps(result))
        except websockets.exceptions.ConnectionClosed:
            break
        except Exception as e:
            log.exception("job failed")
            try:
                await session.ws.send(json.dumps({
                    "type": "transcribe_result", "id": job["id"],
                    "ok": False, "error": str(e),
                }))
            except websockets.exceptions.ConnectionClosed:
                break
        finally:
            session.queue.task_done()


async def handle_connection(websocket):
    log.info("client connected")
    session = Session(websocket)
    worker = asyncio.create_task(job_worker(session))
    try:
        async for raw in websocket:
            try:
                msg = json.loads(raw)
            except ValueError:
                continue
            mtype = msg.get("type")
            if mtype == "audio_reset":
                session.reset(msg.get("epoch", 0))
            elif mtype == "pcm_audio":
                session.append(msg.get("epoch", 0), msg.get("base", 0),
                                msg.get("samples", []))
            elif mtype == "transcribe_segment":
                await session.queue.put({
                    "id": msg.get("id"),
                    "epoch": session.epoch,
                    "fromSample": msg.get("fromSample"),
                    "toSample": msg.get("toSample"),
                    "language": msg.get("language"),
                    "fen": msg.get("fen"),
                })
    except websockets.exceptions.ConnectionClosed:
        pass
    finally:
        worker.cancel()
        log.info("client disconnected")


def make_process_request():
    """Intercept EVERY opening request before the WebSocket handshake.

    A legitimate WebSocket handshake is a GET with the proper
    Sec-WebSocket-* headers; anything else (a browser preflight OPTIONS,
    a stray health check, a misclick in a browser tab, ...) would
    otherwise be rejected with "405 Method Not Allowed" and a plain
    "connection rejected" log line — which is exactly what we saw from
    Firefox before this hook existed.

    For non-handshake requests we log the full method/path/origin so we
    can see precisely who is knocking, then:
      - if it looks like a Local-Network-Access / Private-Network preflight
        (Firefox >= 153 sends these before WebSocket handshakes), we
        answer 204 with the headers Firefox requires so the real
        handshake can proceed;
      - otherwise we answer 200 with a hint so a human poking the port
        in a browser tab gets a useful message instead of "405".
    Returning None for genuine handshakes lets the normal WebSocket
    accept proceed.
    """

    async def process_request(connection, request):
        if request.method == "GET" and "Sec-WebSocket-Key" in request.headers:
            return None  # real handshake — proceed normally
        log.info("non-handshake request: %s %s origin=%r headers=%s",
                 request.method, request.path,
                 request.headers.get("Origin"),
                 dict(request.headers))
        if request.method == "OPTIONS":
            origin = request.headers.get("Origin", "*")
            response = connection.respond(204, "")
            response.headers["Access-Control-Allow-Origin"] = origin
            response.headers["Access-Control-Allow-Methods"] = "GET, OPTIONS"
            response.headers["Access-Control-Allow-Headers"] = (
                "Sec-WebSocket-Key, Sec-WebSocket-Version, "
                "Sec-WebSocket-Protocol, Access-Control-Request-Method, "
                "Access-Control-Request-Private-Network, "
                "Access-Control-Request-Headers")
            # Private Network Access (Chrome) / Local Network Access (Firefox)
            response.headers["Access-Control-Allow-Private-Network"] = "true"
            response.headers["Access-Control-Allow-LAN"] = "true"
            response.headers["Access-Control-Allow-Loopback"] = "true"
            response.headers["Access-Control-Max-Age"] = "86400"
            return response
        return connection.respond(200, "Chess Thought Recorder ASR server "
                                       "(WebSocket only, ws://127.0.0.1:8765)")

    return process_request


async def main():
    log.info("listening on ws://%s:%s", HOST, PORT)
    async with websockets.serve(handle_connection, HOST, PORT,
                                process_request=make_process_request()):
        await asyncio.Future()  # run forever


if __name__ == "__main__":
    asyncio.run(main())
