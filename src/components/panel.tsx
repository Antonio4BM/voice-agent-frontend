import { useState, useRef } from 'react';
import './panel.css';
import { Play, Square, StopCircle} from 'lucide-react';
import { MicVAD } from "@ricky0123/vad-web";
import { ResumeSignalSchema, InterruptSignalSchema, parseAgentMessage} from '../protocol/agent-messages';
import { toUint8Array, isAlignedPcmChunk} from '../protocol/pcm';

const OFFER_URL = import.meta.env.VITE_OFFER_URL;

const RESUME_SIGNAL_JSON = JSON.stringify(
  ResumeSignalSchema.parse({
    type: 'signal',
    action: 'resume_audio',
  })
);

const INTERRUPT_SIGNAL_JSON = JSON.stringify(
  InterruptSignalSchema.parse({
    type: 'signal',
    action: 'interrupt_audio',
  })
);
type PendingControl = 'interrupt' | 'resume' | null;

function Panel() {
  const [status, setStatus] = useState('Stopped.');
  /** Negotiated WebRTC session (PC + mic stream). */
  const [isSession, setIsSession] = useState(false);
  /** Audio track is enabled and RTP is being sent. */
  const [isSendingAudio, setIsSendingAudio] = useState(false);
  const streamRef = useRef<MediaStream | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const dcRef = useRef<RTCDataChannel | null>(null);
  const sampleRate = useRef<number | null>(null);
  const channels = useRef<number | null>(null);
  const sampleWidth = useRef<number | null>(null);
  const audioChunksRef = useRef<Uint8Array[]>([]);
  const audioContextRef = useRef<AudioContext | null>(null);
  const vadRef = useRef<MicVAD | null>(null);
  const audioSourceRef = useRef<AudioBufferSourceNode | null>(null);
  const userSpeakingRef = useRef(false);
  const isReceivingAudioRef = useRef(false);
  const pendingControlRef = useRef<PendingControl>(null);

  function concatChunks(chunks: Uint8Array[]) {
    const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }
    return merged;
  }

  function removeAudioSource(){
    if (audioSourceRef.current) {
      try{
        audioSourceRef.current.stop();
      }catch(error){
        console.error("audio source already stopped");
      }
      audioSourceRef.current.disconnect();
      audioSourceRef.current = null;
    }
  }

  async function playPcm16(bytes: Uint8Array, sampleRate: number, channels: number) {
    const audioContext =
      audioContextRef.current ?? new AudioContext();
    audioContextRef.current = audioContext;
    if (audioContext.state === 'suspended') {
      await audioContext.resume();
    }
    const sampleCount = bytes.length / 2 / channels;
    const audioBuffer = audioContext.createBuffer(channels, sampleCount, sampleRate);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let i = 0; i < sampleCount; i++) {
      for (let ch = 0; ch < channels; ch++) {
        const byteOffset = (i * channels + ch) * 2;
        const sample = view.getInt16(byteOffset, true); // little-endian PCM16
        audioBuffer.getChannelData(ch)[i] = sample / 32768;
      }
    }
    removeAudioSource(); // remove any existing audio source
    const source = audioContext.createBufferSource();
    audioSourceRef.current = source;
    source.buffer = audioBuffer;
    source.connect(audioContext.destination);
    source.start();
  }

  function sendOrQueueControl(dc: RTCDataChannel | null, action: 'interrupt' | 'resume') {
    const payload = action === 'interrupt' ? INTERRUPT_SIGNAL_JSON : RESUME_SIGNAL_JSON;
  
    if (dc?.readyState === 'open') {
      try {
        dc.send(payload);
        pendingControlRef.current = null;
        return;
      } catch {
        // fall through to queue
      }
    }
  
    // channel not open or send failed: queue latest intent
    pendingControlRef.current = action;
  }

  function flushPendingControlOnOpen(dc: RTCDataChannel) {
    const pending = pendingControlRef.current;
    if (!pending) return;
  
    const payload = pending === 'interrupt' ? INTERRUPT_SIGNAL_JSON : RESUME_SIGNAL_JSON;
    try {
      dc.send(payload);
      pendingControlRef.current = null;
    } catch {
      // keep pending for a future reopen
    }
  }

  async function handleMessageFromAgent(event: MessageEvent) {
    try{
      if (typeof event.data === 'string') {
        const parseResult = parseAgentMessage(event.data);
        if (!parseResult.success){
          console.error('Error parsing message', parseResult.error, parseResult.cause);
          return;
        }
        const agentMessage = parseResult.data;
        if (agentMessage.type === 'audio_start'){
          isReceivingAudioRef.current = true;
          sampleRate.current = agentMessage.sample_rate;
          channels.current = agentMessage.channels;
          sampleWidth.current = agentMessage.sample_width;
          audioChunksRef.current = [];
        } else if (agentMessage.type === 'audio_end'){ // the agent is done sending audio
          isReceivingAudioRef.current = false;
          
          const temp_rate = sampleRate.current;
          const temp_channels = channels.current;

          sampleRate.current = null;
          channels.current = null;
          sampleWidth.current = null;
          if (userSpeakingRef.current) { // if the user is speaking, don't play the audio
            audioChunksRef.current = [];
            return;
          }
          const merged = concatChunks(audioChunksRef.current);
          audioChunksRef.current = [];
          if (merged.length === 0) return; // if the merged audio is empty, don't play it
          if (temp_rate == null || temp_channels == null) {
            console.error('audio_end without audio_start');
            return;
          } 
          await playPcm16(merged, temp_rate, temp_channels);
        }
      }else{ // if the message is not a string, it is audio data
        if (userSpeakingRef.current) return; // if the user is speaking, don't add the audio chunks

        if (!isReceivingAudioRef.current) {
          console.warn("Received audio data while not receiving audio");
          return;
        }

        if (channels.current == null || sampleWidth.current == null) {
          console.warn('Received audio data while not receiving audio metadata');
          return;
        }

        const bytes = toUint8Array(event.data);
        if (bytes == null) {
          console.warn('Received invalid audio data');
          return;
        }

        if (!isAlignedPcmChunk(bytes, channels.current, sampleWidth.current)) {
          console.warn('Received audio data that is not aligned with the audio metadata');
          return;
        }

        audioChunksRef.current.push(bytes);
      }
    } catch(error) {
      console.error("Error parsing message from agent", error);
    }
  }


  function attachDataChannel(
    dc: RTCDataChannel,
    dcRef: { current: RTCDataChannel | null },
  ) {
    dcRef.current = dc;
    dc.onopen = () => flushPendingControlOnOpen(dc);
    dc.onmessage = (event) => handleMessageFromAgent(event);
    dc.onclose = () => {
      if (dcRef.current === dc) dcRef.current = null;
    };
  }

  async function cleanup() {
    dcRef.current = null;
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    if (vadRef.current) {
      await vadRef.current.destroy()
      vadRef.current = null;
    }
    if (pcRef.current) {
      pcRef.current.close();
      pcRef.current = null;
    }
    removeAudioSource();
    setIsSession(false);
    setIsSendingAudio(false);
    setStatus('Connection closed.');
    userSpeakingRef.current = false;
    isReceivingAudioRef.current = false;
    sampleRate.current = null;
    channels.current = null;
    sampleWidth.current = null;
    audioChunksRef.current = [];
    pendingControlRef.current = null;
  }

  async function getStream(){
    setStatus('Getting microphone…');
    // if the stream is already open, return it
    if (pcRef.current && streamRef.current) {
      for (const t of streamRef.current.getAudioTracks()) {
        t.enabled = true;
      }
      setIsSendingAudio(true);
      setStatus('Recording… Audio is being sent to the server.');
      return streamRef.current;
    }
    // if the stream is not open, get it from the microphone
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: false,
    });
    streamRef.current = stream;
    return stream;
  }

  async function createVAD(){

    const vad = await MicVAD.new({
      model: "v5",     
      baseAssetPath: "/vad/",
      onnxWASMBasePath: "/vad/",
      startOnLoad: false, // prevent vad from starting automatically
      getStream: async() => {
        const stream_aux = streamRef.current;
        if (!stream_aux){
          throw new Error("Stream not found");
        }
        return stream_aux;
      },
      pauseStream: async (stream_aux: MediaStream) => {
        stream_aux.getTracks().forEach((t) => {t.enabled = false;});
      },
      resumeStream: async (stream_aux: MediaStream) => {
        stream_aux.getTracks().forEach((t) => {t.enabled = true});
        return stream_aux;
      },
      onSpeechRealStart: () => {
        console.log("Speech started");
        userSpeakingRef.current = true;
        audioChunksRef.current = [];
        isReceivingAudioRef.current = false;
        removeAudioSource();
        const dc = dcRef.current;
        sendOrQueueControl(dc, 'interrupt');
      },
      onSpeechEnd: () => {
        console.log("Speech ended");
        userSpeakingRef.current = false;
        const dc = dcRef.current;
        sendOrQueueControl(dc, 'resume');
      }
    });

    return vad;

  }

  async function handleStart() {
    try {
      // verify if there is an active session
      if (pcRef.current && streamRef.current && isSession){

        // unmute the microphone
        for (const t of streamRef.current.getAudioTracks()){
          t.enabled = true;
        }

        // check if vad is already initialized
        if (!vadRef.current){
          vadRef.current = await createVAD();
        }
        await vadRef.current.start();

        setIsSendingAudio(true);
        setStatus('Recording… Audio is being sent to the server.');
        return;

      }

      const stream = await getStream();

      setStatus('Creating offer…');
      const pc = new RTCPeerConnection();
      pcRef.current = pc;
      pc.addTrack(stream.getAudioTracks()[0], stream);

      // data channel for voice agent 
      const dc = pc.createDataChannel('voice-agent', { ordered: true });
      attachDataChannel(dc, dcRef);

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      // check if vad is already initialized
      if (!vadRef.current){
        vadRef.current = await createVAD();
      }
      await vadRef.current.start();

      const response = await fetch(OFFER_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sdp: pc.localDescription!.sdp,
          type: pc.localDescription!.type,
        }),
      });

      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error((err as { error?: string }).error || response.statusText);
      }

      const answer = await response.json();
      await pc.setRemoteDescription(new RTCSessionDescription(answer));

      setIsSession(true);
      setIsSendingAudio(true);
      setStatus('Recording… Audio is being sent to the server.');
    } catch (err) {
      setStatus('Stopped.');
      await cleanup();
    }
  }

  async function handleMuteAndResumeAgent() {
    const vad = vadRef.current;
    if(vad){
      await vad.pause();
    }
    const dc = dcRef.current;
    sendOrQueueControl(dc, 'resume');
    setIsSendingAudio(false);
    isReceivingAudioRef.current = false;
    audioChunksRef.current = [];
    setStatus('Audio muted — connection stays open.');
  }

  const startDisabled = isSendingAudio;
  const stopDisabled = !isSession || !isSendingAudio;

  return (
    <div className="panel">
      <h2>WebRTC Audio</h2>
      <div className="panel-controls">
        <button onClick={handleStart} disabled={startDisabled}>
          <Play size={16} />
          <span>Start</span>
        </button>
        <button onClick={cleanup} disabled={stopDisabled}>
          <Square size={16} />
          <span>Stop</span>
        </button>
        <button onClick={handleMuteAndResumeAgent} disabled={!isSession}>
          <StopCircle size={16}/>
          <span>Mute Mic</span>
        </button>
      </div>
      <p className="panel-status">{status}</p>
    </div>
  );
}

export default Panel;
