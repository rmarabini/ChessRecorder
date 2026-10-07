#!/usr/bin/env python3
"""One-time fix so ctranslate2's CUDA backend finds the cuBLAS/cuDNN
libraries installed from the nvidia-* pip wheels (its .so only has an
RPATH for its own bundled libs, not for site-packages/nvidia/...).

Safe to re-run (idempotent). Run it inside the venv:

    python fix-cuda-links.py

After running, `WhisperModel(..., device="cuda")` works with no
LD_LIBRARY_PATH or other environment tweaks.
"""
import pathlib
import shutil
import subprocess
import sys

site = pathlib.Path(sys.prefix, "lib")
# find the site-packages dir robustly (handles pythonX.Y naming)
candidates = [p for p in site.glob("python*/site-packages")]
if not candidates:
    sys.exit("could not find site-packages under " + str(site))
sp = candidates[0]

nvidia_dirs = [
    sp / "nvidia" / "cublas" / "lib",
    sp / "nvidia" / "cudnn" / "lib",
    sp / "nvidia" / "cuda_runtime" / "lib",
    sp / "nvidia" / "cuda_nvrtc" / "lib",
]
missing = [d for d in nvidia_dirs if not d.is_dir()]
if missing:
    sys.exit("missing nvidia lib dirs (pip install nvidia-cublas-cu12 "
             "nvidia-cudnn-cu12 nvidia-cuda-runtime-cu12 first):\n  "
             + "\n  ".join(map(str, missing)))

venv_bin = pathlib.Path(sys.prefix) / "bin"
patchelf = shutil.which("patchelf") or venv_bin / "patchelf"
if not pathlib.Path(patchelf).exists():
    sys.exit("patchelf not found — `pip install patchelf` first")

rpath = ":".join(map(str, nvidia_dirs)) + ":$ORIGIN/../ctranslate2.libs"

exts = list((sp / "ctranslate2").glob("_ext*.so"))
libs = list((sp / "ctranslate2.libs").glob("libctranslate2*.so*"))
if not exts:
    sys.exit("ctranslate2 _ext*.so not found")
for so in exts + libs:
    print("patching", so.name)
    subprocess.run([str(patchelf), "--force-rpath", "--set-rpath", rpath, str(so)],
                   check=True)
print("done. ctranslate2 can now find cuBLAS/cuDNN without env vars.")
