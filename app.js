import React, { useEffect, useState, useRef } from 'react';
import {
  StyleSheet,
  View,
  Text,
  Vibration,
  PanResponder,
  Platform,
  TouchableOpacity,
} from 'react-native';
import * as Speech from 'expo-speech';
import * as Haptics from 'expo-haptics';
import { Audio } from 'expo-av';

const WS_URL = 'wss://sensex-backend.onrender.com/ws/haptics';
const BACKEND_URL = 'https://sensex-backend.onrender.com';

export default function App() {
  const [status, setStatus] = useState('Connecting...');
  const [lastAction, setLastAction] = useState('');
  const [recording, setRecording] = useState(null);
  const [isRecording, setIsRecording] = useState(false);
  const ws = useRef(null);
  const reconnectTimer = useRef(null);

  useEffect(() => {
    connectWebSocket();
    requestMicPermission();
    return () => {
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      ws.current?.close();
    };
  }, []);

  const requestMicPermission = async () => {
    const { granted } = await Audio.requestPermissionsAsync();
    if (!granted) {
      alert('Microphone permission is required.');
    }
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
        if (socket.readyState === WebSocket.OPEN) {
          socket.send('ping');
        }
      }, 25000);
      socket._pingInterval = ping;
    };

    socket.onmessage = (e) => {
      if (e.data === 'pong') return;
      try {
        const data = JSON.parse(e.data);
        if (data.type === 'VIBRATE') {
          triggerHaptic(data.pattern);
          if (data.text) setLastAction(data.text);
        }
      } catch (err) {
        console.warn('WS message parse error:', err);
      }
    };

    socket.onclose = () => {
      clearInterval(socket._pingInterval);
      setStatus('Disconnected — reconnecting...');
      reconnectTimer.current = setTimeout(connectWebSocket, 3000);
    };

    socket.onerror = (err) => {
      console.warn('WebSocket error:', err.message);
    };
  };

  const triggerHaptic = (pattern) => {
    if (Platform.OS === 'ios') {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
    } else {
      Vibration.vibrate(pattern);
    }
  };

  const startRecording = async () => {
    try {
      await Audio.setAudioModeAsync({
        allowsRecordingIOS: true,
        playsInSilentModeIOS: true,
      });

      const { recording } = await Audio.Recording.createAsync(
        Audio.RecordingOptionsPresets.HIGH_QUALITY
      );

      setRecording(recording);
      setIsRecording(true);
      setLastAction('Listening...');
    } catch (err) {
      console.error('Failed to start recording:', err);
    }
  };

  const stopRecording = async () => {
    try {
      setIsRecording(false);
      setLastAction('Sending...');

      await recording.stopAndUnloadAsync();
      const uri = recording.getURI();
      setRecording(null);

      await sendAudioToBackend(uri);
    } catch (err) {
      console.error('Failed to stop recording:', err);
      setLastAction('Error — try again');
    }
  };

  const sendAudioToBackend = async (uri) => {
    try {
      const formData = new FormData();
      formData.append('file', {
        uri,
        name: 'audio.m4a',
        type: 'audio/m4a',
      });

      const response = await fetch(`${BACKEND_URL}/translate-speech`, {
        method: 'POST',
        body: formData,
        headers: {
          'Content-Type': 'multipart/form-data',
        },
      });

      const data = await response.json();
      if (data.status === 'success') {
        setLastAction(data.text);
      } else {
        setLastAction('Not recognized');
      }
    } catch (err) {
      console.error('Failed to send audio:', err);
      setLastAction('Upload failed');
    }
  };

  const panResponder = PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onPanResponderRelease: (evt, gestureState) => {
      const { dx, dy } = gestureState;
      if (dy < -100) {
        handleAction('I need help', [500, 200, 500], 'I need help ↑');
      } else if (dx > 100) {
        handleAction('Yes', [100], 'Yes →');
      } else if (dx < -100) {
        handleAction('No', [300], 'No ←');
      } else if (dy > 100) {
        handleAction('Thank you', [100, 100, 100], 'Thank you ↓');
      }
    },
  });

  const handleAction = (message, confirmPattern, displayLabel) => {
    Speech.speak(message, { language: 'en' });
    triggerHaptic(confirmPattern);
    setLastAction(displayLabel);
    if (ws.current?.readyState === WebSocket.OPEN) {
      ws.current.send(JSON.stringify({ action: message }));
    }
  };

  const statusColor = status === 'Connected' ? '#00ff88' : '#ff4d4d';

  return (
    <View style={styles.container} {...panResponder.panHandlers}>
      {/* Connection status */}
      <View style={styles.statusBar}>
        <View style={[styles.dot, { backgroundColor: statusColor }]} />
        <Text style={[styles.statusText, { color: statusColor }]}>
          {status}
        </Text>
      </View>

      {/* Last fired action / transcription */}
      {lastAction ? (
        <Text style={styles.lastAction}>{lastAction}</Text>
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

      {/* Gesture instructions */}
      <View style={styles.instructions}>
        <Text style={styles.instruction}>↑  Swipe up — I need help</Text>
        <Text style={styles.instruction}>→  Swipe right — Yes</Text>
        <Text style={styles.instruction}>←  Swipe left — No</Text>
        <Text style={styles.instruction}>↓  Swipe down — Thank you</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000',
    justifyContent: 'center',
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
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  statusText: {
    fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace',
    fontSize: 13,
    fontWeight: '600',
  },
  lastAction: {
    position: 'absolute',
    top: 130,
    color: '#00ff88',
    fontSize: 22,
    fontWeight: '700',
    letterSpacing: 2,
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
  micButtonActive: {
    backgroundColor: '#1a0000',
    borderColor: '#ff4d4d',
  },
  micIcon: {
    fontSize: 40,
    marginBottom: 8,
  },
  micLabel: {
    color: '#444',
    fontSize: 12,
    fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace',
  },
  instructions: {
    position: 'absolute',
    bottom: 60,
    gap: 18,
    alignItems: 'flex-start',
  },
  instruction: {
    color: '#444',
    fontSize: 18,
    fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace',
    letterSpacing: 1,
  },
});
