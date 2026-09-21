# Narration tools

The audio on the tutorial page is made from the plain-text scripts in
`narration/`, rendered locally with free, open-source software. No account, no
API key, nothing leaves the machine. These tools are the same in MCP 101 to 104;
`../mcp-101/tools/README.md` has the long version, including the voice-cloning
option.

| Script | What it does |
|---|---|
| `lint-narration.py` | Checks the scripts before rendering: one per chapter, the right opening line, a sensible length, nothing that does not read aloud (digits, symbols, identifiers), no initialism the pronunciation tables do not know. |
| `generate-audio.py` | Renders each script with Kokoro-82M into `audio-kokoro/chNN.mp3`, and writes the durations into the page between the `AUDIO-MANIFEST` markers. Reruns skip chapters whose script has not changed. |
| `verify-audio.py` | Checks the result without listening: every mp3 decodes, its length fits its script, nothing clips, no long silence, and the page's manifest agrees with the files. |

## Rendering

```sh
python tools/lint-narration.py
python tools/generate-audio.py --engine kokoro --device cuda --voice "bm_george+bm_fable" --page index.html
python tools/verify-audio.py audio-kokoro index.html
```

`--device cuda` needs `onnxruntime-gpu` and the `nvidia-*` CUDA wheels in the
environment (`../narrate-your-writing/requirements-kokoro-gpu.txt`). On a
GTX 1650 it renders at about a tenth of real time, so a course takes about
three minutes. `--device cpu` is the default and works everywhere, at roughly
real time. Asking for `cuda` and not getting it is an error, never a silent
fall back to the CPU.

The 350 MB model files are not in the repository. `python tools/generate-audio.py
--fetch-model` downloads them, or set `KOKORO_MODELS` to a folder that already
has them (the script also looks in a sibling `mcp-101/models`).

## Editing the narration

Edit `narration/*.txt`, not the pronunciation tables. The scripts are spoken
adaptations, not the page read aloud: numbers as words, initialisms plain
(`MCP`, `API`) or dotted (`I.A.M.`, `P.K.C.E.`), and a pointer to the interactive
panels rather than a recital of code or JSON. After a change, run the lint,
then render only that chapter with `--only 07`.

## The cloned voice

The default edition is read in Anuj's own voice, cloned with Qwen3-TTS
(Apache-2.0) from a few seconds of his recording. The recording is not in the
repository (it is exactly what someone would need to clone the voice), so the
render points at it in a sibling `mcp-101/voice/`:

```sh
python tools/generate-audio.py --engine qwen --voice "Anuj Sadani" --ref ../mcp-101/voice/reference-short.wav --page index.html
```

It needs a CUDA GPU and runs at about three times real time, so a course takes
about an hour and a half. Every synthesised chunk is cached on disk, so an
interrupted render resumes rather than restarts. Each chunk is also capped at
about twice the tokens its text needs: without the cap a chunk that never
emits its end token fills a 4 GB card and stalls the whole render. A chunk that
hits the cap is retried on its own.

`verify-audio.py audio-qwen index.html` allows longer natural pauses for this
voice than for the AI one. If it flags a long silence, find the chunk, delete its
`.npy` in `audio-qwen/.chunks/`, and rerun that chapter with `--only NN --force`.
