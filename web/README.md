# OpenMazelingo Web prototype

This prototype turns OpenMazelingo's document processing into a reusable pipeline that is not tied to a Chrome content script.

## What it does

1. Accepts pasted Japanese or English text.
2. Normalizes and splits it into bounded chunks.
3. Translates chunks sequentially with Chrome's Translator API when available.
4. Stores a canonical bilingual cache (`original`, `translated`, sentence pairs, language metadata).
5. Applies a deterministic mix plan on top of the cache.
6. Lets the user change mix ratio or direction without translating again.
7. Exports the bilingual cache as JSON.

## Run locally

Serve the repository root with any static HTTP server, then open `/web/`.

For example:

```sh
python3 -m http.server 8080
```

Then open `http://localhost:8080/web/` in a Chrome build that supports the Translator API.

Opening `index.html` directly as a `file://` URL is not recommended because browser AI APIs can depend on secure/allowed origins.

## Architecture direction

`core/mazelingo-core.js` intentionally knows nothing about Chrome extension messaging or TTS. Translation is injected through the `translateChunk` callback. This makes the same core usable by:

- the existing extension
- this standalone web UI
- a future HTTP API
- PDF / EPUB / subtitle importers
- future OpenAI-compatible translation or TTS backends

TTS is intentionally left out of this first prototype. The bilingual cache should be the stable boundary: a future TTS scheduler can consume the deterministic mix plan and route Japanese and English sentences to separate workers without re-running translation.

## Known prototype limitation

Sentence pairing currently aligns source and translated chunks by punctuation/order. A translation engine may merge or split sentences, so production code should use a structured translation adapter or explicit sentence IDs when exact alignment is required.
