# Audio Agent (WebRTC Frontend)

Frontend app for streaming microphone audio to a backend over WebRTC, receiving agent TTS audio on a data channel, and using client-side voice activity detection (VAD) to avoid talking over the user.

- App version: `0.0.0` (from `package.json`)
- Stack: React 19 + TypeScript + Vite 7 + Zod 4
- UI: single panel with **Start**, **Pause**, and **Stop** controls (Lucide icons)

## What it does

- Creates a WebRTC peer connection from the browser.
- Captures microphone audio with `getUserMedia`.
- Sends SDP offer to backend signaling endpoint.
- Applies SDP answer returned by the backend.
- Opens an ordered WebRTC data channel (`voice-agent`) for agent audio and control signals.
- Plays agent TTS as PCM16 chunks streamed over the data channel.
- Runs **voice activity detection** (`@ricky0123/vad-web`) on the mic stream:
  - When the user **starts** speaking: stops local playback, discards in-flight agent audio, and sends an **interrupt** signal so the backend stops sending audio to the client.
  - While the user is speaking: ignores incoming agent audio chunks.
  - When the user **stops** speaking: sends a **resume** signal so the backend can continue sending audio to the client.
- **Start**: begins or resumes sending audio (reuses an existing peer connection when possible).
- **Pause**: pauses VAD, mutes the mic track, and keeps the WebRTC session open.
- **Stop**: tears down the peer connection, VAD, mic stream, and playback.

VAD model assets (ONNX + WASM) are copied into the build output under `/vad/` via `vite-plugin-static-copy`.

## Message contract

### Data channel

- Name: `voice-agent`
- Ordered: `true`

### Client → backend (control signals)

All control messages are JSON text on the data channel:

```json
{ "type": "signal", "action": "<action>" }
```


| Action            | When sent                          | Purpose                                                        |
| ----------------- | ---------------------------------- | -------------------------------------------------------------- |
| `interrupt_audio` | User starts speaking (VAD)         | Tell backend to stop sending agent audio to the client         |
| `resume_audio`    | User stops speaking (VAD)          | Tell backend it may continue sending agent audio to the client |


**Interrupt** (user starts speaking):

```json
{
  "type": "signal",
  "action": "interrupt_audio"
}
```

**Resume** (user finishes speaking):

```json
{
  "type": "signal",
  "action": "resume_audio"
}
```

### Backend → client (agent audio)

**Stream start** — JSON text message (validated on receive):

```json
{
  "type": "audio_start",
  "sample_rate": 24000,
  "channels": 1,
  "sample_width": 2
}
```

`sample_width` must be `2` (16-bit PCM). The client buffers binary messages only while receiving an active audio stream.

**Audio payload** — binary `ArrayBuffer` chunks (little-endian PCM16). Ignored while the user is speaking or when not in an active audio stream.

**Stream end** — JSON text message:

```json
{
  "type": "audio_end"
}
```

On `audio_end`, buffered chunks are merged and played via the Web Audio API. If the user is still speaking, playback is skipped and the buffer is cleared.

## Validation and protocol handling

The messages is validated in two layers:

### Inbound JSON (`audio_start`, `audio_end`)

- Parsed with `parseAgentMessage()` in `src/protocol/agent-messages.ts`.
- Uses Zod schemas for strict typing (`sample_rate` positive int, `channels` 1-2, `sample_width` 2).
- Invalid JSON or schema → logged and message dropped.

### Binary PCM chunks

- Validated in `src/protocol/pcm.ts` while an audio stream is active.
- Chunks must be aligned to the frame size (`sample_width x channels` bytes).
- Misaligned or unexpected binary messages are rejected.

### Outbound signals

- `interrupt_audio` and `resume_audio` are built with Zod before send.

## Run locally

### Prerequisites

- Node.js 20+
- npm 10+
- A backend server implementing `POST /offer` and the message contract on the `voice-agent` data channel

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
- `src/protocol/agent-messages.ts`: Zod schemas, `parseAgentMessage()`, interrupt/resume signals.
- `src/protocol/pcm.ts`: PCM alignment and binary message helpers.
- `src/App.tsx`: app root rendering the panel.
- `vite.config.ts`: Vite + React plugin; copies VAD/ONNX runtime assets to `vad/`.
- `Dockerfile`, `docker-compose.yaml`: containerized production deploy.

## Notes and limitations

- Microphone permission is required in the browser.
- Agent audio playback supports PCM16 only (`sample_width === 2`).
- VAD uses model `v5` with assets served from `/vad/`.
- The client does not play `audio_end` TTS if the user is speaking when the stream ends.
- Binary messages are only accepted while an active `audio_start` stream is in progress (or after `audio_end` for aligned chunks still in buffer).

