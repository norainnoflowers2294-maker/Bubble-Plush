# Bubble Plush

A soft, offline chat companion. It runs entirely on your phone: no account, no
server, no network calls — not even to download the model.

<p align="center">
  <img src="assets/icons/icon-512.png" width="96" alt="Bubble Plush icon">
</p>

## What it is

A single-page PWA with a small, quiet interface: one chat, one personality, one
model. The language model runs locally in WebAssembly via
[wllama](https://github.com/ngxson/wllama) (llama.cpp compiled to wasm), and
everything it produces is stored in the browser's own storage.

Design rule for the whole app: **no extra shit.** If a screen, control or
animation doesn't help you talk to the model, it isn't there.

- **Offline-first.** The entire shell (HTML, CSS, JS, fonts, icons, the wasm
  runtime) is precached by a service worker. After the first visit the app
  boots with the radio off.
- **Model once, then never again.** You pick a `.gguf` file from the phone's
  file picker exactly once. It is copied into the app's private storage (OPFS,
  with an IndexedDB fallback) and loads itself on every launch afterwards.
- **Chats persist.** Conversations and settings live in IndexedDB. Reload,
  close the app, come back tomorrow — the last conversation is on screen.
- **Mobile-first, iOS-first.** Safe-area insets, a visual-viewport height fix
  for the on-screen keyboard, `enterkeyhint="send"`, Home Screen meta tags.
- **Soft by design.** Warm off-white background, one saturated pink (your
  messages only), white cards for the model. The only flourish is the orb,
  which breathes while the model is thinking.

## Run it

Service workers and OPFS need a secure context, so `file://` will not work.

```bash
python3 scripts/serve.py          # http://localhost:12000
```

Then open the printed URL. `localhost` counts as secure, so everything works
there. Any other host must be HTTPS.

`scripts/serve.py` exists instead of `python3 -m http.server` because it serves
`.wasm` as `application/wasm` (needed for `instantiateStreaming`) and disables
caching, which keeps service-worker iterations sane.

### On an iPhone

1. Serve the folder over HTTPS (any static host works — it's just files).
2. Open it in Safari, then **Share → Add to Home Screen**.
3. Launch it from the Home Screen so it runs standalone, without Safari's bars.

## Bring a model

Bubble Plush does not ship with a model and never downloads one. You supply a
GGUF file:

1. Get a **chat/instruct** model in GGUF format, quantised to `Q4_K_M` or
   similar. Good phone-sized choices are in the 0.5B–1.5B parameter range
   (roughly 300 MB – 1.2 GB).
2. On the phone, save the `.gguf` somewhere the Files app can see (AirDrop,
   iCloud Drive, a download).
3. Open Bubble Plush → **Choose .gguf** → pick the file.
4. Wait for "Copying the model…" to finish. It now loads automatically at every
   launch.

A base (non-instruct) model will still run, but it will happily continue your
text instead of answering you. The app is tuned for chat models.

Removing the model (Settings → Remove) deletes only the model file; chats stay.

## How it works

```
index.html ──► js/main.js        app controller: state, model lifecycle, chat loop
                 ├─ js/ui.js      view: DOM only, never touches storage or wllama
                 ├─ js/db.js      IndexedDB: conversations, settings, model fallback
                 ├─ js/model-store.js  OPFS import/read/delete (+ IDB fallback)
                 ├─ js/llm.js     prompt building + wllama streaming wrapper
                 └─ js/config.js  all the knobs
sw.js ──► precaches the shell, cache-first, version-bumped by hand
```

**Prompting.** wllama is stateless, so every turn rebuilds the prompt from
IndexedDB: system prompt, then a sliding window of the last ten user/assistant
pairs, then the new message. The window is also trimmed by a character budget
derived from the context size, because ten long messages can still overflow a
4096-token window. `js/llm.js#buildPrompt` is pure and easy to unit-test.

**Streaming.** `localModel.generate()` is an async generator yielding cumulative
text, so the UI just repaints one bubble. An `AbortController` stops generation;
whatever streamed so far is kept.

**Why wllama 2.4.0, single-thread.** It is self-contained (one JS file plus a
2.7 MB wasm) and needs neither `SharedArrayBuffer` nor COOP/COEP headers — which
a static, backend-less site cannot set. Newer wllama builds pull in a ~28 MB
JSPI/compat payload for Safari, which is a bad trade for a phone app that must
work offline. The runtime is vendored in `vendor/wllama/` (MIT, licence
included) so there is no CDN dependency at runtime.

**Storage layout.**

| What | Where | Why |
| --- | --- | --- |
| Model weights | OPFS `models/model.gguf` | big file, streamed in, private to the origin |
| Model weights (fallback) | IndexedDB `model` store | older iOS Safari without `createWritable()` |
| Conversations | IndexedDB `conversations` | source of truth for history |
| Settings, model metadata | IndexedDB `meta` | tiny key/value records |
| App shell | Cache API | precached by the service worker |

## Project layout

```
index.html               single page: header, log, composer, settings sheet
css/tokens.css           design tokens (colour, type, spacing, motion)
css/app.css              all component styles
js/                      the app (see map above)
vendor/wllama/           pinned inference runtime + licence
assets/fonts/            self-hosted Inter + Outfit (woff2, latin subset)
assets/icons/            PWA icons, favicon
scripts/serve.py         local dev server
scripts/make-icons.py    regenerates the icon PNGs (needs Pillow + numpy)
sw.js                    offline shell
manifest.webmanifest     PWA metadata
```

## Development notes

- **Bump `SHELL_VERSION`** in `sw.js` (and `APP.shellVersion` in `js/config.js`)
  whenever any precached file changes. The worker is cache-first, so without a
  bump an installed app keeps serving the old shell. The old cache is deleted
  on activate.
- New runtime files must be added to the `SHELL` array in `sw.js`, otherwise
  they will not be available offline.
- Icons are generated, not hand-drawn: `python3 scripts/make-icons.py` after
  editing its constants.
- No build step, no bundler, no dependencies at runtime. Edit a file, reload.

## Known limits

- WebAssembly inference is CPU-bound: expect a few tokens per second on a phone
  for a ~1B model, faster for smaller ones. Replies are capped at 512 tokens.
- Model size is bounded by wasm memory and the browser's storage quota. Very
  large models will fail to load — the app says so instead of hanging.
- One model, one conversation at a time. That is the product, not an oversight.
- Text only. Output is rendered as plain text (never HTML), so there is no
  markdown, no code blocks, and no injection surface.

## Licence

App code: yours to use. wllama: MIT (see `vendor/wllama/LICENCE`). Fonts: SIL
Open Font License (Inter, Outfit).