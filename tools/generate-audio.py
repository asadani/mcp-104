#!/usr/bin/env python3
"""
Generate the narration audio for index.html.

Reads the plain-text scripts in narration/, renders them with Kokoro-82M
(Apache-2.0, runs locally on CPU via onnxruntime), writes audio/chNN.mp3,
and patches the resulting durations back into index.html.

Everything here is free and open source. Nothing is sent anywhere.

Setup:
    python -m venv .venv
    .venv\\Scripts\\activate         # Windows;  source .venv/bin/activate elsewhere
    pip install -r tools/requirements.txt
    python tools/generate-audio.py --fetch-model

Then:
    python tools/generate-audio.py                    # all chapters
    python tools/generate-audio.py --only 04 09       # just those two
    python tools/generate-audio.py --voice bm_george  # a different narrator
    python tools/generate-audio.py --list-voices
"""

import argparse
import hashlib
import json
import os
import re
import sys
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
NARRATION = ROOT / "narration"
AUDIO = ROOT / "audio-kokoro"
# The 350 MB Kokoro weights live in one place. KOKORO_MODELS overrides; a
# sibling mcp-101 checkout is the fallback for the other courses.
MODELS = Path(os.environ["KOKORO_MODELS"]) if os.environ.get("KOKORO_MODELS") else (
    ROOT / "models" if (ROOT / "models").exists()
    else ROOT.parent / "mcp-101" / "models")
# Each narration has its own page. The default edition is the one in my
# own voice; the Kokoro edition is the alternative.
# engine -> (page, credit line). The credit names who is reading rather
# than how the audio was produced, which is not the reader's problem.
PAGES = {"qwen":       ("index.html", "Read by Anuj Sadani"),
         "kokoro":     ("kokoro.html", "Synthetic voice, Kokoro-82M"),
         "chatterbox": ("chatterbox.html", "Synthetic voice, Chatterbox")}

MODEL_BASE = ("https://github.com/thewh1teagle/kokoro-onnx/releases/download/"
              "model-files-v1.0")
MODEL_FILES = [("kokoro-v1.0.onnx", 325_532_387), ("voices-v1.0.bin", 28_214_398)]

SAMPLE_RATE = 24_000
GAP_PARAGRAPH = 0.55   # seconds of silence between paragraphs
GAP_OPENING = 0.85     # a longer beat after the "Chapter N." opening line
GAP_SENTENCE = 0.16    # between sentences inside a paragraph (clone engine)

MARK_BEGIN = "/* AUDIO-MANIFEST:BEGIN"
MARK_END = "AUDIO-MANIFEST:END */"


# --------------------------------------------------------------------------
# text preparation
# --------------------------------------------------------------------------

# Kokoro reads plain prose well but mangles acronyms and symbols. The scripts
# in narration/ are already written to be spoken aloud, so these tables stay
# small on purpose: if a sentence reads badly, fix the wording in narration/,
# not here.

# Dotted acronyms, longest form first. The trailing dot is part of the acronym,
# but at the end of a sentence it is also the full stop -- so it is restored
# when what follows looks like a new sentence. Without that, "...single
# sign-on, I.A.M. A wrapper is..." runs the two sentences together and the
# narrator never takes a breath.
DOTTED = [
    ("I.D.E.s", "eye dee ees"),
    ("I.D.E.", "eye dee ee"),
    ("I.A.M.", "eye ay em"),
    ("S.D.K.s", "ess dee kays"),
    ("S.D.K.", "ess dee kay"),
    ("C.L.I.", "see ell eye"),
    ("L.S.P.", "ell ess pee"),
    ("T.L.S.", "tee ell ess"),
    ("S.S.H.", "ess ess aitch"),
    ("S.S.M.", "ess ess em"),
    ("S.S.E.", "ess ess ee"),
    ("R.F.C.", "arr eff see"),
    ("P.K.C.E.", "pixie"),
    ("R.P.C.", "arr pee see"),
    ("U.R.I.s", "you arr eyes"),
    ("U.R.I.", "you arr eye"),
    ("I.P.", "eye pee"),
    ("N.P.X.", "en pee ex"),
    ("C.D.K.", "see dee kay"),
    ("E.C.S.", "ee see ess"),
    ("E.K.S.", "ee kay ess"),
    ("I.D.", "eye dee"),
]

# Starts a new sentence: optional quote/bracket, then a capital.
_NEW_SENTENCE = re.compile(r'\s+["“(]?[A-Z]')


def _dotted_repl(say):
    def repl(match):
        tail = match.string[match.end():]
        if not tail.strip() or _NEW_SENTENCE.match(tail):
            return say + "."
        return say
    return repl


# Phonetic spellings tuned for espeak's letter handling. Chatterbox has its
# own text frontend, so --engine chatterbox skips these unless --acronyms
# is passed explicitly.
SPOKEN_ACRONYMS = [
    (r"\bMCP\b", "em see pee"),
    (r"\bLLM\b", "ell ell em"),
    (r"\bAPIs\b", "ay pee eyes"),
    (r"\bAPI\b", "ay pee eye"),
    (r"\bJSON-RPC\b", "jayson arr pee see"),
    (r"\bJSON\b", "jayson"),
    (r"\bHTTPS\b", "aitch tee tee pee ess"),
    (r"\bHTTP\b", "aitch tee tee pee"),
    (r"\bCORS\b", "cores"),
    (r"\bURLs\b", "you arr ells"),
    (r"\bURL\b", "you arr ell"),
    (r"\bURIs\b", "you arr eyes"),
    (r"\bURI\b", "you arr eye"),
    (r"\bOAuth\b", "oh-auth"),
    (r"\bODBC\b", "oh dee bee see"),
    (r"\bUSB\b", "you ess bee"),
    (r"\bAWS\b", "ay double-you ess"),
    (r"\bS3\b", "ess three"),
    (r"\bHMAC\b", "aitch-mack"),
    (r"\bstdio\b", "standard eye-oh"),
    (r"\bOS\b", "oh ess"),
    (r"\bDNS\b", "dee en ess"),
    (r"\bGPU\b", "gee pee you"),
    (r"\bHTML\b", "aitch tee em ell"),
    (r"\bPGlite\b", "pee gee light"),
]

# Punctuation and whitespace. Engine-neutral, always applied.
SPOKEN_TYPOGRAPHY = [
    (r"\s*—\s*", ", "),   # em dash -> a real clause pause
    (r"\s+([,.;:])", r"\1"),
    (r"\s+", " "),
]


def spoken(text, acronyms=True):
    if acronyms:
        for literal, say in DOTTED:
            text = re.sub(r"\b" + re.escape(literal), _dotted_repl(say), text)
        for pattern, replacement in SPOKEN_ACRONYMS:
            text = re.sub(pattern, replacement, text)
    for pattern, replacement in SPOKEN_TYPOGRAPHY:
        text = re.sub(pattern, replacement, text)
    return text.strip()


def paragraphs(path, acronyms=True):
    """One entry per blank-line-separated block, flattened to a single line."""
    blocks = []
    for block in path.read_text(encoding="utf-8").split("\n\n"):
        joined = " ".join(line.strip() for line in block.splitlines() if line.strip())
        if joined:
            blocks.append(spoken(joined, acronyms))
    return blocks


_SENTENCE_END = re.compile(r"(?<=[.!?])\s+")
_CLAUSE_END = re.compile(r"(?<=[,;:])\s+")


def sentences(block, limit):
    """Break a paragraph into chunks of at most `limit` characters.

    Chatterbox's cost grows faster than linearly with utterance length: on a
    4 GB card a 4-second clip runs at 12x real time and an 18-second one at
    24x, because the KV cache stops fitting and the driver starts paging over
    PCIe. Feeding it sentences rather than whole paragraphs keeps it in the
    cheap band. Kokoro has no such problem and is handed the paragraph whole.
    """
    def pack(parts):
        out, cur = [], ""
        for part in parts:
            part = part.strip()
            if not part:
                continue
            if cur and len(cur) + 1 + len(part) > limit:
                out.append(cur)
                cur = part
            else:
                cur = part if not cur else cur + " " + part
        if cur:
            out.append(cur)
        return out

    chunks = []
    for chunk in pack(_SENTENCE_END.split(block)):
        # one sentence can still overrun the limit; fall back to clauses
        chunks.extend(pack(_CLAUSE_END.split(chunk)) if len(chunk) > limit else [chunk])
    return chunks


# --------------------------------------------------------------------------
# model files
# --------------------------------------------------------------------------

def fetch_models():
    MODELS.mkdir(exist_ok=True)
    for name, size in MODEL_FILES:
        dest = MODELS / name
        if dest.exists() and dest.stat().st_size == size:
            print("  %s: already present" % name)
            continue
        print("  %s: downloading %.0f MB ..." % (name, size / 1e6), flush=True)
        urllib.request.urlretrieve("%s/%s" % (MODEL_BASE, name), dest)
        print("  %s: done" % name)


def resolve_voice(spec, kokoro):
    """Turn a --voice spec into something kokoro.create() accepts.

    Kokoro voices are style vectors, so they can be averaged. That makes a
    blend a legitimate voice in its own right -- useful when the best-trained
    voices and the accent you want aren't the same voice.

        bm_george                    a single voice
        bm_george+bm_fable           an even blend
        bf_emma*0.6+af_heart*0.4     a weighted blend

    Returns (voice, lang_default) where voice is either a name or a vector.
    """
    import numpy as np

    parts = [p.strip() for p in spec.split("+") if p.strip()]
    if not parts:
        sys.exit("Empty --voice spec.")

    names, weights = [], []
    for part in parts:
        if "*" in part:
            name, _, raw = part.partition("*")
            try:
                weight = float(raw)
            except ValueError:
                sys.exit("Bad weight in --voice: %r" % part)
        else:
            name, weight = part, None
        names.append(name.strip())
        weights.append(weight)

    available = kokoro.get_voices()
    unknown = [n for n in names if n not in available]
    if unknown:
        sys.exit("Unknown voice(s): %s. See --list-voices."
                 % ", ".join(sorted(unknown)))

    # all British -> en-gb, otherwise en-us
    lang_default = "en-gb" if all(n.startswith("b") for n in names) else "en-us"

    if len(names) == 1 and weights[0] is None:
        return names[0], lang_default

    if any(w is None for w in weights):
        if not all(w is None for w in weights):
            sys.exit("Give a weight for every voice in a blend, or none at all.")
        weights = [1.0] * len(names)
    total = float(sum(weights))
    if total <= 0:
        sys.exit("Blend weights must add up to something positive.")

    blend = None
    for name, weight in zip(names, weights):
        term = kokoro.get_voice_style(name) * (weight / total)
        blend = term if blend is None else np.add(blend, term)
    return blend, lang_default


def register_cuda_dlls():
    """Put the pip-installed CUDA libraries where the loaders can find them.

    onnxruntime-gpu loads its provider DLL by a route that searches PATH, so
    os.add_dll_directory() alone is not enough on Windows: the provider
    silently falls back to CPU. Ported from narrate-your-writing/narrate.py.
    """
    try:
        import importlib.util
        spec = importlib.util.find_spec("nvidia")
        if spec is None or not spec.origin:
            return 0
    except Exception:
        return 0
    n = 0
    for sub in sorted(Path(spec.origin).parent.rglob("bin")):
        if not sub.is_dir():
            continue
        os.environ["PATH"] = str(sub) + os.pathsep + os.environ.get("PATH", "")
        if hasattr(os, "add_dll_directory"):
            try:
                os.add_dll_directory(str(sub))
            except Exception:
                pass
        n += 1
    return n


def build_session(device):
    """Open the ONNX session on the requested device.

    'auto' tries the accelerators and quietly settles for CPU. Anything
    explicit is an assertion: if DirectML or CUDA was asked for and isn't
    there, that is an error worth seeing rather than a silent hour on the CPU.
    """
    if device in ("cuda", "auto"):
        register_cuda_dlls()
    import onnxruntime as ort

    have = ort.get_available_providers()
    wanted = {
        "cpu": ["CPUExecutionProvider"],
        "dml": ["DmlExecutionProvider"],
        "cuda": ["CUDAExecutionProvider"],
        "auto": ["DmlExecutionProvider", "CUDAExecutionProvider", "CPUExecutionProvider"],
    }[device]

    order = [p for p in wanted if p in have]
    if not order:
        if device == "dml":
            sys.exit("DirectML not available. Install it with:\n"
                     "  pip uninstall -y onnxruntime\n"
                     "  pip install onnxruntime-directml\n"
                     "(they provide the same module, so only one can be installed)")
        if device == "cuda":
            sys.exit("CUDA not available. Needs onnxruntime-gpu plus a driver new "
                     "enough for its CUDA version.")
        sys.exit("No usable execution provider. Available: %s" % ", ".join(have))
    if "CPUExecutionProvider" not in order:
        order.append("CPUExecutionProvider")   # always keep a fallback for odd ops

    options = ort.SessionOptions()
    options.log_severity_level = 3
    session = ort.InferenceSession(str(MODELS / "kokoro-v1.0.onnx"),
                                   sess_options=options, providers=order)
    active = session.get_providers()
    if device == "cuda" and active[0] != "CUDAExecutionProvider":
        sys.exit("--device cuda was asked for but the session opened on %s. "
                 "Check the onnxruntime-gpu install and the driver." % active[0])
    print("provider: %s" % active[0]
          + ("" if active[0] != "CPUExecutionProvider" else " (no accelerator in use)"))
    return session


class ChatterboxEngine:
    """Zero-shot voice clone conditioned on a reference recording.

    The weights are ~3 GB and take minutes to come off disk, so one process
    must render every chapter it intends to -- loading per chapter would cost
    more than the synthesis itself.
    """

    def __init__(self, ref, device, cache_dir=None):
        import torch
        from chatterbox.tts import ChatterboxTTS

        self._torch = torch
        ref = Path(ref)
        if not ref.exists():
            sys.exit("Reference recording not found: %s" % ref)
        self.ref = str(ref)

        # Every chunk is written to disk as it is made, so an interrupted run
        # resumes from where it stopped rather than re-synthesising the
        # chapter. Keyed on the text plus the reference file, so changing
        # either invalidates the entry.
        self.cache = Path(cache_dir) if cache_dir else None
        if self.cache:
            self.cache.mkdir(parents=True, exist_ok=True)
        self._stat = ref.stat().st_size
        self.hits = 0
        self.misses = 0

        began = time.time()
        try:
            self.model = ChatterboxTTS.from_pretrained(device=device)
            self.device = device
        except Exception as exc:
            if device == "cpu":
                raise
            print("  %s load failed (%s); falling back to CPU" % (device, exc))
            self.model = ChatterboxTTS.from_pretrained(device="cpu")
            self.device = "cpu"

        self.rate = int(self.model.sr)
        if self.rate != SAMPLE_RATE:
            sys.exit("Chatterbox returns %d Hz but this pipeline writes %d Hz."
                     % (self.rate, SAMPLE_RATE))
        print("chatterbox on %s in %.0fs, reference %s"
              % (self.device, time.time() - began, ref.name))

    def _key(self, text):
        h = hashlib.sha256()
        h.update(text.encode("utf-8"))
        h.update(b"\x00")
        h.update(Path(self.ref).name.encode("utf-8"))
        h.update(str(self._stat).encode("ascii"))
        return h.hexdigest()[:20]

    def say(self, text):
        import numpy as np

        path = self.cache / (self._key(text) + ".npy") if self.cache else None
        if path is not None and path.exists():
            try:
                samples = np.load(path)
                self.hits += 1
                return samples
            except Exception:
                path.unlink(missing_ok=True)   # truncated by an earlier crash

        torch = self._torch
        try:
            wav = self.model.generate(text, audio_prompt_path=self.ref)
        except torch.cuda.OutOfMemoryError:
            # 3.2 GB of weights on a 4 GB card leaves very little room; a
            # dropped cache is usually enough to get the next chunk through.
            torch.cuda.empty_cache()
            wav = self.model.generate(text, audio_prompt_path=self.ref)
        samples = np.asarray(wav.squeeze(0).detach().cpu().numpy(), dtype="float32")
        self.misses += 1

        if path is not None:
            # Write to a temp name and rename, so a crash mid-write cannot
            # leave a truncated file behind. np.save appends ".npy" to any
            # name that lacks it, so hand it an open handle instead and the
            # temp file keeps the name we chose.
            tmp = path.with_suffix(".part")
            with open(tmp, "wb") as fh:
                np.save(fh, samples)
            tmp.replace(path)
        return samples

    def release(self):
        """Hand cached blocks back between paragraphs.

        The allocator normally holds freed blocks for reuse, which is the right
        default -- but with 3.2 GB of weights in a 4 GB card, fragmentation is
        what pushes a kernel into paging over PCIe, and a kernel that pages for
        longer than two seconds trips the display driver's watchdog. Windows
        then resets the GPU engine and the CUDA context dies, taking the run
        with it (nvlddmkm event 153).
        """
        if self.device == "cuda":
            self._torch.cuda.empty_cache()


class QwenEngine:
    """Qwen3-TTS 0.6B zero-shot clone.

    Three things differ from ChatterboxEngine, all measured on a 4 GB card:

    * Weights are 2.17 GB rather than 3.21 GB, so the KV cache fits and RTF
      stays flat with utterance length (4.4x at 5s, 4.5x at 18s) instead of
      climbing. That means chunks can follow paragraph boundaries rather than
      being cut short to dodge paging.
    * It generates in batches. Batch 2 runs at 2.7x against 4.4x for batch 1;
      batch 4 peaks at 5.07 GB, pages, and gives the gain straight back.
    * It clones in-context, so it needs the reference transcript as well as
      the reference audio. A 4.52s reference beats the full 85s one -- the
      long one puts ~1000 acoustic tokens in the prompt and thrashes.
    """

    def __init__(self, ref, ref_text, device, cache_dir=None, batch=2):
        import torch
        from qwen_tts import Qwen3TTSModel

        self._torch = torch
        ref = Path(ref)
        if not ref.exists():
            sys.exit("Reference recording not found: %s" % ref)
        self.ref = str(ref)
        self.ref_text = ref_text.strip()
        if not self.ref_text:
            sys.exit("Reference transcript is empty. Qwen clones in-context and "
                     "needs the words that were actually spoken in %s." % ref.name)
        self.batch = max(1, int(batch))
        self.cache = Path(cache_dir) if cache_dir else None
        if self.cache:
            self.cache.mkdir(parents=True, exist_ok=True)
        self._stat = ref.stat().st_size
        self.hits = 0
        self.misses = 0

        began = time.time()
        # bf16 is emulated on Turing and fp16 would be the native path, but
        # fp16's exponent range overflows in the sampling loop and the
        # device-side assert takes the process with it. Correctness wins.
        self.model = Qwen3TTSModel.from_pretrained(
            "Qwen/Qwen3-TTS-12Hz-0.6B-Base",
            device_map=device,
            dtype=torch.bfloat16,
            attn_implementation="sdpa",   # flash_attention_2 needs Ampere or newer
        )
        self.device = device
        self.rate = SAMPLE_RATE
        print("qwen3-tts 0.6B on %s in %.0fs, reference %s (%s), batch %d"
              % (device, time.time() - began, ref.name,
                 "%.1fs" % (self._stat / (SAMPLE_RATE * 2)), self.batch))

    def _path(self, text):
        if not self.cache:
            return None
        h = hashlib.sha256()
        h.update(text.encode("utf-8"))
        h.update(b"\x00")
        h.update(self.ref_text.encode("utf-8"))
        h.update(str(self._stat).encode("ascii"))
        return self.cache / (h.hexdigest()[:20] + ".npy")

    # Speech runs near 14 characters a second and the codec at 12 tokens a second,
    # so about 0.9 tokens a character. Allow twice that. Without a cap a chunk
    # that never emits its end token runs to the library default, the KV cache
    # fills a 4 GB card, and the whole render stalls for good (seen twice).
    TOKENS_PER_CHAR = 1.8
    TOKEN_SLACK = 80
    CODEC_HZ = 12

    def _generate(self, batch, _attempt=0):
        import numpy as np

        n = len(batch)
        cap = int(max(len(t) for t in batch) * self.TOKENS_PER_CHAR) + self.TOKEN_SLACK
        try:
            wavs, sr = self.model.generate_voice_clone(
                text=batch if n > 1 else batch[0],
                language=["English"] * n if n > 1 else "English",
                ref_audio=[self.ref] * n if n > 1 else self.ref,
                ref_text=[self.ref_text] * n if n > 1 else self.ref_text,
                max_new_tokens=cap,
            )
        except self._torch.cuda.OutOfMemoryError:
            self._torch.cuda.empty_cache()
            if n == 1:
                raise
            # Drop to one at a time rather than losing the whole batch. Chunk
            # lengths vary, so an occasional pair will not fit even though the
            # average does.
            out = []
            for one in batch:
                out.extend(self._generate([one]))
            return out
        if int(sr) != SAMPLE_RATE:
            sys.exit("Qwen returned %d Hz but this pipeline writes %d Hz."
                     % (sr, SAMPLE_RATE))
        if n == 1 and not isinstance(wavs, (list, tuple)):
            wavs = [wavs]
        outs = [np.asarray(w, dtype="float32").reshape(-1) for w in wavs]
        # A chunk that used its whole allowance did not stop on its own. Sampling
        # is random, so try it again by itself, and keep the last attempt.
        for i, w in enumerate(outs):
            limit = int(len(batch[i]) * self.TOKENS_PER_CHAR) + self.TOKEN_SLACK
            if _attempt < 3 and len(w) / SAMPLE_RATE * self.CODEC_HZ >= limit - 3:
                print("  ! chunk ran to its token limit, retrying: %r" % batch[i][:50], flush=True)
                outs[i] = self._generate([batch[i]], _attempt + 1)[0]
        return outs

    def say_many(self, texts):
        """Synthesise a list of chunks, reusing anything already on disk."""
        import numpy as np

        out = [None] * len(texts)
        todo = []
        for i, text in enumerate(texts):
            path = self._path(text)
            if path is not None and path.exists():
                try:
                    out[i] = np.load(path)
                    self.hits += 1
                    continue
                except Exception:
                    path.unlink(missing_ok=True)   # truncated by an earlier crash
            todo.append(i)

        for start in range(0, len(todo), self.batch):
            idxs = todo[start:start + self.batch]
            for i, samples in zip(idxs, self._generate([texts[i] for i in idxs])):
                out[i] = samples
                self.misses += 1
                path = self._path(texts[i])
                if path is not None:
                    tmp = path.with_suffix(".part")
                    with open(tmp, "wb") as fh:
                        np.save(fh, samples)
                    tmp.replace(path)
        return out

    def release(self):
        if self.device.startswith("cuda"):
            self._torch.cuda.empty_cache()


def require_models():
    missing = [n for n, _ in MODEL_FILES if not (MODELS / n).exists()]
    if missing:
        sys.exit("Model files missing: %s\nRun:  python tools/generate-audio.py "
                 "--fetch-model" % ", ".join(missing))


# --------------------------------------------------------------------------
# html patching
# --------------------------------------------------------------------------

def patch_html(tracks, voice, page, audio_dir, credit):
    """Write the durations into the page so the player can show times before
    any audio is fetched. Inlined rather than fetched, so the page still works
    when opened straight off disk as a file:// URL."""
    target = ROOT / page
    if not target.exists():
        print("! %s not found, skipping manifest patch" % page)
        return
    with open(target, encoding="utf-8", newline="") as fh:
        html = fh.read()
    if MARK_BEGIN not in html or MARK_END not in html:
        print("! manifest markers not found in %s, skipping patch" % page)
        return

    entries = ",\n".join(
        '    %s: { f: "%s.mp3", d: %.1f }' % (cid, cid, dur)
        for cid, dur in sorted(tracks.items())
    )
    block = (
        MARK_BEGIN + " · written by tools/generate-audio.py · do not hand-edit */\n"
        "var AUDIO = {\n"
        '  dir: "%s/",\n'
        '  voice: "%s",\n'
        '  credit: "%s",\n'
        "  tracks: {\n%s\n  }\n"
        "};\n"
        "/* " + MARK_END
    ) % (audio_dir, voice, credit, entries)

    start = html.index(MARK_BEGIN)
    end = html.index(MARK_END) + len(MARK_END)
    # newline="" keeps the page's own line endings; nothing else in it moves.
    with open(target, "w", encoding="utf-8", newline="") as fh:
        fh.write(html[:start] + block + html[end:])
    print("\nPatched %d durations into %s" % (len(tracks), page))


# --------------------------------------------------------------------------
# main
# --------------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--voice", default="bf_emma",
                    help="A voice name, or a blend: 'bm_george+bm_fable' for an "
                         "even mix, 'bf_emma*0.6+af_heart*0.4' for a weighted "
                         "one. Kokoro voices are style vectors, so they average. "
                         "Default bf_emma. See --list-voices.")
    ap.add_argument("--speed", type=float, default=0.9,
                    help="Default 0.9, which lands around 170 words per minute -- "
                         "Kokoro's 1.0 runs near 195, brisk for a teaching piece. "
                         "Listeners can still speed up in the player.")
    ap.add_argument("--lang", default=None,
                    help="Default: en-gb for b* voices, en-us otherwise.")
    ap.add_argument("--only", nargs="*", metavar="NN",
                    help="Chapter numbers to render, e.g. --only 04 09")
    ap.add_argument("--force", action="store_true",
                    help="Re-render even if the script has not changed.")
    ap.add_argument("--fetch-model", action="store_true",
                    help="Download the model files and exit.")
    ap.add_argument("--engine", default="kokoro",
                    choices=["kokoro", "chatterbox", "qwen"],
                    help="kokoro is the finished course voice. chatterbox and "
                         "qwen are zero-shot clones needing --ref; they write to "
                         "audio-chatterbox/ and audio-qwen/ so they can never "
                         "touch audio/. qwen is ~6x faster than chatterbox.")
    ap.add_argument("--ref-text", default=None,
                    help="Transcript of --ref, required by qwen (it clones "
                         "in-context). Defaults to the .txt file sitting beside "
                         "--ref, e.g. voice/reference-short.txt.")
    ap.add_argument("--batch", type=int, default=2,
                    help="Chunks per qwen generate call. 2 measured fastest on a "
                         "4 GB card (2.7x vs 4.4x at batch 1); 4 overflows to "
                         "5.07 GB and pages. Ignored by other engines.")
    ap.add_argument("--ref", default=None,
                    help="Reference recording for the clone engines. Mono 24 kHz. "
                         "Defaults to voice/reference-full.wav for chatterbox and "
                         "voice/reference-short.wav for qwen, which is faster "
                         "because a long reference bloats the prompt.")
    ap.add_argument("--out-dir", default=None,
                    help="Where the mp3s go. Defaults to audio/ for kokoro and "
                         "audio-clone/ for chatterbox.")
    ap.add_argument("--acronyms", dest="acronyms", action="store_true", default=None,
                    help="Force the espeak phonetic spellings on (default for "
                         "kokoro, off for chatterbox).")
    ap.add_argument("--no-acronyms", dest="acronyms", action="store_false",
                    help="Feed acronyms as written and let the engine say them.")
    ap.add_argument("--max-chars", type=int, default=140,
                    help="Longest chunk handed to chatterbox, in characters. "
                         "Lower means less VRAM per chunk, which on a 4 GB card "
                         "is what keeps kernels under the driver watchdog. 180 "
                         "reset the GPU mid-chapter; 140 is the safer default.")
    ap.add_argument("--device", default=None, choices=["cpu", "auto", "dml", "cuda"],
                    help="Where to run inference. 'dml' is DirectML, which works on "
                         "any DirectX 12 GPU on Windows without CUDA. 'auto' tries "
                         "accelerators then settles for CPU. Default cpu.")
    ap.add_argument("--list-voices", action="store_true")
    ap.add_argument("--page", default=None,
                    help="Page whose manifest is patched. Defaults to the page mapped "
                         "to the engine in PAGES.")
    args = ap.parse_args()

    if args.fetch_model:
        fetch_models()
        return

    clone = args.engine in ("chatterbox", "qwen")
    if args.device is None:
        args.device = "cuda" if clone else "cpu"
    if args.acronyms is None:
        args.acronyms = not clone
    if args.ref is None:
        args.ref = ("voice/reference-short.wav" if args.engine == "qwen"
                    else "voice/reference-full.wav")
    if clone and args.max_chars == 140 and args.engine == "qwen":
        # chatterbox needed 140 to stay under the driver watchdog; qwen's RTF
        # is flat with length, so chunks can follow paragraphs instead.
        args.max_chars = 180

    default_out = {"chatterbox": "audio-chatterbox", "qwen": "audio-qwen"}
    out_dir = (Path(args.out_dir) if args.out_dir
               else (ROOT / default_out[args.engine] if clone else AUDIO))
    if clone and out_dir.resolve() == AUDIO.resolve():
        sys.exit("Refusing to write clone output into %s -- that holds the "
                 "finished course. Pick another --out-dir." % AUDIO)

    try:
        import numpy as np
        import soundfile as sf
    except ImportError as exc:
        sys.exit("Missing dependency (%s). Run: pip install -r tools/requirements.txt"
                 % exc.name)

    kokoro = None
    engine = None
    voice, lang = args.voice, args.lang

    if args.engine == "qwen":
        ref_text = args.ref_text
        if ref_text is None:
            sidecar = Path(args.ref).with_suffix(".txt")
            if not sidecar.exists():
                sys.exit("Qwen needs the reference transcript. Put it in %s or "
                         "pass --ref-text." % sidecar)
            ref_text = sidecar.read_text(encoding="utf-8")
        elif Path(ref_text).exists():
            ref_text = Path(ref_text).read_text(encoding="utf-8")
        engine = QwenEngine(args.ref, ref_text,
                            "cuda:0" if args.device in ("cuda", "auto") else "cpu",
                            cache_dir=out_dir / ".chunks", batch=args.batch)
    elif clone:
        engine = ChatterboxEngine(args.ref,
                                  "cuda" if args.device in ("cuda", "auto") else "cpu",
                                  cache_dir=out_dir / ".chunks")
    else:
        require_models()
        try:
            from kokoro_onnx import Kokoro
        except ImportError as exc:
            sys.exit("Missing dependency (%s). Run: pip install -r "
                     "tools/requirements.txt" % exc.name)

        if args.device == "cpu":
            kokoro = Kokoro(str(MODELS / "kokoro-v1.0.onnx"),
                            str(MODELS / "voices-v1.0.bin"))
        else:
            kokoro = Kokoro.from_session(build_session(args.device),
                                         str(MODELS / "voices-v1.0.bin"))

        if args.list_voices:
            print("\n".join(sorted(kokoro.get_voices())))
            return

        voice, lang_default = resolve_voice(args.voice, kokoro)
        lang = args.lang or lang_default

    out_dir.mkdir(exist_ok=True)

    def join(pieces, rate):
        out = []
        for j, samples in enumerate(pieces):
            out.append(samples)
            if j < len(pieces) - 1:
                out.append(np.zeros(int(rate * GAP_SENTENCE), dtype=samples.dtype))
        return np.concatenate(out), rate

    if args.engine == "qwen":
        def render_block(block):
            pieces = engine.say_many(sentences(block, args.max_chars))
            engine.release()
            return join(pieces, engine.rate)
    elif clone:
        def render_block(block):
            chunks = sentences(block, args.max_chars)
            pieces = [engine.say(chunk) for chunk in chunks]
            engine.release()
            return join(pieces, engine.rate)
    else:
        def render_block(block):
            return kokoro.create(block, voice=voice, speed=args.speed, lang=lang)

    all_scripts = sorted(NARRATION.glob("[0-9][0-9]-*.txt"))
    if not all_scripts:
        sys.exit("No narration scripts found in %s" % NARRATION)

    todo = all_scripts
    if args.only:
        wanted = set(n.zfill(2) for n in args.only)
        todo = [s for s in all_scripts if s.name[:2] in wanted]

    stamp_path = out_dir / "stamps.json"
    stamps = json.loads(stamp_path.read_text()) if stamp_path.exists() else {}

    # carry forward durations for chapters we are not re-rendering
    tracks = {}
    for path in all_scripts:
        cid = "ch" + path.name[:2]
        if (out_dir / (cid + ".mp3")).exists() and cid in stamps:
            tracks[cid] = stamps[cid]["d"]

    rendered = 0.0
    started = time.time()

    for path in todo:
        cid = "ch" + path.name[:2]
        mp3 = out_dir / (cid + ".mp3")
        blocks = paragraphs(path, args.acronyms)
        key = hashlib.sha256(
            ("\x00".join(blocks) + "|%s|%s|%s|%s|%s|%s"
             % (args.voice, args.speed, lang, args.engine,
                args.ref if clone else "", args.max_chars if clone else "")
             ).encode("utf-8")).hexdigest()[:16]

        if not args.force and mp3.exists() and stamps.get(cid, {}).get("k") == key:
            print("%s  unchanged, skipping" % cid)
            continue

        if clone:
            n_chunks = sum(len(sentences(b, args.max_chars)) for b in blocks)
            print("%s  %2d paragraphs, %d chunks ..."
                  % (cid, len(blocks), n_chunks), flush=True)
        else:
            print("%s  %2d paragraphs ..." % (cid, len(blocks)), end="", flush=True)

        began = time.time()
        stats = None
        if args.engine == "qwen" and args.batch > 1:
            # Batch across the whole chapter rather than within a paragraph --
            # most paragraphs are a single chunk, so per-paragraph batching
            # would almost never fill a batch. This fills the disk cache; the
            # per-paragraph pass below then just reads it back, so the counts
            # worth reporting are the ones from here.
            engine.say_many([c for b in blocks
                             for c in sentences(b, args.max_chars)])
            stats = (engine.misses, engine.hits)
            engine.hits = engine.misses = 0

        pieces = []
        for i, block in enumerate(blocks):
            samples, rate = render_block(block)
            if clone:
                done = len(np.concatenate(pieces)) / rate if pieces else 0.0
                print("    para %2d/%2d  %5.1fs audio  %5.0fs elapsed"
                      % (i + 1, len(blocks), done, time.time() - began), flush=True)
            pieces.append(samples)
            if i < len(blocks) - 1:
                gap = GAP_OPENING if i == 0 else GAP_PARAGRAPH
                pieces.append(np.zeros(int(rate * gap), dtype=samples.dtype))

        audio = np.concatenate(pieces)
        peak = float(np.max(np.abs(audio))) or 1.0
        audio = (audio / peak) * 0.89          # even loudness across chapters

        sf.write(mp3, audio, SAMPLE_RATE, format="MP3",
                 bitrate_mode="VARIABLE", compression_level=0.4)

        duration = len(audio) / SAMPLE_RATE
        tracks[cid] = round(duration, 1)
        stamps[cid] = {"k": key, "d": round(duration, 1)}
        rendered += duration
        # Record each chapter as it lands. Writing only at the end means an
        # interrupted run loses every skip marker and re-does the assembly
        # pass for chapters that were already finished.
        stamp_path.write_text(json.dumps(stamps, indent=1))
        elapsed = time.time() - began
        print("%s %.1f min, %.1f MB  (%.0fs, RTF %.1fx)%s"
              % ("  " + cid if clone else "", duration / 60,
                 mp3.stat().st_size / 1e6, elapsed, elapsed / max(duration, 1e-9),
                 "  [%d new, %d cached]" % (stats or (engine.misses, engine.hits))
                 if clone else ""))
        if clone:
            engine.hits = engine.misses = 0

    stamp_path.write_text(json.dumps(stamps, indent=1))
    mapping = PAGES.get(args.engine)
    if mapping:
        page, credit = mapping
        page = args.page or page
        patch_html(tracks, args.voice, page, out_dir.name, credit)
    else:
        print("No page is mapped to engine %r, so no manifest was patched."
              % args.engine)

    if rendered:
        print("Rendered %.1f min of audio in %.1f min of wall clock"
              % (rendered / 60, (time.time() - started) / 60))
    megabytes = sum(f.stat().st_size for f in out_dir.glob("*.mp3")) / 1e6
    print("Course total: %.0f min across %d chapters, %.0f MB"
          % (sum(tracks.values()) / 60, len(tracks), megabytes))


if __name__ == "__main__":
    main()
