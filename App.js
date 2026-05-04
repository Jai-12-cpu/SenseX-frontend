import React, { useEffect, useState, useRef } from 'react';
import {
  StyleSheet,
  View,
  Text,
  Vibration,
  PanResponder,
  Platform,
  TouchableOpacity,
  Dimensions,
} from 'react-native';
import * as Speech from 'expo-speech';
import * as Haptics from 'expo-haptics';
import { Audio } from 'expo-av';
import { Svg, Path } from 'react-native-svg';

const WS_URL = 'wss://sensex-backend.onrender.com/ws/haptics';
const BACKEND_URL = 'https://sensex-backend.onrender.com';
const { width, height } = Dimensions.get('window');

// Simple stroke-based letter recognition
// Maps drawn strokes to letters using direction analysis
function recognizeLetter(strokes) {
  if (!strokes || strokes.length === 0) return '?';

  const allPoints = strokes.flat();
  if (allPoints.length < 2) return '?';

  const xs = allPoints.map(p => p.x);
  const ys = allPoints.map(p => p.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const w = maxX - minX;
  const h = maxY - minY;

  // Analyze stroke directions
  const directions = [];
  for (const stroke of strokes) {
    if (stroke.length < 2) continue;
    const first = stroke[0];
    const last = stroke[stroke.length - 1];
    const dx = last.x - first.x;
    const dy = last.y - first.y;
    const angle = Math.atan2(dy, dx) * (180 / Math.PI);

    if (Math.abs(dx) < 20 && dy > 30) directions.push('down');
    else if (Math.abs(dx) < 20 && dy < -30) directions.push('up');
    else if (Math.abs(dy) < 20 && dx > 30) directions.push('right');
    else if (Math.abs(dy) < 20 && dx < -30) directions.push('left');
    else if (dx > 20 && dy > 20) directions.push('down-right');
    else if (dx < -20 && dy > 20) directions.push('down-left');
    else if (dx > 20 && dy < -20) directions.push('up-right');
    else if (dx < -20 && dy < -20) directions.push('up-left');
    else directions.push('diagonal');
  }

  const strokeCount = strokes.length;
  const dir = directions.join(',');
  const aspect = w / (h || 1);

  // Pattern matching for common letters
  if (strokeCount === 1) {
    if (dir.includes('down') && !dir.includes('right') && !dir.includes('left')) return 'I';
    if (dir.includes('right') && !dir.includes('down') && !dir.includes('up')) return 'L';
    if (dir.includes('down-right')) return 'J';
    if (dir.includes('up-right')) return 'V';
    if (dir.includes('diagonal')) {
      if (aspect > 1.5) return 'Z';
      return 'S';
    }
    if (dir.includes('down') && dir.includes('right')) return 'C';
    return 'O';
  }

  if (strokeCount === 2) {
    if (directions[0] === 'down' && directions[1] === 'right') return 'L';
    if (directions[0] === 'down' && directions[1] === 'down') return 'U';
    if (directions[0] === 'right' && directions[1] === 'down') return 'T';
    if (directions[0] === 'down-right' && directions[1] === 'down-left') return 'V';
    if (directions[0] === 'up-right' && directions[1] === 'down-right') return 'K';
    if (directions[0] === 'down' && directions[1] === 'right') return 'F';
    if (directions[0] === 'diagonal' && directions[1] === 'diagonal') return 'X';
    return 'N';
  }

  if (strokeCount === 3) {
    if (directions.includes('down') && directions.includes('right')) return 'E';
    if (directions.includes('up-right') && directions.includes('down-right')) return 'Y';
    return 'F';
  }

  return 'A';
}

export default function App() {
  const [status, setStatus] = useState('Connecting...');
  const [recording, setRecording] = useState(null);
  const [isRecording, setIsRecording] = useState(false);
  const [mode, setMode] = useState('listen'); // 'listen' or 'draw'
  const [currentWord, setCurrentWord] = useState('');
  const [currentLetter, setCurrentLetter] = useState('');
  const [strokes, setStrokes] = useState([]);
  const [currentStroke, setCurrentStroke] = useState([]);
  const [paths, setPaths] = useState([]);
  const [currentPath, setCurrentPath] = useState('');
  const [transcribedText, setTranscribedText] = useState('');

  const ws = useRef(null);
  const reconnectTimer = useRef(null);
  const recognizeTimer = useRef(null);

  useEffect(() => {
    connectWebSocket();
    requestMicPermission();
    return () => {
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      if (recognizeTimer.current) clearTimeout(recognizeTimer.current);
      ws.current?.close();
    };
  }, []);

  const requestMicPermission = async () => {
    const { granted } = await Audio.requestPermissionsAsync();
    if (!granted) alert('Microphone permission is required.');
  };

  const connectWebSocket = () => {
    if (ws.current) {
      ws.current.onclose = null;
      ws.current.close();
    }
    const socket = new WebSocket(WS_URL);
    ws.current = socket;

    socket.onopen = () => {
      setStatus('Connected');
      const ping = setInterval(() => {
        if (socket.readyState === WebSocket.OPEN) socket.send('ping');
      }, 25000);
      socket._pingInterval = ping;
    };

    socket.onmessage = (e) => {
      if (e.data === 'pong') return;
      try {
        const data = JSON.parse(e.data);
        if (data.type === 'VIBRATE') {
          triggerHaptic(data.pattern);
          if (data.text) setTranscribedText(data.text);
        }
      } catch (err) {
        console.warn('WS parse error:', err);
      }
    };

    socket.onclose = () => {
      clearInterval(socket._pingInterval);
      setStatus('Disconnected — reconnecting...');
      reconnectTimer.current = setTimeout(connectWebSocket, 3000);
    };

    socket.onerror = (err) => console.warn('WS error:', err.message);
  };

  const triggerHaptic = (pattern) => {
    if (Platform.OS === 'ios') {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
    } else {
      Vibration.vibrate(pattern);
    }
  };

  // ── MIC RECORDING ──
  const startRecording = async () => {
    try {
      await Audio.setAudioModeAsync({ allowsRecordingIOS: true, playsInSilentModeIOS: true });
      const { recording } = await Audio.Recording.createAsync(
        Audio.RecordingOptionsPresets.HIGH_QUALITY
      );
      setRecording(recording);
      setIsRecording(true);
      setTranscribedText('Listening...');
    } catch (err) {
      console.error('Record error:', err);
    }
  };

  const stopRecording = async () => {
    try {
      setIsRecording(false);
      setTranscribedText('Sending...');
      await recording.stopAndUnloadAsync();
      const uri = recording.getURI();
      setRecording(null);
      await sendAudioToBackend(uri);
    } catch (err) {
      console.error('Stop error:', err);
      setTranscribedText('Error — try again');
    }
  };

  const sendAudioToBackend = async (uri) => {
    try {
      const formData = new FormData();
      formData.append('file', { uri, name: 'audio.m4a', type: 'audio/m4a' });
      const response = await fetch(`${BACKEND_URL}/translate-speech`, {
        method: 'POST',
        body: formData,
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      const data = await response.json();
      if (data.status === 'success') {
        setTranscribedText(data.text);
      } else {
        setTranscribedText('Not recognized');
      }
    } catch (err) {
      console.error('Upload error:', err);
      setTranscribedText('Upload failed');
    }
  };

  // ── DRAWING ──
  const drawPanResponder = PanResponder.create({
    onStartShouldSetPanResponder: () => mode === 'draw',
    onMoveShouldSetPanResponder: () => mode === 'draw',

    onPanResponderGrant: (evt) => {
      const { locationX, locationY } = evt.nativeEvent;
      setCurrentStroke([{ x: locationX, y: locationY }]);
      setCurrentPath(`M${locationX},${locationY}`);
      if (recognizeTimer.current) clearTimeout(recognizeTimer.current);
    },

    onPanResponderMove: (evt) => {
      const { locationX, locationY } = evt.nativeEvent;
      setCurrentStroke(prev => [...prev, { x: locationX, y: locationY }]);
      setCurrentPath(prev => prev + ` L${locationX},${locationY}`);
    },

    onPanResponderRelease: () => {
      // Save completed stroke
      setStrokes(prev => {
        const newStrokes = [...prev, currentStroke];
        // Auto-recognize after 800ms of no new strokes
        if (recognizeTimer.current) clearTimeout(recognizeTimer.current);
        recognizeTimer.current = setTimeout(() => {
          const letter = recognizeLetter(newStrokes);
          setCurrentLetter(letter);
          setCurrentWord(w => w + letter);
          setStrokes([]);
          setPaths([]);
          setCurrentPath('');
          triggerHaptic([100]); // short buzz feedback
        }, 800);
        return newStrokes;
      });
      setPaths(prev => [...prev, currentPath]);
      setCurrentPath('');
    },
  });

  const speakWord = () => {
    if (!currentWord) return;
    Speech.speak(currentWord, { language: 'en' });
    // Also send to backend for Morse vibration
    if (ws.current?.readyState === WebSocket.OPEN) {
      ws.current.send(JSON.stringify({ action: currentWord }));
    }
    triggerHaptic([100, 100, 100]);
  };

  const clearWord = () => {
    setCurrentWord('');
    setCurrentLetter('');
    setStrokes([]);
    setPaths([]);
    setCurrentPath('');
  };

  const deleteLastLetter = () => {
    setCurrentWord(w => w.slice(0, -1));
  };

  // ── SWIPE GESTURES (listen mode only) ──
  const swipePanResponder = PanResponder.create({
    onStartShouldSetPanResponder: () => mode === 'listen',
    onPanResponderRelease: (evt, gestureState) => {
      if (mode !== 'listen') return;
      const { dx, dy } = gestureState;
      if (dy < -100) handleQuickAction('I need help', [500, 200, 500]);
      else if (dx > 100) handleQuickAction('Yes', [100]);
      else if (dx < -100) handleQuickAction('No', [300]);
      else if (dy > 100) handleQuickAction('Thank you', [100, 100, 100]);
    },
  });

  const handleQuickAction = (message, pattern) => {
    Speech.speak(message, { language: 'en' });
    triggerHaptic(pattern);
    setTranscribedText(message);
    if (ws.current?.readyState === WebSocket.OPEN) {
      ws.current.send(JSON.stringify({ action: message }));
    }
  };

  const statusColor = status === 'Connected' ? '#00ff88' : '#ff4d4d';
  const CANVAS_SIZE = width - 48;

  return (
    <View style={styles.container}>
      {/* Status bar */}
      <View style={styles.statusBar}>
        <View style={[styles.dot, { backgroundColor: statusColor }]} />
        <Text style={[styles.statusText, { color: statusColor }]}>{status}</Text>
      </View>

      {/* Mode toggle */}
      <View style={styles.modeToggle}>
        <TouchableOpacity
          style={[styles.modeBtn, mode === 'listen' && styles.modeBtnActive]}
          onPress={() => setMode('listen')}
        >
          <Text style={[styles.modeBtnText, mode === 'listen' && styles.modeBtnTextActive]}>
            🎤 Listen
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.modeBtn, mode === 'draw' && styles.modeBtnActive]}
          onPress={() => setMode('draw')}
        >
          <Text style={[styles.modeBtnText, mode === 'draw' && styles.modeBtnTextActive]}>
            ✏️ Draw
          </Text>
        </TouchableOpacity>
      </View>

      {/* LISTEN MODE */}
      {mode === 'listen' && (
        <View style={styles.listenContainer} {...swipePanResponder.panHandlers}>
          {transcribedText ? (
            <Text style={styles.transcribedText}>{transcribedText}</Text>
          ) : null}

          {/* Mic button */}
          <TouchableOpacity
            style={[styles.micButton, isRecording && styles.micButtonActive]}
            onPressIn={startRecording}
            onPressOut={stopRecording}
            activeOpacity={0.8}
          >
            <Text style={styles.micIcon}>{isRecording ? '⏹' : '🎤'}</Text>
            <Text style={styles.micLabel}>
              {isRecording ? 'Release to send' : 'Hold to speak'}
            </Text>
          </TouchableOpacity>

          {/* Swipe instructions */}
          <View style={styles.instructions}>
            <Text style={styles.instruction}>↑  Swipe up — I need help</Text>
            <Text style={styles.instruction}>→  Swipe right — Yes</Text>
            <Text style={styles.instruction}>←  Swipe left — No</Text>
            <Text style={styles.instruction}>↓  Swipe down — Thank you</Text>
          </View>
        </View>
      )}

      {/* DRAW MODE */}
      {mode === 'draw' && (
        <View style={styles.drawContainer}>
          {/* Word display */}
          <View style={styles.wordDisplay}>
            <Text style={styles.wordText}>{currentWord || 'Draw letters below'}</Text>
            {currentLetter ? (
              <Text style={styles.letterHint}>Detected: {currentLetter}</Text>
            ) : null}
          </View>

          {/* Drawing canvas */}
          <View
            style={[styles.canvas, { width: CANVAS_SIZE, height: CANVAS_SIZE * 0.6 }]}
            {...drawPanResponder.panHandlers}
          >
            <Svg width={CANVAS_SIZE} height={CANVAS_SIZE * 0.6}>
              {paths.map((p, i) => (
                <Path key={i} d={p} stroke="#00ff88" strokeWidth={4} fill="none" strokeLinecap="round" strokeLinejoin="round" />
              ))}
              {currentPath ? (
                <Path d={currentPath} stroke="#ffffff" strokeWidth={4} fill="none" strokeLinecap="round" strokeLinejoin="round" />
              ) : null}
            </Svg>
            {paths.length === 0 && currentPath === '' && (
              <Text style={styles.canvasHint}>Draw a letter here</Text>
            )}
          </View>

          {/* Controls */}
          <View style={styles.drawControls}>
            <TouchableOpacity style={styles.controlBtn} onPress={deleteLastLetter}>
              <Text style={styles.controlBtnText}>⌫</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.controlBtn, styles.speakBtn]}
              onPress={speakWord}
              disabled={!currentWord}
            >
              <Text style={styles.controlBtnText}>🔊 Speak</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.controlBtn} onPress={clearWord}>
              <Text style={styles.controlBtnText}>✕</Text>
            </TouchableOpacity>
          </View>

          <Text style={styles.drawHint}>
            Draw a letter → wait → it gets added to word
          </Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000',
    alignItems: 'center',
  },
  statusBar: {
    position: 'absolute',
    top: 60,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: '#111',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 0.5,
    borderColor: '#222',
    zIndex: 10,
  },
  dot: { width: 8, height: 8, borderRadius: 4 },
  statusText: {
    fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace',
    fontSize: 13,
    fontWeight: '600',
  },
  modeToggle: {
    flexDirection: 'row',
    marginTop: 120,
    backgroundColor: '#111',
    borderRadius: 12,
    padding: 4,
    gap: 4,
    borderWidth: 0.5,
    borderColor: '#222',
  },
  modeBtn: {
    paddingHorizontal: 24,
    paddingVertical: 10,
    borderRadius: 8,
  },
  modeBtnActive: { backgroundColor: '#00ff88' },
  modeBtnText: {
    color: '#444',
    fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace',
    fontSize: 14,
    fontWeight: '600',
  },
  modeBtnTextActive: { color: '#000' },

  // LISTEN MODE
  listenContainer: {
    flex: 1,
    width: '100%',
    alignItems: 'center',
    justifyContent: 'center',
    paddingBottom: 40,
  },
  transcribedText: {
    position: 'absolute',
    top: 20,
    color: '#00ff88',
    fontSize: 20,
    fontWeight: '700',
    letterSpacing: 1,
    textAlign: 'center',
    paddingHorizontal: 20,
    fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace',
  },
  micButton: {
    width: 140,
    height: 140,
    borderRadius: 70,
    backgroundColor: '#111',
    borderWidth: 1.5,
    borderColor: '#333',
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 60,
  },
  micButtonActive: { backgroundColor: '#1a0000', borderColor: '#ff4d4d' },
  micIcon: { fontSize: 40, marginBottom: 8 },
  micLabel: {
    color: '#444',
    fontSize: 12,
    fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace',
  },
  instructions: {
    position: 'absolute',
    bottom: 40,
    gap: 12,
    alignItems: 'flex-start',
  },
  instruction: {
    color: '#333',
    fontSize: 16,
    fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace',
    letterSpacing: 1,
  },

  // DRAW MODE
  drawContainer: {
    flex: 1,
    width: '100%',
    alignItems: 'center',
    paddingTop: 20,
    paddingHorizontal: 24,
  },
  wordDisplay: {
    width: '100%',
    minHeight: 60,
    backgroundColor: '#111',
    borderRadius: 12,
    borderWidth: 0.5,
    borderColor: '#222',
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 16,
    paddingHorizontal: 16,
  },
  wordText: {
    color: '#00ff88',
    fontSize: 28,
    fontWeight: '700',
    letterSpacing: 4,
    fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace',
  },
  letterHint: {
    color: '#555',
    fontSize: 12,
    fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace',
    marginTop: 4,
  },
  canvas: {
    backgroundColor: '#0a0a0a',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#222',
    overflow: 'hidden',
    justifyContent: 'center',
    alignItems: 'center',
  },
  canvasHint: {
    position: 'absolute',
    color: '#222',
    fontSize: 16,
    fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace',
  },
  drawControls: {
    flexDirection: 'row',
    gap: 12,
    marginTop: 16,
    width: '100%',
    justifyContent: 'center',
  },
  controlBtn: {
    backgroundColor: '#111',
    borderWidth: 0.5,
    borderColor: '#333',
    borderRadius: 12,
    paddingHorizontal: 20,
    paddingVertical: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  speakBtn: {
    backgroundColor: '#003320',
    borderColor: '#00ff88',
    flex: 1,
  },
  controlBtnText: {
    color: '#00ff88',
    fontSize: 18,
    fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace',
  },
  drawHint: {
    color: '#333',
    fontSize: 12,
    fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace',
    marginTop: 12,
    textAlign: 'center',
  },
});
