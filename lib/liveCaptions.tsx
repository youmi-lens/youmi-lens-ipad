import { createContext, ReactNode, useCallback, useContext, useMemo, useRef, useState } from 'react';

import { API_BASE_URL } from './config';
import {
  LiveCaptionDiagnosticSnapshot,
  LiveCaptionUnavailableReason,
  logLiveCaptionEvent,
  logLiveCaptionUnavailable,
} from './liveCaptionDiagnostics';
import { getLiveMicStreamStatus, isLiveMicAvailable } from './liveMicStream';
import { supabase } from './supabase';
import type { ContentLanguage } from './models';
import { resolveIncomingTranslation } from './contentLanguages.mjs';

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
  partialTranslationZh: string;
  partialTranslatedText: string;
  captionLines: LiveCaptionLine[];
  latestFinalLine: LiveCaptionLine | null;
  finalCaptions: string[];
  startLiveCaptions: (sampleRate?: number, sourceLanguage?: ContentLanguage, translationLanguage?: ContentLanguage) => Promise<void>;
  stopLiveCaptions: () => void;
  sendAudioChunk: (chunk: ArrayBuffer) => void;
  resetCaptions: () => void;
  canStreamMicrophoneAudio: boolean;
};

export type LiveCaptionLine = {
  id: string;
  text: string;
  translationZh?: string;
  translatedText?: string;
  isFinal: boolean;
  createdAt: string;
};

const LiveCaptionsContext = createContext<LiveCaptionsContextValue | null>(null);

// The Expo Go recorder path cannot expose live microphone PCM frames. Keep this
// explicit so the UI never implies captions are active when no audio can reach
// the backend. This message is calm and is safe to show as-is.
const EXPO_GO_LIMITATION = 'Live captions require the Youmi Lens development build. Recording still works.';
/** The single calm, user-facing message for any real Live Caption failure. */
const CAPTIONS_UNAVAILABLE_MESSAGE = 'Live captions unavailable. Recording is still active.';
// ── WebSocket recovery tuning ──────────────────────────────────────────────────
/** Consecutive failed reconnects before giving up. Reset to 0 once stream_ready arrives. */
const MAX_REALTIME_RECONNECT_ATTEMPTS = 2;
/** Backoff before reconnect attempt 1 and 2. */
const RECONNECT_BACKOFF_MS = [800, 1800];
/** WS must reach OPEN within this window or the attempt is treated as failed. */
const WS_OPEN_TIMEOUT_MS = 6_000;
/** After stream_start, the backend must send stream_ready within this window. */
const STREAM_READY_TIMEOUT_MS = 10_000;

function toWsUrl(apiBaseUrl: string): string {
  const trimmed = apiBaseUrl.replace(/\/$/, '');
  if (/^wss?:\/\//i.test(trimmed)) return `${trimmed}/api/live-realtime-ws`;
  if (/^https?:\/\//i.test(trimmed)) return `${trimmed.replace(/^http/i, 'ws')}/api/live-realtime-ws`;
  return '';
}

function wsReadyStateLabel(socket: WebSocket | null): string {
  if (!socket) return 'none';
  switch (socket.readyState) {
    case WebSocket.CONNECTING:
      return 'connecting';
    case WebSocket.OPEN:
      return 'open';
    case WebSocket.CLOSING:
      return 'closing';
    case WebSocket.CLOSED:
      return 'closed';
    default:
      return 'unknown';
  }
}

/** Fetch the freshest Supabase access token (auto-refreshes if expired). */
async function getFreshAccessToken(): Promise<string | null> {
  try {
    const { data } = await supabase.auth.getSession();
    return data.session?.access_token ?? null;
  } catch {
    return null;
  }
}

/**
 * Classify a backend `stream_error`. Fatal errors (auth/quota) cannot be fixed
 * by reconnecting; transient ones (upstream ASR drop) should reconnect.
 */
function classifyStreamError(
  code: string,
  message: string,
): { reason: LiveCaptionUnavailableReason; fatal: boolean } {
  const c = code.toLowerCase();
  const m = message.toLowerCase();
  if (c.includes('auth') || m.includes('sign in required')) {
    return { reason: 'token_expired', fatal: true };
  }
  if (c.includes('limit') || c.includes('quota') || c.includes('suspended') || m.includes('limit reached')) {
    return { reason: 'backend_stream_error', fatal: true };
  }
  // A missing / unconfigured server-side provider key (e.g. DASHSCOPE_KEY_MISSING
  // on a dev backend with no AI credentials) can NEVER be resolved by
  // reconnecting. Treating it as transient made the pipeline reconnect forever,
  // leaving the UI stuck on "Connecting live captions…" while recording ran
  // underneath. It is fatal for this session — stop retrying and surface the
  // recoverable "captions unavailable" state; recording is unaffected.
  if (
    c.includes('key_missing') || m.includes('key_missing') ||
    m.includes('missing key') || m.includes('not configured') || m.includes('no api key')
  ) {
    return { reason: 'backend_stream_error', fatal: true };
  }
  if (m.includes('deepgram') || m.includes('upstream')) {
    return { reason: 'deepgram_upstream_drop', fatal: false };
  }
  return { reason: 'backend_stream_error', fatal: false };
}

export function LiveCaptionsProvider({ children }: { children: ReactNode }) {
  const socketRef = useRef<WebSocket | null>(null);
  const intentionalCloseRef = useRef(false);
  const sampleRateRef = useRef(48_000);
  const sourceLanguageRef = useRef<ContentLanguage>('en');
  const translationLanguageRef = useRef<ContentLanguage>('zh-Hans');
  const captionSequenceRef = useRef(0);

  // WebSocket recovery state.
  const reconnectAttemptsRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const openTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const readyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const streamReadyRef = useRef(false);
  const pendingReasonRef = useRef<LiveCaptionUnavailableReason | null>(null);
  /** Breaks the connect ⇄ scheduleReconnect callback cycle. */
  const connectRef = useRef<(token: string) => void>(() => {});

  // Diagnostics — refs only, so the PCM hot path never triggers a re-render.
  const lastWsEventRef = useRef<string | null>(null);
  const lastCloseCodeRef = useRef<number | null>(null);
  const lastCloseReasonRef = useRef<string | null>(null);
  const tokenPresentRef = useRef(false);
  const pcmFramesSentRef = useRef(0);
  const lastPcmAtRef = useRef<string | null>(null);

  const [status, setStatus] = useState<LiveCaptionStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [latestCaption, setLatestCaption] = useState('');
  const [partialCaption, setPartialCaption] = useState('');
  const [partialTranslationZh, setPartialTranslationZh] = useState('');
  const [partialTranslatedText, setPartialTranslatedText] = useState('');
  const [captionLines, setCaptionLines] = useState<LiveCaptionLine[]>([]);

  const resetCaptions = useCallback(() => {
    setLatestCaption('');
    setPartialCaption('');
    setPartialTranslationZh('');
    setPartialTranslatedText('');
    setCaptionLines([]);
  }, []);

  const clearTimers = useCallback(() => {
    for (const ref of [reconnectTimerRef, openTimerRef, readyTimerRef]) {
      if (ref.current) {
        clearTimeout(ref.current);
        ref.current = null;
      }
    }
  }, []);

  /** Lightweight, secret-free snapshot of the live pipeline for diagnostics. */
  const buildSnapshot = useCallback((): Partial<LiveCaptionDiagnosticSnapshot> => {
    const mic = getLiveMicStreamStatus();
    return {
      wsState: wsReadyStateLabel(socketRef.current),
      lastWsEvent: lastWsEventRef.current,
      lastCloseCode: lastCloseCodeRef.current,
      lastCloseReason: lastCloseReasonRef.current,
      backendReady: streamReadyRef.current,
      streamReadyReceived: streamReadyRef.current,
      tokenPresent: tokenPresentRef.current,
      micStarted: Boolean(mic.nativeRecorderStarted),
      micFramesReceived: mic.framesReceived,
      pcmFramesSent: pcmFramesSentRef.current,
      lastPcmAt: lastPcmAtRef.current,
      retryAttempted: Boolean(mic.retryAttempted),
      reconnectAttempts: reconnectAttemptsRef.current,
      screen: 'recording_session',
    };
  }, []);

  /** Stop trying — show the single calm message and log a structured snapshot. */
  const giveUp = useCallback(
    (reason: LiveCaptionUnavailableReason) => {
      intentionalCloseRef.current = true;
      clearTimers();
      const socket = socketRef.current;
      socketRef.current = null;
      if (socket) {
        try {
          socket.onopen = socket.onmessage = socket.onerror = socket.onclose = null;
          socket.close();
        } catch {
          // ignore
        }
      }
      logLiveCaptionUnavailable(reason, buildSnapshot());
      setStatus('unavailable');
      setError(CAPTIONS_UNAVAILABLE_MESSAGE);
      setPartialCaption('');
    },
    [buildSnapshot, clearTimers],
  );

  /** Reconnect after backoff, or give up once the attempt budget is exhausted. */
  const scheduleReconnect = useCallback(
    (reason: LiveCaptionUnavailableReason) => {
      if (intentionalCloseRef.current) return;
      const attempt = reconnectAttemptsRef.current; // 0-based index of this attempt
      if (attempt >= MAX_REALTIME_RECONNECT_ATTEMPTS) {
        logLiveCaptionEvent('reconnect_exhausted', { reason, attempts: attempt });
        giveUp(reason);
        return;
      }
      reconnectAttemptsRef.current = attempt + 1;
      const delay = RECONNECT_BACKOFF_MS[attempt] ?? RECONNECT_BACKOFF_MS[RECONNECT_BACKOFF_MS.length - 1];
      logLiveCaptionEvent('reconnect_scheduled', { reason, attempt: attempt + 1, delayMs: delay });
      setStatus('connecting');
      setError(null);
      setPartialCaption('');
      reconnectTimerRef.current = setTimeout(async () => {
        reconnectTimerRef.current = null;
        if (intentionalCloseRef.current) return;
        const token = await getFreshAccessToken();
        tokenPresentRef.current = Boolean(token);
        if (!token) {
          giveUp('token_missing');
          return;
        }
        logLiveCaptionEvent('reconnect_attempt', { attempt: attempt + 1 });
        connectRef.current(token);
      }, delay);
    },
    [giveUp],
  );

  /** Open one WebSocket, send stream_start, and wire timeouts + recovery. */
  const connect = useCallback(
    (token: string) => {
      const wsUrl = toWsUrl(API_BASE_URL);
      if (!wsUrl) {
        giveUp('unknown');
        return;
      }

      // Detach + close any prior socket so its onclose cannot trigger recovery.
      const prev = socketRef.current;
      socketRef.current = null;
      if (prev) {
        try {
          prev.onopen = prev.onmessage = prev.onerror = prev.onclose = null;
          prev.close();
        } catch {
          // ignore
        }
      }
      clearTimers();
      streamReadyRef.current = false;
      lastWsEventRef.current = 'connecting';
      setStatus('connecting');
      setError(null);
      setPartialCaption('');

      const socket = new WebSocket(wsUrl);
      socket.binaryType = 'arraybuffer';
      socketRef.current = socket;

      // The socket must reach OPEN within the window or the attempt has failed.
      openTimerRef.current = setTimeout(() => {
        openTimerRef.current = null;
        if (socketRef.current !== socket || socket.readyState === WebSocket.OPEN) return;
        logLiveCaptionEvent('ws_open_timeout', { timeoutMs: WS_OPEN_TIMEOUT_MS });
        socketRef.current = null;
        try {
          socket.onclose = null;
          socket.close();
        } catch {
          // ignore
        }
        scheduleReconnect('stream_start_timeout');
      }, WS_OPEN_TIMEOUT_MS);

      socket.onopen = () => {
        if (socketRef.current !== socket) return;
        if (openTimerRef.current) {
          clearTimeout(openTimerRef.current);
          openTimerRef.current = null;
        }
        lastWsEventRef.current = 'open';
        try {
          socket.send(JSON.stringify({
            type: 'stream_start', sampleRate: sampleRateRef.current, token,
            sourceLanguage: sourceLanguageRef.current,
            translationLanguage: translationLanguageRef.current,
          }));
        } catch {
          // ignore — onclose will handle it
        }
        logLiveCaptionEvent('stream_start_sent', { sampleRate: sampleRateRef.current });

        // The backend must answer with stream_ready, or this attempt has failed.
        readyTimerRef.current = setTimeout(() => {
          readyTimerRef.current = null;
          if (socketRef.current !== socket || streamReadyRef.current) return;
          logLiveCaptionEvent('stream_ready_timeout', { timeoutMs: STREAM_READY_TIMEOUT_MS });
          socketRef.current = null;
          try {
            socket.onclose = null;
            socket.close();
          } catch {
            // ignore
          }
          scheduleReconnect('stream_ready_timeout');
        }, STREAM_READY_TIMEOUT_MS);
      };

      socket.onmessage = (event) => {
        if (socketRef.current !== socket) return;
        let message: {
          type?: string;
          id?: string;
          text?: string;
          transcript?: string;
          caption?: string;
          translation_zh?: string;
          translated_text?: string;
          is_final?: boolean;
          message?: string;
          code?: string;
        } | null = null;
        try {
          message = JSON.parse(String(event.data));
        } catch {
          return;
        }
        if (!message) return;

        const rawCaptionText =
          typeof message.text === 'string'
            ? message.text
            : typeof message.transcript === 'string'
              ? message.transcript
              : typeof message.caption === 'string'
                ? message.caption
                : '';

        if (message.type === 'stream_ready') {
          streamReadyRef.current = true;
          if (readyTimerRef.current) {
            clearTimeout(readyTimerRef.current);
            readyTimerRef.current = null;
          }
          reconnectAttemptsRef.current = 0; // healthy connection — reset the budget
          pendingReasonRef.current = null;
          lastWsEventRef.current = 'stream_ready';
          logLiveCaptionEvent('stream_ready');
          setStatus('listening');
          setError(null);
        } else if (message.type === 'stream_interim' && rawCaptionText) {
          lastWsEventRef.current = 'stream_interim';
          setStatus('active');
          setPartialCaption(rawCaptionText);
          setLatestCaption(rawCaptionText);
        } else if (message.type === 'stream_final' && rawCaptionText) {
          lastWsEventRef.current = 'stream_final';
          setStatus('active');
          setPartialCaption('');
          setPartialTranslationZh('');
          setPartialTranslatedText('');
          setLatestCaption(rawCaptionText);
          const id = message.id ?? `final_${Date.now()}_${captionSequenceRef.current++}`;
          setCaptionLines((current) =>
            [
              ...current,
              { id, text: rawCaptionText, isFinal: true, createdAt: new Date().toISOString() },
            ],
          );
        } else if (message.type === 'stream_translation' && message.id) {
          // The lecture snapshot is authoritative. Ignore stale/legacy backend
          // translations when source === target, and never treat a legacy
          // Chinese-only event as another target language's generic output.
          const translation = resolveIncomingTranslation(
            sourceLanguageRef.current,
            translationLanguageRef.current,
            message.translated_text,
            message.translation_zh,
          );
          if (!translation) return;
          const translationId = message.id;
          if (message.is_final === false) {
            setPartialTranslationZh(translation);
            setPartialTranslatedText(translation);
            return;
          }
          setCaptionLines((current) => {
            if (current.some((line) => line.id === translationId)) {
              return current.map((line) =>
                line.id === translationId ? {
                  ...line, translatedText: translation,
                  ...(translationLanguageRef.current === 'zh-Hans' ? { translationZh: translation } : {}),
                } : line,
              );
            }
            const lastIndex = current.length - 1;
            if (lastIndex >= 0) {
              return current.map((line, index) =>
                index === lastIndex ? {
                  ...line, translatedText: translation,
                  ...(translationLanguageRef.current === 'zh-Hans' ? { translationZh: translation } : {}),
                } : line,
              );
            }
            return current;
          });
        } else if (message.type === 'stream_error') {
          const code = typeof message.code === 'string' ? message.code : '';
          const rawMessage = typeof message.message === 'string' ? message.message : '';
          const { reason, fatal } = classifyStreamError(code, rawMessage);
          lastWsEventRef.current = 'stream_error';
          logLiveCaptionEvent('backend_stream_error', {
            code,
            detail: rawMessage.slice(0, 120),
            reason,
            fatal,
          });
          if (fatal) {
            pendingReasonRef.current = null;
            giveUp(reason);
          } else {
            // Transient: the backend closes the socket next; onclose reconnects.
            pendingReasonRef.current = reason;
          }
        }
      };

      socket.onerror = () => {
        if (socketRef.current !== socket) return;
        lastWsEventRef.current = 'error';
        if (!pendingReasonRef.current) pendingReasonRef.current = 'websocket_error';
        // A WS error is always followed by onclose, which drives the reconnect.
      };

      socket.onclose = (event) => {
        if (socketRef.current !== socket) return; // already superseded
        socketRef.current = null;
        lastWsEventRef.current = 'close';
        lastCloseCodeRef.current = typeof event.code === 'number' ? event.code : null;
        lastCloseReasonRef.current = event.reason || null;
        if (openTimerRef.current) {
          clearTimeout(openTimerRef.current);
          openTimerRef.current = null;
        }
        if (readyTimerRef.current) {
          clearTimeout(readyTimerRef.current);
          readyTimerRef.current = null;
        }
        if (intentionalCloseRef.current) {
          setStatus('idle');
          return;
        }
        const reason = pendingReasonRef.current ?? 'websocket_closed';
        pendingReasonRef.current = null;
        logLiveCaptionEvent('ws_closed_unexpected', {
          code: lastCloseCodeRef.current,
          reason: lastCloseReasonRef.current,
          classified: reason,
        });
        scheduleReconnect(reason);
      };
    },
    [clearTimers, giveUp, scheduleReconnect],
  );

  connectRef.current = connect;

  const stopLiveCaptions = useCallback(() => {
    intentionalCloseRef.current = true;
    clearTimers();
    reconnectAttemptsRef.current = 0;
    pendingReasonRef.current = null;
    streamReadyRef.current = false;
    const socket = socketRef.current;
    socketRef.current = null;
    if (socket) {
      try {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: 'stream_stop' }));
        }
      } catch {
        // best effort
      }
      try {
        socket.onopen = socket.onmessage = socket.onerror = socket.onclose = null;
        socket.close();
      } catch {
        // ignore
      }
    }
    setStatus('idle');
    setPartialCaption('');
  }, [clearTimers]);

  const startLiveCaptions = useCallback(
    async (sampleRate = 48_000, sourceLanguage: ContentLanguage = 'en', translationLanguage: ContentLanguage = 'zh-Hans') => {
      if (!isLiveMicAvailable()) {
        setStatus('unavailable');
        setError(EXPO_GO_LIMITATION);
        return;
      }
      if (!API_BASE_URL || !toWsUrl(API_BASE_URL)) {
        logLiveCaptionUnavailable('unknown', buildSnapshot());
        setStatus('unavailable');
        setError(CAPTIONS_UNAVAILABLE_MESSAGE);
        return;
      }

      // Fully tear down any prior session (incl. pending reconnect timers).
      stopLiveCaptions();
      intentionalCloseRef.current = false;
      reconnectAttemptsRef.current = 0;
      pendingReasonRef.current = null;
      streamReadyRef.current = false;
      pcmFramesSentRef.current = 0;
      lastPcmAtRef.current = null;
      lastCloseCodeRef.current = null;
      lastCloseReasonRef.current = null;
      sampleRateRef.current = sampleRate;
      sourceLanguageRef.current = sourceLanguage;
      translationLanguageRef.current = translationLanguage;

      // Part 7: always connect with a fresh token (Supabase refreshes if stale).
      const token = await getFreshAccessToken();
      tokenPresentRef.current = Boolean(token);
      if (!token) {
        logLiveCaptionUnavailable('token_missing', buildSnapshot());
        setStatus('unavailable');
        setError(CAPTIONS_UNAVAILABLE_MESSAGE);
        return;
      }

      connect(token);
    },
    [buildSnapshot, connect, stopLiveCaptions],
  );

  const sendAudioChunk = useCallback((chunk: ArrayBuffer) => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    try {
      socket.send(chunk);
      pcmFramesSentRef.current += 1;
      lastPcmAtRef.current = new Date().toISOString();
    } catch {
      // Socket closed mid-send — onclose handles recovery.
    }
  }, []);

  const value = useMemo<LiveCaptionsContextValue>(() => {
    const latestFinalLine = captionLines[captionLines.length - 1] ?? null;
    return {
      isConnected: status === 'active' || status === 'listening',
      isConnecting: status === 'connecting',
      status,
      error,
      latestCaption,
      partialCaption,
      partialTranslationZh,
      partialTranslatedText,
      captionLines,
      latestFinalLine,
      finalCaptions: captionLines.map((line) => line.text),
      startLiveCaptions,
      stopLiveCaptions,
      sendAudioChunk,
      resetCaptions,
      canStreamMicrophoneAudio: isLiveMicAvailable(),
    };
  }, [
    error,
    captionLines,
    latestCaption,
    partialCaption,
    partialTranslationZh,
    partialTranslatedText,
    resetCaptions,
    sendAudioChunk,
    startLiveCaptions,
    status,
    stopLiveCaptions,
  ]);

  return <LiveCaptionsContext.Provider value={value}>{children}</LiveCaptionsContext.Provider>;
}

export function useLiveCaptions(): LiveCaptionsContextValue {
  const context = useContext(LiveCaptionsContext);
  if (!context) throw new Error('useLiveCaptions must be used within a LiveCaptionsProvider');
  return context;
}
