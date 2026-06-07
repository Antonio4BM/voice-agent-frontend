import { useState, useRef } from 'react';
import './panel.css';
import { MicVAD } from "@ricky0123/vad-web";
import { Play, Square, StopCircle} from 'lucide-react';
import UseWebRTCSession from '../hooks/use-webrtc-session';
import { toUint8Array, isAlignedPcmChunk} from '../protocol/pcm';
import { parseAgentMessage} from '../protocol/agent-messages';

function Panel() {
  const [status, setStatus] = useState('Stopped.');
  const sampleRate = useRef<number | null>(null);
  const channels = useRef<number | null>(null);
  const sampleWidth = useRef<number | null>(null);
  const audioChunksRef = useRef<Uint8Array[]>([]);
  const audioContextRef = useRef<AudioContext | null>(null);
  const vadRef = useRef<MicVAD | null>(null);
  const audioSourceRef = useRef<AudioBufferSourceNode | null>(null);
  const userSpeakingRef = useRef(false);
  const isReceivingAudioRef = useRef(false);
  const utteranceAbortedRef = useRef(false);
  const playBackQueueRef = useRef<{bytes: Uint8Array, sampleRate: number, channels: number}[]>([]);
  const isPlayingRef = useRef(false);
  const turnEndedRef = useRef(false);
  const { isSession, isSendingAudio, streamRef, sendControl, setIsSendingAudio, handleStart, cleanup } = UseWebRTCSession({
    handleMessageFromAgent: handleMessageFromAgent,
    setStatus: setStatus,
    onSessionEnd: onSessionEnd,
    startVAD: startVAD,
  });

  async function startVAD(){
    if (!vadRef.current){
      vadRef.current = await createVAD();
    }
    await vadRef.current.start();
  }

  async function onSessionEnd(){
    removeAudioSource();
    cleanupAudioState();
    if (vadRef.current) {
      await vadRef.current.destroy()
      vadRef.current = null;
    }
    audioChunksRef.current = [];
    utteranceAbortedRef.current = false;
    playBackQueueRef.current = [];
    isPlayingRef.current = false;
    turnEndedRef.current = false;
    userSpeakingRef.current = false;
    isReceivingAudioRef.current = false;
  }

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

  async function handleMessageFromAgent(event: MessageEvent) {
    try{
      if (typeof event.data === 'string') {
        console.log('Received message from agent', event.data);
        const parseResult = parseAgentMessage(event.data);
        if (!parseResult.success){
          console.error('Error parsing message', parseResult.error, parseResult.cause);
          return;
        }
        const agentMessage = parseResult.data;
        if (agentMessage.type === 'audio_abort'){
          console.log('Audio aborted');
          utteranceAbortedRef.current = false;
          isReceivingAudioRef.current = false;
          isPlayingRef.current = false;
          turnEndedRef.current = false;
          audioChunksRef.current = [];
          playBackQueueRef.current = [];
          cleanupAudioState();
          removeAudioSource();
          return;
        }else if (agentMessage.type === 'audio_start'){
          if (userSpeakingRef.current) {
            console.log('Audio start skipped');
            return
          }; // if the utterance was aborted or the user is speaking, don't start the audio stream
          turnEndedRef.current = false;
          utteranceAbortedRef.current = false;
          isReceivingAudioRef.current = true;
          sampleRate.current = agentMessage.sample_rate;
          channels.current = agentMessage.channels;
          sampleWidth.current = agentMessage.sample_width;
          audioChunksRef.current = [];
        } else if (agentMessage.type === 'sentence_audio_end'){ // the agent sends a sentence audio end signal
          if (userSpeakingRef.current || utteranceAbortedRef.current) { // if the user is speaking, don't play the audio
            audioChunksRef.current = [];
            return;
          }
          const temp_rate = sampleRate.current;
          const temp_channels = channels.current;
          if (temp_rate == null || temp_channels == null) {
            console.error('sentence_audio_end without audio_start');
            audioChunksRef.current = [];
            return;
          } 
          const merged = concatChunks(audioChunksRef.current);
          audioChunksRef.current = [];
          enqueueAudio(merged, temp_rate ?? 0, temp_channels ?? 0);
        } else if (agentMessage.type === 'audio_end'){ // the agent is done sending audio
          turnEndedRef.current = true;
          isReceivingAudioRef.current = false;
          cleanupAudioState();
          audioChunksRef.current = [];
          void drainPlaybackQueue();
          maybeFinishTurn();
        }
      }else{ // if the message is not a string, it is audio data
        console.log('Received audio data');
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

  async function playOneSentence(bytes: Uint8Array, sampleRate: number, channels: number) {
    const audioContext =
      audioContextRef.current ?? new AudioContext();
    audioContextRef.current = audioContext;
    if (audioContext.state === 'suspended') {
      await audioContext.resume();
    }
    if (userSpeakingRef.current || utteranceAbortedRef.current) return false; // if the user is speaking, don't play the audio
    
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

    const source = audioContext.createBufferSource();
    audioSourceRef.current = source;
    source.buffer = audioBuffer;
    source.connect(audioContext.destination);
    
    source.onended = () => {
      if(audioSourceRef.current === source) audioSourceRef.current = null;
      isPlayingRef.current = false;
      void drainPlaybackQueue();
    }

    if (userSpeakingRef.current || utteranceAbortedRef.current) return false; // if the user is speaking, don't start the audio source
    source.start();
    return true;
  }

  function maybeFinishTurn() {
    if (!turnEndedRef.current) return;
    if (isPlayingRef.current) return;
    if (playBackQueueRef.current.length > 0) return;
    removeAudioSource(); // safe: idle + queue empty + turn over
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
        utteranceAbortedRef.current = true;
        userSpeakingRef.current = true;
        audioChunksRef.current = [];
        isReceivingAudioRef.current = false;
        playBackQueueRef.current = [];
        isPlayingRef.current = false;
        turnEndedRef.current = false;
        removeAudioSource();
        sendControl('interrupt');
      },
      onSpeechEnd: () => {
        console.log("Speech ended");
        userSpeakingRef.current = false;
        sendControl('resume');
      }
    });

    return vad;

}

  function cleanupAudioState(){
    sampleRate.current = null;
    channels.current = null;
    sampleWidth.current = null;
  }

  function enqueueAudio(merged: Uint8Array, sampleRate: number, channels: number){
    if (merged.length === 0) return;
    playBackQueueRef.current.push({
      bytes: merged,
      sampleRate: sampleRate,
      channels: channels,
    });
    void drainPlaybackQueue();
  }

  async function drainPlaybackQueue() {
    if (isPlayingRef.current) return;
    if (userSpeakingRef.current || utteranceAbortedRef.current) return;
  
    const next = playBackQueueRef.current.shift();
    if (!next) {
      maybeFinishTurn();
      return;
    }
  
    isPlayingRef.current = true;
    const started = await playOneSentence(next.bytes, next.sampleRate, next.channels);
    if (!started) {
      isPlayingRef.current = false;
      void drainPlaybackQueue(); // try next item or finish
    }
  }

  async function handleMuteAndResumeAgent() {
    const vad = vadRef.current;
    if(vad){
      await vad.pause();
    }
    sendControl('resume');
    setIsSendingAudio(false);
    isReceivingAudioRef.current = false;
    utteranceAbortedRef.current = false;
    playBackQueueRef.current = [];
    isPlayingRef.current = false;
    turnEndedRef.current = false;
    audioChunksRef.current = [];
    cleanupAudioState();
    removeAudioSource();
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
