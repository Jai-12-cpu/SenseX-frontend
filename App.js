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
  Dimensions,
  ActivityIndicator,
} from 'react-native';
import * as Speech from 'expo-speech';
import * as Haptics from 'expo-haptics';
import { Audio } from 'expo-av';

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const WS_URL = 'wss://sensex-backend.onrender.com/ws/haptics';
const BACKEND_URL = 'https://sensex-backend.onrender.com';
const RECONNECT_DELAY = 3000;
const PING_INTERVAL = 25000;

// ─── KEYBOARD LAYOUT ─────────────────────────────────────────────────────────
const KEYBOARD_ROWS = [
  ['Q','W','E','R','T','Y','U','I','O','P'],
  ['A','S','D','F','G','H','J','K','L'],
  ['Z','X','C','V','B','N','M'],
];

const QUICK_PHRASES = [
  { label: 'Yes', pattern: [100] },
  { label: 'No', pattern: [300] },
  { label: 'Help', pattern: [500, 200, 500] },
  { label: 'Thanks', pattern: [100, 100, 100] },
  { label: 'Wait', pattern: [200, 100, 200] },
  { label: 'Repeat', pattern: [100, 100, 300] },
];

const { width } = Dimensions.get('window');

// ─── MAIN COMPONENT ───────────────────────────────────────────────────────────
export default function SensEx() {
  const [wsStatus, setWsStatus] = useState<'connecting' | 'connected' | 'disconnected'>('connecting');
  const [mode, setMode] = useState<'listen' | 'type'>('listen');
  const [isRecording, setIsRecording] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [transcribedText, setTranscribedText] = useState('');
  const [typedWord, setTypedWord] = useState('');
  const [lastAction, setLastAction] = useState('');

  const ws = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pingTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const recordingRef = useRef<Audio.Recording | null>(null);
  const isConnecting = useRef(false);

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
      socket.close();
    };

    ws.current = socket;
  }, []);

  useEffect(() => {
    requestPermissions();
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

  // ── Permissions ───────────────────────────────────────────────────────────
  const requestPermissions = async () => {
    await Audio.requestPermissionsAsync();
  };

  // ── Vibration ─────────────────────────────────────────────────────────────
  const fireVibration = (pattern: number[]) => {
    if (Platform.OS === 'ios') {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
    } else {
      // Android: pattern must start with a silence (0) for Vibration.vibrate
      // Our pattern alternates vibrate/pause starting with vibrate
      // So prepend 0 to make it [0, vib, pause, vib, ...]
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
    } catch (err) {
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
      const res = await fetch(`${BACKEND_URL}/translate-speech`, {
        method: 'POST',
        body: form,
      });
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

  // ── Keyboard ──────────────────────────────────────────────────────────────
  const tapLetter = (letter: string) => {
    setTypedWord(w => w + letter);
    fireVibration([50]);
  };

  const deleteLetter = () => {
    setTypedWord(w => w.slice(0, -1));
  };

  const addSpace = () => {
    setTypedWord(w => w + ' ');
  };

  const speakWord = () => {
    const word = typedWord.trim();
    if (!word) return;
    Speech.speak(word, { language: 'en' });
    fireVibration([100, 100, 100]);
    setLastAction(`Spoke: "${word}"`);
    if (ws.current?.readyState === WebSocket.OPEN) {
      ws.current.send(JSON.stringify({ action: word }));
    }
    setTypedWord('');
  };

  const clearWord = () => setTypedWord('');

  // ── Status indicator ──────────────────────────────────────────────────────
  const statusColor = wsStatus === 'connected' ? '#00ff88' : wsStatus === 'connecting' ? '#ffb800' : '#ff4d4d';
  const statusLabel = wsStatus === 'connected' ? 'Connected' : wsStatus === 'connecting' ? 'Connecting...' : 'Reconnecting...';

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
            onPress={() => setMode('listen')}
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
              ⌨️  TYPE
            </Text>
          </TouchableOpacity>
        </View>

        {/* ── LISTEN MODE ── */}
        {mode === 'listen' && (
          <ScrollView
            style={styles.scroll}
            contentContainerStyle={styles.listenContent}
            showsVerticalScrollIndicator={false}
          >
            {/* Transcription display */}
            <View style={styles.textDisplay}>
              {isSending ? (
                <ActivityIndicator color="#00ff88" />
              ) : (
                <Text style={styles.textDisplayText} numberOfLines={3}>
                  {transcribedText || 'Hold mic to speak'}
                </Text>
              )}
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

            {lastAction ? (
              <Text style={styles.lastActionText}>↳ {lastAction}</Text>
            ) : null}
          </ScrollView>
        )}

        {/* ── TYPE MODE ── */}
        {mode === 'type' && (
          <View style={styles.typeContainer}>
            {/* Word display */}
            <View style={styles.wordDisplay}>
              <Text style={styles.wordText} numberOfLines={2}>
                {typedWord || 'Tap letters to spell'}
              </Text>
            </View>

            {/* Action buttons */}
            <View style={styles.actionRow}>
              <TouchableOpacity style={styles.actionBtn} onPress={deleteLetter}>
                <Text style={styles.actionBtnText}>⌫</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.actionBtn, styles.speakActionBtn, !typedWord.trim() && styles.actionBtnDisabled]}
                onPress={speakWord}
                disabled={!typedWord.trim()}
              >
                <Text style={[styles.actionBtnText, styles.speakActionBtnText]}>🔊 SPEAK</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.actionBtn} onPress={clearWord}>
                <Text style={styles.actionBtnText}>✕</Text>
              </TouchableOpacity>
            </View>

            {/* Keyboard */}
            <View style={styles.keyboard}>
              {KEYBOARD_ROWS.map((row, ri) => (
                <View key={ri} style={styles.keyRow}>
                  {row.map((letter) => (
                    <TouchableOpacity
                      key={letter}
                      style={styles.key}
                      onPress={() => tapLetter(letter)}
                      activeOpacity={0.6}
                    >
                      <Text style={styles.keyText}>{letter}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
              ))}
              {/* Space bar row */}
              <View style={styles.keyRow}>
                <TouchableOpacity style={[styles.key, styles.keySpace]} onPress={addSpace}>
                  <Text style={styles.keyText}>SPACE</Text>
                </TouchableOpacity>
              </View>
            </View>

            {lastAction ? (
              <Text style={styles.lastActionText}>↳ {lastAction}</Text>
            ) : null}
          </View>
        )}

      </View>
    </SafeAreaView>
  );
}

// ─── STYLES ───────────────────────────────────────────────────────────────────
const KEY_SIZE = Math.floor((width - 48) / 10);

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: '#050508',
  },
  container: {
    flex: 1,
    backgroundColor: '#050508',
  },

  // Header
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
  statusDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  statusText: {
    fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace',
    fontSize: 10,
    fontWeight: '600',
    letterSpacing: 1,
  },

  // Mode toggle
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
  modeBtnOn: {
    backgroundColor: '#00ff88',
  },
  modeBtnText: {
    fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace',
    fontSize: 12,
    fontWeight: '700',
    color: '#333',
    letterSpacing: 2,
  },
  modeBtnTextOn: {
    color: '#000',
  },

  // Listen mode
  scroll: { flex: 1 },
  listenContent: {
    paddingHorizontal: 16,
    paddingBottom: 30,
    alignItems: 'center',
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
    marginBottom: 24,
  },
  textDisplayText: {
    fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace',
    fontSize: 18,
    color: '#00ff88',
    fontWeight: '600',
    textAlign: 'center',
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
    marginBottom: 32,
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
  sectionLabel: {
    fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace',
    fontSize: 9,
    color: '#333',
    letterSpacing: 3,
    alignSelf: 'flex-start',
    marginBottom: 10,
  },
  phrasesGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    width: '100%',
    justifyContent: 'flex-start',
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
  lastActionText: {
    fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace',
    color: '#333',
    fontSize: 10,
    marginTop: 16,
    letterSpacing: 1,
  },

  // Type mode
  typeContainer: {
    flex: 1,
    paddingHorizontal: 16,
  },
  wordDisplay: {
    width: '100%',
    minHeight: 70,
    backgroundColor: '#0d0d1a',
    borderRadius: 12,
    borderWidth: 0.5,
    borderColor: '#1a1a2e',
    justifyContent: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    marginBottom: 12,
  },
  wordText: {
    fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace',
    fontSize: 26,
    color: '#00ff88',
    fontWeight: '700',
    letterSpacing: 3,
  },
  actionRow: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 14,
  },
  actionBtn: {
    backgroundColor: '#0d0d1a',
    borderWidth: 0.5,
    borderColor: '#1a1a2e',
    borderRadius: 10,
    paddingVertical: 12,
    paddingHorizontal: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  speakActionBtn: {
    flex: 1,
    backgroundColor: '#002a1a',
    borderColor: '#00ff88',
  },
  speakActionBtnText: {
    color: '#00ff88',
  },
  actionBtnDisabled: {
    opacity: 0.3,
  },
  actionBtnText: {
    fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace',
    color: '#555',
    fontSize: 16,
    fontWeight: '700',
  },

  // Keyboard
  keyboard: {
    gap: 6,
  },
  keyRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 4,
  },
  key: {
    width: KEY_SIZE,
    height: KEY_SIZE * 1.1,
    backgroundColor: '#0d0d1a',
    borderRadius: 6,
    borderWidth: 0.5,
    borderColor: '#1a1a2e',
    justifyContent: 'center',
    alignItems: 'center',
  },
  keySpace: {
    width: KEY_SIZE * 6,
    height: KEY_SIZE * 0.9,
  },
  keyText: {
    fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace',
    color: '#ccc',
    fontSize: 13,
    fontWeight: '600',
  },
});
