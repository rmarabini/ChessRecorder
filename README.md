# Chess Thought Recorder

A Firefox add-on and local Python server for recording spoken thoughts while
you play on Lichess. Each thought is associated with the board position,
move number, and side to move at the moment it starts, then
transcribed locally with [faster-whisper](https://github.com/SYSTRAN/faster-whisper)
(CTranslate2). Audio is never sent to a cloud transcription service.

## Features

- **Automatic thought detection** — speak as you play; thoughts are detected
  and separated automatically after silence.
- **Per-thought context** — every segment records the FEN and move number
  (and side to move) of the board position when the thought started.
- **Chess-aware transcription** — the server uses the current legal moves and
  common chess terms to help recognize openings, piece names, and tactics in
  English, Spanish, or German. This improves recognition but does not replace
  clear audio.
- **Fully local & private** — all audio and transcription stay on your
  machine over a loopback WebSocket. Nothing is sent to a server on the
  internet.
- **GPU or CPU, automatically** — auto-detects CUDA and falls back
  gracefully (including to CPU) if the GPU or a compute type is rejected.
- **JSON + TXT export** — saved to your Downloads folder, automatically at
  game end (or manually). An optional audio file is written only when the
  "Save audio file (debug)" toggle is on.

## How It Works

```
        ┌──────────────────────────── Firefox add-on ──────────────────────────┐
        │                                                                      │
        │  · microphone and voice detection                                   │
        │  · Lichess board and position tracking                              │
        │  · Start/Stop controls and recording settings                       │
        └────────────────────────────│────────────────────────────────────────┘
                                     │  local connection
                                     ▼
        ┌──────────────────────────── Python server ───────────────────────────┐
        │  · receives each recorded thought                                   │
        │  · uses the current chess position to improve recognition             │
        │  · transcribes locally with Whisper on CPU or GPU                     │
        │  · sends the finished transcript back to the add-on                   │
        └───────────────────────────────────────────────────────────────────────┘
```

While you play, the add-on listens for speech and separates it into
individual thoughts. Each thought is matched with the board position where
it began and sent to the local server. The server converts it to text and
returns the result to the add-on. Everything happens on your computer, and
audio from a previous game cannot be mixed into the current game.

## Project layout

```
extension/   Firefox add-on for recording and exporting thoughts
server/      Local Python server for Whisper transcription
```

## Quick Start

### Requirements

- Firefox 115 or newer
- Python 3.9 or newer
- A microphone (a wired/cable microphone is recommended)
- An NVIDIA GPU is optional; CPU inference is supported

### 1. Start the server

```bash
cd server
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

# one-time, only needed for CUDA/GPU inference (see Troubleshooting):
python fix-cuda-links.py

python server.py
```

This avoids mixing packages from another Python installation with the
project's environment.

The first run downloads the `large-v3` Whisper model (CTranslate2, roughly
1.6 GB). Models are cached afterwards, so later starts are fast. Leave this
running while you play — it listens on
`ws://127.0.0.1:8765`. You should see:

```
device=auto -> 'cuda' (CUDA available: True)
Loading faster-whisper model 'large-v3' (compute_type=float16) on cuda — first run downloads it, then it's cached locally...
Model ready in ...s (device=cuda, compute_type=float16)
listening on ws://127.0.0.1:8765
```

Wait until the server prints **`Model ready in ...s`** before continuing.
The Whisper model must finish loading before the extension can transcribe
your thoughts. Keep this terminal running while you play.

### 2. Load the extension

Firefox → `about:debugging#/runtime/this-firefox` → **Load Temporary
Add-on** → select `extension/manifest.json`.

Because this is currently loaded as a temporary add-on, Firefox removes it
when the browser is restarted. Reload `extension/manifest.json` from
`about:debugging` after each Firefox reboot. A persistent, installable version
of the extension will be created once the project has been fully debugged.

Open the popup. The status line shows `ASR server: not running (start
server.py)` until the server is up; the add-on reconnects automatically
(with backoff) once it starts — no need to reload the add-on.

> **Firefox 153 and newer:** Firefox may ask for permission to let the
> extension access a local device or service when it first connects to
> `127.0.0.1`. Click **Allow**. This is Firefox's Local Network Access
> protection; the server handles the required preflight request.

### 3. Play

Open a Lichess game and click the on-page **CTR: off** pill (or the popup's
**Start** button). The pill appears only when you are viewing an active
Lichess game page; it is hidden on other Lichess pages. The browser asks for
microphone permission the first time.
Speak your thoughts as you play. Each thought is sent to the server after you
stop speaking. Recording stops automatically when the game ends or when you
click **Stop**. JSON and TXT exports are saved to your Downloads
folder; an audio file is saved only when the debug option is enabled.

#### Choose a language

Select the language in the extension popup before clicking **Start**. English,
Spanish, and German are currently available. The selected language is used by
Whisper and by the chess vocabulary and legal-move hints.

Select a specific language whenever possible. **Do not use `Auto` unless you
need automatic language detection**: language detection can be less reliable
for short thoughts, and `Auto` disables the language-specific chess hints.
Start a new recording session after changing the language so the new setting
is applied.

#### Recording controls

The extension popup provides two controls for adjusting thought detection:

- **Sensitivity** controls how easily the extension treats sound as speech.
  Increase it if your voice is not being detected; decrease it if background
  noise starts recordings unexpectedly.
- **Silence** sets how long you must stop speaking before the current thought
  is ended and sent for transcription. A shorter value creates separate
  thoughts more quickly; a longer value is better when you pause while
  thinking.

The **sound-level bar** is activated only while recording and shows the
microphone level detected by the extension in real time. Use it to check that
the selected microphone is receiving your voice and to compare your voice
level with the background noise. Adjust the microphone input volume or the
sensitivity setting if the bar does not react reliably to your speech.

### Microphone recommendation

Use a wired/cable microphone rather than Bluetooth when possible. Wired
microphones usually provide lower latency and more consistent audio quality.
Bluetooth headsets may introduce delay, compression, or aggressive noise
processing, which can cause the recorder to split thoughts incorrectly or
reduce transcription accuracy.

Before using the extension, test your microphone in your operating system
and confirm that the correct input device is selected. Make a short test
recording and play it back to check the volume, background noise, and voice
clarity. On Linux, `pactl list sources short` can be used to list available
inputs, and tools such as `parecord` and `mplayer` can record and play back a
test file.

If a transcription does not sound right, enable **Save audio file (debug)**
in the extension popup before recording another game. The extension will
save the recorded audio alongside the JSON and TXT exports, allowing you to
listen to the source audio and determine whether the issue is the microphone
or the transcription. Audio is not saved by default.

## Optional Model Settings

The default model is `large-v3`, running on an auto-detected device (CUDA if
available, otherwise CPU). Override the model, device, or compute type per
run without editing code via environment variables:

```bash
# Example: use the smaller medium model on the GPU:
CTR_MODEL=medium python server.py
```

Rules of thumb:

| setup | `CTR_DEVICE` | `CTR_COMPUTE` |
|---|---|---|
| no GPU | `cpu` | `int8` (default) |
| modern NVIDIA GPU (Turing / Ampere or newer) | `cuda` | `float16` |
| older Pascal GPU (GTX 10xx, e.g. GTX 1060) | `cuda` | `int8` (default) |

**CPU fallback** — CPU inference is supported, but it is slower than GPU
inference. If no compatible GPU is available, or if the GPU run misbehaves,
run `CTR_DEVICE=cpu python server.py`.

## How Chess Recognition Works

The transcription engine uses two kinds of chess context to improve results:

1. **Chess vocabulary** — common piece, tactic, strategy, and opening names
   in English, Spanish, and German.
2. **The current position** — the add-on provides the position where the
   thought began, allowing the server to consider legal moves such as
   "knight to f6" or "peón a d5" while transcribing.

This context is applied automatically and does not need to be configured. If
the position is unavailable, transcription still works using the general
chess vocabulary.

### Adding another language

To add a language, update both the extension and the server:

1. Add the language option to `extension/popup.html`.
2. Add its chess terms to `VOCAB` in `server/chess_vocab.py`.
3. Add translated prompt labels to `_LEAD_IN` and `MOVES_LEAD` in the same
   file.
4. Add translated piece names and castling/promotion phrases to `_PIECE`.
5. Restart the server and reload the temporary extension in Firefox.

The language code must be supported by faster-whisper. Keep the terminology
consistent across the vocabulary list, legal-move phrases, and popup option.

## Export Format

Files are named `thoughts-<gameId>-<timestamp>.ext` or
`thoughts-<timestamp>.ext` when the game id is unavailable. The timestamp
is derived from the recording start time.

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

## Where Files Are Stored

### Extension exports

The extension saves files through Firefox's download system, normally in your
browser's default **Downloads** folder:

- `thoughts-<gameId>-<timestamp>.json`
- `thoughts-<gameId>-<timestamp>.txt`
- Optional `.ogx` or `.webm` audio file when **Save audio file (debug)** is
  enabled

The extension does not save these files inside the project directory.

### Server files

The server does not save recorded audio or transcripts to disk. Audio is kept
temporarily in memory while it is being transcribed. The completed transcript
is returned to the extension, which creates the JSON and TXT downloads.

The server does use or create these local files and directories:

- Python virtual environment: `server/.venv/`
- Downloaded Whisper model: normally in the Hugging Face cache, typically
  `~/.cache/huggingface/hub/`
- CUDA library configuration: `fix-cuda-links.py` updates the installed
  CTranslate2 files inside `server/.venv/`; it does not create a separate
  output file
- Server logs: printed in the terminal; no log file is created by default

The Whisper model cache can be moved by setting Hugging Face environment
variables such as `HF_HOME` or `HUGGINGFACE_HUB_CACHE` before starting the
server.

## Troubleshooting and FAQ

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

**Why does Whisper run in a separate server instead of inside the extension?**
Running Whisper directly in JavaScript inside Firefox requires a browser-
compatible, relatively small model. In this environment, that model does not
transcribe chess thoughts reliably enough. The local Python server can run the
larger `large-v3` model with faster-whisper, which provides better accuracy,
beam-search decoding, and chess-specific prompting while keeping all audio
on your computer.

**NumPy fails with `No module named numpy.core._multiarray_umath`.** This
usually means that `python` is pointing to another Python installation, such
as  Conda, instead of this project's virtual environment. From the
`server/` directory, run:

```bash
source .venv/bin/activate
which python
python -c "import sys, numpy; print(sys.executable); print(numpy.__file__)"
python server.py
```

`which python` should point to `server/.venv/bin/python`, and NumPy should be
loaded from `server/.venv/lib/.../site-packages`. If activation does not
change the interpreter, use `./.venv/bin/python server.py` directly. Do not
mix packages from a system, Conda, or ChimeraX Python installation with this
virtual environment.

## License

GPL v3
