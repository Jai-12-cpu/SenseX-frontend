import React, { useEffect, useState, useRef, useCallback } from 'react';
import {
  StyleSheet,
  View,
  Text,
  Vibration,
  Platform,
  TouchableOpacity,
  ScrollView,
  SafeAreaView,
  ActivityIndicator,
  TextInput,
  PanResponder,
  Keyboard,
} from 'react-native';
import * as Speech from 'expo-speech';
import * as Haptics from 'expo-haptics';
import { Audio } from 'expo-av';

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const WS_URL = 'wss://sensex-backend.onrender.com/ws/haptics';
const BACKEND_URL = 'https://sensex-backend.onrender.com';
const RECONNECT_DELAY = 3000;
const PING_INTERVAL = 25000;

const QUICK_PHRASES = [
  { label: 'Yes', pattern: [100] },
  { label: 'No', pattern: [300] },
  { label: 'Help', pattern: [500, 200, 500] },
  { label: 'Thanks', pattern: [100, 100, 100] },
  { label: 'Wait', pattern: [200, 100, 200] },
  { label: 'Repeat', pattern: [100, 100, 300] },
];

// ─── MAIN COMPONENT ───────────────────────────────────────────────────────────
export default function SensEx() {
  const [wsStatus, setWsStatus] = useState<'connecting' | 'connected' | 'disconnected'>('connecting');
  const [mode, setMode] = useState<'listen' | 'type'>('listen');
  const [isRecording, setIsRecording] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [transcribedText, setTranscribedText] = useState('');
  const [typedText, setTypedText] = useState('');
  const [lastAction, setLastAction] = useState('');

  const ws = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pingTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const recordingRef = useRef<Audio.Recording | null>(null);
  const isConnecting = useRef(false);
  const inputRef = useRef<TextInput>(null);

  // ── WebSocket ──────────────────────────────────────────────────────────────
  const connectWS = useCallback(() => {
    if (isConnecting.current) return;
    isConnecting.current = true;

    if (ws.current) {
      ws.current.onclose = null;
      ws.current.onerror = null;
      try { ws.current.close(); } catch {}
    }

    setWsStatus('connecting');
    const socket = new WebSocket(WS_URL);

    socket.onopen = () => {
      isConnecting.current = false;
      setWsStatus('connected');
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      pingTimer.current = setInterval(() => {
        if (socket.readyState === WebSocket.OPEN) socket.send('ping');
      }, PING_INTERVAL);
    };

    socket.onmessage = (e) => {
      if (e.data === 'pong') return;
      try {
        const data = JSON.parse(e.data);
        if (data.type === 'VIBRATE' && data.pattern) {
          fireVibration(data.pattern);
          if (data.text) setTranscribedText(data.text);
        }
      } catch {}
    };

    socket.onclose = () => {
      isConnecting.current = false;
      if (pingTimer.current) clearInterval(pingTimer.current);
      setWsStatus('disconnected');
      reconnectTimer.current = setTimeout(connectWS, RECONNECT_DELAY);
    };

    socket.onerror = () => {
      isConnecting.current = false;
      try { socket.close(); } catch {}
    };

    ws.current = socket;
  }, []);

  useEffect(() => {
    Audio.requestPermissionsAsync();
    connectWS();
    return () => {
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      if (pingTimer.current) clearInterval(pingTimer.current);
      if (ws.current) {
        ws.current.onclose = null;
        ws.current.close();
      }
    };
  }, [connectWS]);

  // ── Vibration ─────────────────────────────────────────────────────────────
  const fireVibration = (pattern: number[]) => {
    if (Platform.OS === 'ios') {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
    } else {
      Vibration.vibrate([0, ...pattern]);
    }
  };

  // ── Mic Recording ─────────────────────────────────────────────────────────
  const startRecording = async () => {
    if (isRecording || isSending) return;
    try {
      await Audio.setAudioModeAsync({
        allowsRecordingIOS: true,
        playsInSilentModeIOS: true,
      });
      const { recording } = await Audio.Recording.createAsync(
        Audio.RecordingOptionsPresets.HIGH_QUALITY
      );
      recordingRef.current = recording;
      setIsRecording(true);
      setTranscribedText('Listening...');
    } catch {
      setTranscribedText('Mic error — try again');
    }
  };

  const stopRecording = async () => {
    if (!isRecording || !recordingRef.current) return;
    setIsRecording(false);
    setIsSending(true);
    setTranscribedText('Processing...');
    try {
      await recordingRef.current.stopAndUnloadAsync();
      const uri = recordingRef.current.getURI();
      recordingRef.current = null;
      if (uri) await uploadAudio(uri);
    } catch {
      setTranscribedText('Error — try again');
      setIsSending(false);
    }
  };

  const uploadAudio = async (uri: string) => {
    try {
      const form = new FormData();
      form.append('file', { uri, name: 'audio.m4a', type: 'audio/m4a' } as any);
      const res = await fetch(`${BACKEND_URL}/translate-speech`, { method: 'POST', body: form });
      const data = await res.json();
      if (data.status === 'success') {
        setTranscribedText(`"${data.text}"`);
      } else {
        setTranscribedText('Not recognized — try again');
      }
    } catch {
      setTranscribedText('Upload failed — check connection');
    } finally {
      setIsSending(false);
    }
  };

  // ── Quick Phrases ─────────────────────────────────────────────────────────
  const sendQuickPhrase = (phrase: typeof QUICK_PHRASES[0]) => {
    Speech.speak(phrase.label, { language: 'en' });
    fireVibration(phrase.pattern);
    setLastAction(phrase.label);
    if (ws.current?.readyState === WebSocket.OPEN) {
      ws.current.send(JSON.stringify({ action: phrase.label }));
    }
  };

  // ── Swipe gestures for listen mode ────────────────────────────────────────
  const swipePanResponder = PanResponder.create({
    onStartShouldSetPanResponder: () => mode === 'listen',
    onMoveShouldSetPanResponder: (_, g) =>
      mode === 'listen' && (Math.abs(g.dx) > 10 || Math.abs(g.dy) > 10),
    onPanResponderRelease: (_, g) => {
      if (mode !== 'listen') return;
      const { dx, dy } = g;
      const absDx = Math.abs(dx);
      const absDy = Math.abs(dy);
      if (absDx < 50 && absDy < 50) return; // too small, ignore

      let label = '';
      let pattern: number[] = [];

      if (absDy > absDx) {
        if (dy < 0) { label = 'I need help'; pattern = [500, 200, 500]; }
        else { label = 'Thank you'; pattern = [100, 100, 100]; }
      } else {
        if (dx > 0) { label = 'Yes'; pattern = [100]; }
        else { label = 'No'; pattern = [300]; }
      }

      Speech.speak(label, { language: 'en' });
      fireVibration(pattern);
      setLastAction(label);
      if (ws.current?.readyState === WebSocket.OPEN) {
        ws.current.send(JSON.stringify({ action: label }));
      }
    },
  });

  // ── Speak typed text ──────────────────────────────────────────────────────
  const speakTyped = () => {
    const text = typedText.trim();
    if (!text) return;
    Keyboard.dismiss();
    Speech.speak(text, { language: 'en' });
    fireVibration([100, 100, 100]);
    setLastAction(`"${text}"`);
    if (ws.current?.readyState === WebSocket.OPEN) {
      ws.current.send(JSON.stringify({ action: text }));
    }
    setTypedText('');
  };

  // ── Status ────────────────────────────────────────────────────────────────
  const statusColor =
    wsStatus === 'connected' ? '#00ff88' :
    wsStatus === 'connecting' ? '#ffb800' : '#ff4d4d';
  const statusLabel =
    wsStatus === 'connected' ? 'Connected' :
    wsStatus === 'connecting' ? 'Connecting...' : 'Reconnecting...';

  // ─── RENDER ───────────────────────────────────────────────────────────────
  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.container}>

        {/* ── Header ── */}
        <View style={styles.header}>
          <Text style={styles.logo}>SENSEX</Text>
          <View style={styles.statusPill}>
            <View style={[styles.statusDot, { backgroundColor: statusColor }]} />
            <Text style={[styles.statusText, { color: statusColor }]}>{statusLabel}</Text>
          </View>
        </View>

        {/* ── Mode Toggle ── */}
        <View style={styles.modeRow}>
          <TouchableOpacity
            style={[styles.modeBtn, mode === 'listen' && styles.modeBtnOn]}
            onPress={() => { setMode('listen'); Keyboard.dismiss(); }}
          >
            <Text style={[styles.modeBtnText, mode === 'listen' && styles.modeBtnTextOn]}>
              🎤  LISTEN
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.modeBtn, mode === 'type' && styles.modeBtnOn]}
            onPress={() => setMode('type')}
          >
            <Text style={[styles.modeBtnText, mode === 'type' && styles.modeBtnTextOn]}>
              ✍️  TYPE
            </Text>
          </TouchableOpacity>
        </View>

        {/* ── LISTEN MODE ── */}
        {mode === 'listen' && (
          <View style={styles.listenContainer} {...swipePanResponder.panHandlers}>

            {/* Transcription display */}
            <View style={styles.textDisplay}>
              {isSending ? (
                <ActivityIndicator color="#00ff88" />
              ) : (
                <Text style={styles.textDisplayText} numberOfLines={3}>
                  {transcribedText || 'Hold mic · Swipe to reply'}
                </Text>
              )}
            </View>

            {/* Last action */}
            {lastAction ? (
              <Text style={styles.lastActionText}>↳ {lastAction}</Text>
            ) : null}

            {/* Quick Phrases */}
            <Text style={styles.sectionLabel}>QUICK PHRASES</Text>
            <View style={styles.phrasesGrid}>
              {QUICK_PHRASES.map((p) => (
                <TouchableOpacity
                  key={p.label}
                  style={styles.phraseBtn}
                  onPress={() => sendQuickPhrase(p)}
                >
                  <Text style={styles.phraseBtnText}>{p.label}</Text>
                </TouchableOpacity>
              ))}
            </View>

            {/* Swipe hints */}
            <View style={styles.swipeHints}>
              <Text style={styles.swipeHint}>↑ I need help</Text>
              <View style={styles.swipeHintRow}>
                <Text style={styles.swipeHint}>← No</Text>
                <Text style={styles.swipeHint}>Yes →</Text>
              </View>
              <Text style={styles.swipeHint}>↓ Thank you</Text>
            </View>

            {/* Mic Button */}
            <TouchableOpacity
              style={[styles.micBtn, isRecording && styles.micBtnActive]}
              onPressIn={startRecording}
              onPressOut={stopRecording}
              disabled={isSending}
              activeOpacity={0.85}
            >
              <Text style={styles.micBtnIcon}>{isRecording ? '⏹' : '🎤'}</Text>
              <Text style={styles.micBtnLabel}>
                {isSending ? 'Processing...' : isRecording ? 'Release to send' : 'Hold to speak'}
              </Text>
            </TouchableOpacity>

          </View>
        )}

        {/* ── TYPE MODE ── */}
        {mode === 'type' && (
          <View style={styles.typeContainer}>

            <Text style={styles.typeHint}>
              Use Gboard swipe typing to build your message
            </Text>

            {/* System keyboard text input */}
            <TextInput
              ref={inputRef}
              style={styles.textInput}
              value={typedText}
              onChangeText={setTypedText}
              placeholder="Swipe or type here..."
              placeholderTextColor="#333"
              multiline
              autoFocus={false}
              returnKeyType="done"
              blurOnSubmit={false}
            />

            {/* Speak button */}
            <TouchableOpacity
              style={[styles.speakBtn, !typedText.trim() && styles.speakBtnDisabled]}
              onPress={speakTyped}
              disabled={!typedText.trim()}
            >
              <Text style={styles.speakBtnText}>🔊  SPEAK</Text>
            </TouchableOpacity>

            {/* Clear button */}
            <TouchableOpacity style={styles.clearBtn} onPress={() => setTypedText('')}>
              <Text style={styles.clearBtnText}>Clear</Text>
            </TouchableOpacity>

            {lastAction ? (
              <Text style={styles.lastActionText}>↳ Spoke: {lastAction}</Text>
            ) : null}

          </View>
        )}

      </View>
    </SafeAreaView>
  );
}

// ─── STYLES ───────────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#050508' },
  container: { flex: 1, backgroundColor: '#050508' },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingTop: 12,
    paddingBottom: 10,
    borderBottomWidth: 0.5,
    borderBottomColor: '#1a1a2e',
  },
  logo: {
    fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace',
    fontSize: 20,
    fontWeight: '900',
    color: '#00ff88',
    letterSpacing: 6,
  },
  statusPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: '#0d0d1a',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 20,
    borderWidth: 0.5,
    borderColor: '#1a1a2e',
  },
  statusDot: { width: 6, height: 6, borderRadius: 3 },
  statusText: {
    fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace',
    fontSize: 10,
    fontWeight: '600',
    letterSpacing: 1,
  },

  modeRow: {
    flexDirection: 'row',
    margin: 16,
    backgroundColor: '#0d0d1a',
    borderRadius: 10,
    padding: 3,
    borderWidth: 0.5,
    borderColor: '#1a1a2e',
  },
  modeBtn: {
    flex: 1,
    paddingVertical: 11,
    borderRadius: 8,
    alignItems: 'center',
  },
  modeBtnOn: { backgroundColor: '#00ff88' },
  modeBtnText: {
    fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace',
    fontSize: 12,
    fontWeight: '700',
    color: '#333',
    letterSpacing: 2,
  },
  modeBtnTextOn: { color: '#000' },

  // Listen mode
  listenContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingBottom: 40,
  },
  textDisplay: {
    width: '100%',
    minHeight: 80,
    backgroundColor: '#0d0d1a',
    borderRadius: 12,
    borderWidth: 0.5,
    borderColor: '#1a1a2e',
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 16,
  },
  textDisplayText: {
    fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace',
    fontSize: 18,
    color: '#00ff88',
    fontWeight: '600',
    textAlign: 'center',
    letterSpacing: 1,
  },
  lastActionText: {
    fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace',
    color: '#00ff88',
    fontSize: 13,
    letterSpacing: 1,
    fontWeight: '600',
  },
  sectionLabel: {
    fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace',
    fontSize: 9,
    color: '#333',
    letterSpacing: 3,
    alignSelf: 'flex-start',
    marginBottom: 8,
  },
  phrasesGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    width: '100%',
  },
  phraseBtn: {
    backgroundColor: '#0d0d1a',
    borderWidth: 0.5,
    borderColor: '#1a1a2e',
    borderRadius: 8,
    paddingHorizontal: 18,
    paddingVertical: 12,
  },
  phraseBtnText: {
    fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace',
    color: '#00ff88',
    fontSize: 13,
    fontWeight: '600',
    letterSpacing: 1,
  },
  swipeHints: {
    alignItems: 'center',
    gap: 8,
  },
  swipeHintRow: {
    flexDirection: 'row',
    gap: 60,
  },
  swipeHint: {
    fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace',
    color: '#2a2a4a',
    fontSize: 14,
    letterSpacing: 1,
  },
  micBtn: {
    width: 160,
    height: 160,
    borderRadius: 80,
    backgroundColor: '#0d0d1a',
    borderWidth: 1.5,
    borderColor: '#1a1a2e',
    justifyContent: 'center',
    alignItems: 'center',
  },
  micBtnActive: {
    backgroundColor: '#1a0000',
    borderColor: '#ff4d4d',
  },
  micBtnIcon: { fontSize: 44, marginBottom: 8 },
  micBtnLabel: {
    fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace',
    color: '#444',
    fontSize: 11,
    letterSpacing: 1,
  },

  // Type mode
  typeContainer: {
    flex: 1,
    paddingHorizontal: 20,
    paddingTop: 8,
    gap: 14,
  },
  typeHint: {
    fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace',
    color: '#333',
    fontSize: 10,
    letterSpacing: 1,
    textAlign: 'center',
  },
  textInput: {
    backgroundColor: '#0d0d1a',
    borderWidth: 1,
    borderColor: '#1a1a2e',
    borderRadius: 12,
    padding: 16,
    color: '#00ff88',
    fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace',
    fontSize: 22,
    letterSpacing: 2,
    minHeight: 120,
    textAlignVertical: 'top',
  },
  speakBtn: {
    backgroundColor: '#002a1a',
    borderWidth: 1,
    borderColor: '#00ff88',
    borderRadius: 12,
    paddingVertical: 18,
    alignItems: 'center',
  },
  speakBtnDisabled: { opacity: 0.3 },
  speakBtnText: {
    fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace',
    color: '#00ff88',
    fontSize: 18,
    fontWeight: '700',
    letterSpacing: 3,
  },
  clearBtn: { alignItems: 'center', paddingVertical: 10 },
  clearBtnText: {
    fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace',
    color: '#333',
    fontSize: 12,
    letterSpacing: 2,
  },
});
