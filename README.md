# Chess Thought Recorder

A Firefox add-on plus a local Python server that records your spoken
thoughts while you play on Lichess and transcribes them locally with
[faster-whisper](https://github.com/SYSTRAN/faster-whisper) (CTranslate2).
Each thought is captured together with the position (FEN) and move number
at the moment it started, then transcribed on your own machine — no cloud
involved.

## Features

- **Mic capture + voice-activity detection** — speak as you play; each
  thought is automatically cut off when you stop talking.
- **Per-thought context** — every segment records the FEN and move number
  (and side to move) of the board position when the thought started.
- **Chess-aware transcription** — the server feeds Whisper's
  `initial_prompt` with the *legal moves of the current position* (rendered
  as spoken phrases) plus a chess-vocabulary term list, in English,
  Spanish, or German. This measurably improves accuracy on openings, piece
  names, and tactics.
- **Fully local & private** — all audio and transcription stay on your
  machine over a loopback WebSocket. Nothing is sent to a server on the
  internet.
- **GPU or CPU, automatically** — auto-detects CUDA and falls back
  gracefully (including to CPU) if the GPU or a compute type is rejected.
- **JSON + TXT export** — saved to your Downloads folder, automatically at
  game end (or manually). An optional audio file is written only when the
  "Save audio file (debug)" toggle is on.

## How it works

```
        ┌─────────────────────────── Firefox add-on ───────────────────────────┐
        │                                                                      │
        │  content.js                 background.js          (popup.html)      │
        │  · microphone               · WebSocket relay      · Start/Stop      │
        │  · VAD (thought cuts)  ───► · auto-reconnect       · sensitivity,    │
        │  · Lichess board read      · PCM/segment bridge    · silence, lang,  │
        │    (FEN, move #)           │                                    │    │
        └────────────────────────────│────────────────────────────────────────┘
                                     │  ws://127.0.0.1:8765  (JSON messages)
                                     ▼
        ┌─────────────────────────── Python server ────────────────────────────┐
        │  server.py                                                            │
        │  · PCM ring buffer (16 kHz mono) + per-session "epoch" tagging        │
        │  · one transcription at a time (single job queue)                     │
        │  · chess_vocab.py: legal moves (python-chess) + vocabulary prompt     │
        │  · faster-whisper (CTranslate2) on CUDA or CPU                        │
        │        └──► transcript returned to the add-on, tagged by segment id   │
        └───────────────────────────────────────────────────────────────────────┘
```

The content script captures 16 kHz mono PCM and streams it to the
background page, which relays it to the server. When the VAD decides you've
finished a thought, it sends a `transcribe_segment` request carrying the
start/end sample range, the chosen language, and the FEN of the position.
The server slices the buffered audio (with a small lead/tail pad), builds a
chess-aware prompt, runs faster-whisper in a worker thread, and returns the
text. Because only one segment transcribes at a time and audio arrives in
short clips, memory and CPU/GPU use stay flat and predictable.

## Project layout

```
extension/   Firefox add-on
    manifest.json      add-on metadata (Mic, Lichess host permission)
    content.js         mic, VAD, Lichess board reading, export
    lichess.js         Lichess board access (FEN, move number, game id)
    background.js      WebSocket bridge to the server
    popup.html/js/css  UI: start/stop, sensitivity, silence, language, save-audio
    icons/             icon assets

server/      Python WebSocket ASR server
    server.py          WebSocket server + transcription pipeline
    chess_vocab.py     vocabulary lists + legal-move → spoken phrases, prompt builder
    fix-cuda-links.py  one-time patch so CTranslate2 finds the CUDA math libs
    requirements.txt   Python dependencies
```

## Quick start

### 1. Start the server

```bash
cd server
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

# one-time, GPU only (see Troubleshooting):
python fix-cuda-links.py

python server.py
```

The first run downloads the `medium` Whisper model (CTranslate2, a few
hundred MB; `large-v3` adds ~1.6 GB). Models are cached afterwards, so later
starts are fast. Leave this running while you play — it listens on
`ws://127.0.0.1:8765`. You should see:

```
device=auto -> 'cuda' (CUDA available: True)
Loading faster-whisper model 'medium' (compute_type=int8) on cuda — first run downloads it, then it's cached locally...
Model ready in ...s (device=cuda, compute_type=int8)
listening on ws://127.0.0.1:8765
```

### 2. Load the extension

Firefox → `about:debugging#/runtime/this-firefox` → **Load Temporary
Add-on** → select `extension/manifest.json`.

Open the popup. The status line shows `ASR server: not running (start
server.py)` until the server is up; the add-on reconnects automatically
(with backoff) once it starts — no need to reload the add-on.

### 3. Play

Open a Lichess game and click the on-page "record" button(or the popup's **Start**
button) once — the browser asks for microphone permission the first time.
Speak your thoughts as you play. Each one is sent to the server the moment
the VAD detects you've finished, and transcribed there. Recording stops
automatically when the game ends (or when you stop it manually), and a JSON
+ TXT file (plus an audio file only if the debug toggle is on) is saved to
your Downloads folder. You will get better results with a "cable" microphone
(vs bluetooth)

## Model & device configuration

Defaults are `medium` on an auto-detected device (CUDA if available,
otherwise CPU). Override per run without editing code via environment
variables:

```bash
# best accuracy (large-v3), on the GPU:
CTR_MODEL=large-v3 python server.py
```

Rules of thumb:

| setup | `CTR_DEVICE` | `CTR_COMPUTE` |
|---|---|---|
| no GPU | `cpu` | `int8` (default) |
| modern NVIDIA GPU (Turing / Ampere or newer) | `cuda` | `float16` |
| older Pascal GPU (GTX 10xx, e.g. GTX 1060) | `cuda` | `int8` (default) |

Pascal cards (GTX 1060 and similar) have no Tensor Cores and do **not**
support `float16` or `int8_float16` in CTranslate2 — both are rejected at
load time. `int8` is the right choice there and is already the default when
the auto-detected device lands on such a card: the server auto-falls back
instead of crashing. `large-v3` in `int8` uses only ~1 GB of VRAM on a GTX
1060 and transcribes 3 s of audio in under 2 s.

**CPU fallback** — if the GPU run ever misbehaves, just run
`CTR_DEVICE=cpu python server.py` and everything works as before.

## Chess-aware prompting

Two things bias Whisper's decoding toward chess:

1. **Vocabulary term lists** — general piece / tactic / strategy terms and
   common opening names (en/es/de). Whisper conditions its next-token
   predictions on this prompt text, so it is more likely to emit "Caro-Kann"
   than "caro cálida" when it actually hears that opening. This is biasing,
   not dictation — it won't invent words that weren't said.
2. **Legal moves of the position** — each segment carries the FEN of the
   board when the thought started. The server renders that position's legal
   moves as *spoken phrases* in the segment's language
   ("caballo a f6, peón a d5, enroque corto…") and prepends them to the
   prompt.

Whisper caps the combined `initial_prompt` at **418 tokens**. The
position-specific move list always wins the budget; generic vocabulary is
trimmed from the tail if needed (openings / niche terms go first, core
piece / tactic terms survive). All of this is transparent — nothing to
configure — and it degrades gracefully: no FEN, unknown language, or
missing `python-chess` simply means the vocabulary-only prompt is used.

## Export format

Files are named `thoughts-<gameId>-<timestamp>.ext` (or
`thoughts-<timestamp>.ext` if the game id can't be read).

### JSON

```json
{
  "game": { "platform": "lichess", "game_id": "...", "game_url": "..." },
  "session": {
    "recording_started_at": "2026-10-07T18:00:00.000Z",
    "language": "es",
    "segments": [
      {
        "text": "Ahora cambio en el centro...",
        "fen": "r1bqkbnr/pppp1ppp/2n5/...",
        "move_number": 12,
        "side_to_move": "w",
        "start": 42.5,
        "duration": 3.1
      }
    ]
  }
}
```

### TXT

A human-readable transcript, one thought per block:

```
CHESS THOUGHTS
Game: <game id>
URL: <game url>
Recorded: <ISO timestamp>
Language: es
Thoughts: N

[00:01:22.500] (3.1s)  Move 12 (White to move)
Ahora cambio en el centro...
FEN: r1bqkbnr/pppp1ppp/2n5/...
```

### Audio (optional)

When the popup's **Save audio file (debug)** toggle is on, a
`.ogx` / `.webm` file of the raw recorded audio is also written — purely for
manually re-listening if a segment's text looks wrong. Transcription never
needs it.

## Troubleshooting / FAQ

**`libcublas.so.12 not found` on GPU.** CTranslate2's pip wheel does not
bundle the CUDA math libraries (cuBLAS / cuDNN). The `nvidia-*-cu12` wheels
in `requirements.txt` provide them, but the one-time
`python fix-cuda-links.py` step is needed so ctranslate2's `.so` can find
them (idempotent). If you ever rebuild the venv, re-run
`pip install -r requirements.txt && python fix-cuda-links.py`. CPU-only
setups skip both.

**Firefox ≥ 153 "Local Network Access" prompt.** Since Firefox 153, browser
code talking to `127.0.0.1` is subject to the *Local Network Access*
protection. The first connection attempt may show a small prompt near the
address bar asking permission to access device apps and services — click
**Allow** (choose "always" if offered). The server answers the browser's
preflight probe automatically, so once the permission is granted the
connection works and reconnects transparently. To disable the prompt
entirely, set `network.lna.enabled = false` in `about:config` (fine for this
local-only use, not recommended for general browsing).

**Pascal GPU rejects `float16`.** If you have a GTX 10xx and force
`CTR_COMPUTE=float16`, CTranslate2 will refuse it. The server auto-falls
back to `int8` (and then to CPU if the GPU fails entirely), so it won't
crash — but on Pascal just use the default (`int8`).

**First run is slow.** That's the model download. Subsequent starts are fast
because the model is cached in your Hugging Face cache directory.

## License

GPL v3
