import { createContext, ReactNode, useCallback, useContext, useMemo, useRef, useState } from 'react';

import { API_BASE_URL } from './config';
import { useAuth } from './auth';
import { isLiveMicAvailable } from './liveMicStream';

type LiveCaptionStatus =
  | 'idle'
  | 'connecting'
  | 'active'
  | 'listening'
  | 'unavailable'
  | 'error';

type LiveCaptionsContextValue = {
  isConnected: boolean;
  isConnecting: boolean;
  status: LiveCaptionStatus;
  error: string | null;
  latestCaption: string;
  partialCaption: string;
  finalCaptions: string[];
  startLiveCaptions: (sampleRate?: number) => Promise<void>;
  stopLiveCaptions: () => void;
  sendAudioChunk: (chunk: ArrayBuffer) => void;
  resetCaptions: () => void;
  canStreamMicrophoneAudio: boolean;
};

const LiveCaptionsContext = createContext<LiveCaptionsContextValue | null>(null);

// The current Expo Go recorder path writes compressed audio files, but does not
// expose live microphone PCM frames. Keep this explicit so the UI never implies
// captions are active when no audio can actually reach the backend.
const EXPO_GO_LIMITATION = 'Live captions require the Youmi Lens development build. Recording still works.';
const RECENT_FINAL_CAPTION_LIMIT = 8;

function toWsUrl(apiBaseUrl: string): string {
  const trimmed = apiBaseUrl.replace(/\/$/, '');
  if (/^wss?:\/\//i.test(trimmed)) return `${trimmed}/api/live-realtime-ws`;
  if (/^https?:\/\//i.test(trimmed)) return `${trimmed.replace(/^http/i, 'ws')}/api/live-realtime-ws`;
  return '';
}

export function LiveCaptionsProvider({ children }: { children: ReactNode }) {
  const { session } = useAuth();
  const socketRef = useRef<WebSocket | null>(null);
  const intentionalCloseRef = useRef(false);
  const [status, setStatus] = useState<LiveCaptionStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [latestCaption, setLatestCaption] = useState('');
  const [partialCaption, setPartialCaption] = useState('');
  const [finalCaptions, setFinalCaptions] = useState<string[]>([]);

  const resetCaptions = useCallback(() => {
    setLatestCaption('');
    setPartialCaption('');
    setFinalCaptions([]);
  }, []);

  const stopLiveCaptions = useCallback(() => {
    intentionalCloseRef.current = true;
    const socket = socketRef.current;
    socketRef.current = null;
    if (socket && socket.readyState === WebSocket.OPEN) {
      try {
        socket.send(JSON.stringify({ type: 'stream_stop' }));
      } catch {
        // best effort only
      }
    }
    socket?.close();
    setStatus('idle');
    setPartialCaption('');
  }, []);

  const startLiveCaptions = useCallback(async (sampleRate = 48_000) => {
    if (!isLiveMicAvailable()) {
      setStatus('unavailable');
      setError(EXPO_GO_LIMITATION);
      return;
    }

    if (!API_BASE_URL) {
      setStatus('error');
      setError('Live captions are unavailable because the API base URL is missing.');
      return;
    }

    const token = session?.access_token;
    if (!token) {
      setStatus('error');
      setError('Please sign in to use live captions.');
      return;
    }

    const wsUrl = toWsUrl(API_BASE_URL);
    if (!wsUrl) {
      setStatus('error');
      setError('Live captions are unavailable because the API base URL is invalid.');
      return;
    }

    stopLiveCaptions();
    intentionalCloseRef.current = false;
    setStatus('connecting');
    setError(null);

    const socket = new WebSocket(wsUrl);
    socket.binaryType = 'arraybuffer';
    socketRef.current = socket;

    socket.onopen = () => {
      socket.send(JSON.stringify({ type: 'stream_start', sampleRate, token }));
    };

    socket.onmessage = (event) => {
      let message: { type?: string; text?: string; message?: string; code?: string } | null = null;
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }

      if (!message) return;

      if (message.type === 'stream_ready') {
        setStatus('listening');
      } else if (message.type === 'stream_interim' && message.text) {
        setStatus('active');
        setPartialCaption(message.text);
        setLatestCaption(message.text);
      } else if (message.type === 'stream_final' && message.text) {
        setStatus('active');
        setPartialCaption('');
        setLatestCaption(message.text);
        const finalText = message.text;
        setFinalCaptions((current) => [...current, finalText].slice(-RECENT_FINAL_CAPTION_LIMIT));
      } else if (message.type === 'stream_error') {
        setStatus('error');
        setError(message.message ?? message.code ?? 'Live captions are unavailable.');
      }
    };

    socket.onerror = () => {
      setStatus('error');
      setError('Could not connect to live captions. Audio recording is still active.');
    };

    socket.onclose = () => {
      socketRef.current = null;
      if (!intentionalCloseRef.current) {
        setStatus('error');
        setError('Live captions disconnected. Audio recording is still active.');
      }
    };
  }, [session?.access_token, stopLiveCaptions]);

  const sendAudioChunk = useCallback((chunk: ArrayBuffer) => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    socket.send(chunk);
  }, []);

  const value = useMemo<LiveCaptionsContextValue>(
    () => ({
      isConnected: status === 'active' || status === 'listening',
      isConnecting: status === 'connecting',
      status,
      error,
      latestCaption,
      partialCaption,
      finalCaptions,
      startLiveCaptions,
      stopLiveCaptions,
      sendAudioChunk,
      resetCaptions,
      canStreamMicrophoneAudio: isLiveMicAvailable(),
    }),
    [
      error,
      finalCaptions,
      latestCaption,
      partialCaption,
      resetCaptions,
      sendAudioChunk,
      startLiveCaptions,
      status,
      stopLiveCaptions,
    ],
  );

  return <LiveCaptionsContext.Provider value={value}>{children}</LiveCaptionsContext.Provider>;
}

export function useLiveCaptions(): LiveCaptionsContextValue {
  const context = useContext(LiveCaptionsContext);
  if (!context) throw new Error('useLiveCaptions must be used within a LiveCaptionsProvider');
  return context;
}
