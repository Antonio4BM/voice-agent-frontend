# Audio Agent (WebRTC Frontend)

Frontend app for streaming microphone audio to a backend over WebRTC, receiving agent TTS audio on a data channel, and using client-side voice activity detection (VAD) to avoid talking over the user.

- App version: `0.0.0` (from `package.json`)
- Stack: React 19 + TypeScript + Vite 7 + Zod 4
- UI: single panel with **Start**, **Stop**, and **Mute Mic** controls.

## What it does

- Creates a WebRTC peer connection from the browser.
- Captures microphone audio with `getUserMedia`.
- Sends SDP offer to the backend signaling endpoint.
- Applies SDP answer returned by the backend.
- Opens an ordered WebRTC data channel (`voice-agent`) for agent audio and control signals.
- Plays agent TTS as PCM16 chunks streamed over the data channel (sentence-by-sentence playback queue).
- Runs **voice activity detection** (`@ricky0123/vad-web`) on the mic stream:
  - When the user **starts** speaking: stops local playback, discards in-flight agent audio, and sends an **interrupt** signal so the backend stops sending audio to the client.
  - While the user is speaking: ignores incoming agent audio chunks.
  - When the user **stops** speaking: sends a **resume** signal so the backend can continue sending audio to the client.
- **Start**: begins or resumes sending audio (reuses an existing peer connection when possible).
- **Mute Mic**: pauses VAD, mutes the mic track, clears playback state, and keeps the WebRTC session open.
- **Stop**: tears down the peer connection, mic stream, and playback; VAD is destroyed via session cleanup.

VAD model assets (ONNX + WASM) are copied into the build output under `/vad/` via `vite-plugin-static-copy`.

## Architecture

Logic is split between a WebRTC hook and the panel component. The panel orchestrates VAD, agent playback, and UI; the hook owns transport and control-signal delivery.

### `useWebRTCSession` (`src/hooks/use-webrtc-session.ts`)

Owns WebRTC session lifecycle:

- `RTCPeerConnection`, `MediaStream`, and `voice-agent` data channel refs
- `handleStart()` — mic capture, offer/answer exchange, session state
- `cleanup()` — closes peer connection and stops tracks; delegates app reset to `onSessionEnd`
- `sendControl('interrupt' | 'resume')` — sends Zod-validated control JSON on the data channel, with pending-signal flush when the channel opens
- Session state: `isSession`, `isSendingAudio`

Accepts callbacks from the panel:

| Callback | Purpose |
| -------- | ------- |
| `handleMessageFromAgent` | Data-channel message handler (agent protocol + playback) |
| `setStatus` | Update status text shown in the UI |
| `onSessionEnd` | Reset VAD, playback queues, and related refs after WebRTC teardown |
| `startVAD` | Create/start VAD after the WebRTC session is ready |

### `Panel` (`src/components/panel.tsx`)

Owns everything outside WebRTC transport:

- UI and status display
- Agent message handling (`handleMessageFromAgent`) — parse JSON, buffer binary PCM, enqueue sentences for playback
- TTS playback via Web Audio API (PCM16 decode, playback queue, interrupt on user speech)
- VAD setup (`createVAD`, `startVAD`) using `streamRef` from the hook
- **Mute Mic** — pauses VAD, clears playback, calls `sendControl('resume')`, keeps connection alive

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
| `resume_audio`    | User stops speaking (VAD) or Mute Mic | Tell backend it may continue sending agent audio to the client |

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

Control signals are built with Zod in `useWebRTCSession` and sent through `sendControl()`. If the data channel is not open yet, the latest intent is queued and flushed on `onopen`.

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

**Sentence end** — JSON text message:

```json
{
  "type": "sentence_audio_end"
}
```

Buffered chunks since the last `audio_start` (or previous sentence) are merged and enqueued for playback. Skipped if the user is speaking.

**Stream end** — JSON text message:

```json
{
  "type": "audio_end"
}
```

Marks the agent turn as complete. Remaining queued sentences continue playing; playback state is finalized when the queue drains.

**Abort** — JSON text message:

```json
{
  "type": "audio_abort"
}
```

Clears buffers and playback immediately (agent cancelled the current utterance).

## Validation and protocol handling

Messages are validated in two layers:

### Inbound JSON (`audio_start`, `sentence_audio_end`, `audio_end`, `audio_abort`)

- Parsed with `parseAgentMessage()` in `src/protocol/agent-messages.ts`.
- Uses Zod schemas for strict typing (`sample_rate` positive int, `channels` 1-2, `sample_width` 2).
- Invalid JSON or schema → logged and message dropped.

### Binary PCM chunks

- Validated in `src/protocol/pcm.ts` while an audio stream is active.
- Chunks must be aligned to the frame size (`sample_width x channels` bytes).
- Misaligned or unexpected binary messages are rejected.

### Outbound signals

- `interrupt_audio` and `resume_audio` are built with Zod in `useWebRTCSession` before send.

## Configuration

| Variable | Description |
| -------- | ----------- |
| `VITE_OFFER_URL` | Backend signaling URL for `POST` SDP offer (set in `.env` for local dev and Docker builds) |


## Run locally

### Prerequisites

- Node.js 20+
- npm 10+
- A backend server implementing the signaling endpoint and the message contract on the `voice-agent` data channel

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

The compose file maps host port **81** to container port **80**, passes `VITE_OFFER_URL` from `.env`, and attaches to an external Docker network `agent-network` (create it first if needed: `docker network create agent-network`).

Multi-stage `Dockerfile`: Node 22 builds the Vite app; nginx serves `dist/`.

## Project structure

```
src/
├── components/
│   ├── panel.tsx          # UI, VAD, agent playback, session orchestration
│   └── panel.css          # panel and control styling
├── hooks/
│   └── use-webrtc-session.ts  # WebRTC peer connection, data channel, sendControl
├── protocol/
│   ├── agent-messages.ts  # Zod schemas, parseAgentMessage(), signal schemas
│   └── pcm.ts             # PCM alignment and binary message helpers
├── App.tsx                # app root rendering the panel
└── main.tsx               # React entry point
```

Other files:

- `vite.config.ts` — Vite + React plugin; copies VAD/ONNX runtime assets to `vad/`
- `Dockerfile`, `docker-compose.yaml` — containerized production deploy

## Notes and limitations

- Agent audio playback supports PCM16 only (`sample_width === 2`).
- VAD uses model `v5` with assets served from `/vad/`.
- Sentence playback is skipped if the user is speaking when `sentence_audio_end` arrives.
- Binary messages are only accepted while an active `audio_start` stream is in progress.
