# Audio Agent (WebRTC Frontend)

Frontend app for streaming microphone audio to a backend over WebRTC, receiving agent TTS audio on a data channel, and using client-side voice activity detection (VAD) to avoid talking over the user.

- App version: `0.0.0` (from `package.json`)
- Stack: React 19 + TypeScript + Vite 7
- UI: single panel with **Start**, **Pause**, and **Stop** controls (Lucide icons)

## What it does

- Creates a WebRTC peer connection from the browser.
- Captures microphone audio with `getUserMedia`.
- Sends SDP offer to backend signaling endpoint: `POST http://localhost:8080/offer`.
- Applies SDP answer returned by the backend.
- Opens an ordered WebRTC data channel (`voice-agent`) for agent audio and control signals.
- Plays agent TTS as PCM16 chunks streamed over the data channel.
- Runs **voice activity detection** (`@ricky0123/vad-web`) on the mic stream:
  - When the user starts speaking: stops local playback, discards in-flight agent audio, and sends `stop_audio` to the backend.
  - While the user is speaking: ignores incoming agent audio chunks.
  - When the user stops speaking: agent audio can be received and played again.
- **Start**: begins or resumes sending audio (reuses an existing peer connection when possible).
- **Pause**: pauses VAD, mutes the mic track, and sends `stop_audio` while keeping the WebRTC session open.
- **Stop**: tears down the peer connection, VAD, mic stream, and playback.

VAD model assets (ONNX + WASM) are copied into the build output under `/vad/` via `vite-plugin-static-copy`.

## Message contract

### Data channel

- Name: `voice-agent`
- Ordered: `true`

### Stop signal (client → backend)

Sent on Pause, when the user starts speaking (VAD), or when the data channel opens if a stop was queued while the channel was closed:

```json
{
  "type": "signal",
  "action": "stop_audio"
}
```

### Agent TTS (backend → client)

**Stream start** — JSON text message:

```json
{
  "type": "audio_start",
  "sample_rate": 24000,
  "channels": 1,
  "sample_width": 2
}
```

`sample_width` must be `2` (16-bit PCM). The client buffers binary messages until stream end.

**Audio payload** — binary `ArrayBuffer` chunks (little-endian PCM16). Ignored while the user is speaking.

**Stream end** — JSON text message:

```json
{
  "type": "audio_end"
}
```

On `audio_end`, buffered chunks are merged and played via the Web Audio API. If the user is still speaking, playback is skipped and the buffer is cleared.

## Run locally

### Prerequisites

- Node.js 20+
- npm 10+
- A backend server running on `http://localhost:8080` implementing `POST /offer` and the message contract on the `voice-agent` data channel

### Install

```bash
npm install
```

### Start development server

```bash
npm run dev
```

Then open the local URL shown by Vite (usually `http://localhost:5173`).

### Build for production

```bash
npm run build
```

Production output includes VAD assets under `dist/vad/`.

### Preview production build

```bash
npm run preview
```

### Lint

```bash
npm run lint
```

## Docker

Build and serve the static app with nginx:

```bash
docker compose up --build
```

The compose file maps host port **81** to container port **80** and attaches to an external Docker network `agent-network` (create it first if needed: `docker network create agent-network`).

Multi-stage `Dockerfile`: Node 22 builds the Vite app; nginx serves `dist/`.

## Project structure

- `src/components/panel.tsx`: WebRTC session, VAD, TTS playback, and UI actions.
- `src/components/panel.css`: panel and control styling.
- `src/App.tsx`: app root rendering the panel.
- `vite.config.ts`: Vite + React plugin; copies VAD/ONNX runtime assets to `vad/`.
- `Dockerfile`, `docker-compose.yaml`: containerized production deploy.

## Notes and limitations

- Microphone permission is required in the browser.
- Agent audio playback supports PCM16 only (`sample_width === 2`).
- VAD uses model `v5` with assets served from `/vad/`
