import { useState, useRef } from 'react';

import { ResumeSignalSchema, InterruptSignalSchema} from '../protocol/agent-messages';

const OFFER_URL = import.meta.env.VITE_OFFER_URL;
type ControlAction = 'interrupt' | 'resume' | null;

function UseWebRTCSession({
    handleMessageFromAgent,
    setStatus,
    onSessionEnd,
    startVAD,
}: {
    handleMessageFromAgent: (event: MessageEvent) => void;
    setStatus: (status: string) => void;
    onSessionEnd: () => Promise<void>;
    startVAD: () => Promise<void>;
}) {

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

    const pendingControlRef = useRef<ControlAction>(null);

    const streamRef = useRef<MediaStream | null>(null);
    const pcRef = useRef<RTCPeerConnection | null>(null);
    const dcRef = useRef<RTCDataChannel | null>(null);

    const [isSendingAudio, setIsSendingAudio] = useState(false);
    const [isSession, setIsSession] = useState(false);


    async function cleanup() {
        dcRef.current = null;
        pendingControlRef.current = null;
        if (streamRef.current) {
          streamRef.current.getTracks().forEach((t) => t.stop());
          streamRef.current = null;
        }
        if (pcRef.current) {
          pcRef.current.close();
          pcRef.current = null;
        }
        setIsSession(false);
        setIsSendingAudio(false);
        setStatus('Connection closed.');
        await onSessionEnd();
    }
    
    async function handleStart() {
        try {
          // verify if there is an active session
          if (pcRef.current && streamRef.current && isSession){
    
            // unmute the microphone
            for (const t of streamRef.current.getAudioTracks()){
                t.enabled = true;
            }

            await startVAD();
    
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
    
          await startVAD();
    
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

    function sendControlToDataChannel(dc: RTCDataChannel | null, action: ControlAction): boolean {
        if (dc?.readyState !== 'open') return false;

        try{
            const payload = action === 'interrupt' ? INTERRUPT_SIGNAL_JSON : RESUME_SIGNAL_JSON;
            dc.send(payload);
            pendingControlRef.current = null;
            return true
        }catch(error){
            console.error("Error sending control signal", error);
            return false;
        }
    }

    function sendControl(action: ControlAction) {
        if (!sendControlToDataChannel(dcRef.current, action)) {
            pendingControlRef.current = action;
        }
    }

    function flushPendingControlOnOpen(dc: RTCDataChannel) {
        const pending = pendingControlRef.current;
        if (!pending) return;
        sendControlToDataChannel(dc, pending)
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

    return {
        isSession,
        isSendingAudio,
        streamRef,
        sendControl,
        setIsSendingAudio,
        handleStart,
        cleanup,
    }


}

export default UseWebRTCSession;