import React, { useEffect, useState, useRef } from 'react';
import {
  StyleSheet,
  View,
  Text,
  Vibration,
  PanResponder,
  Platform,
} from 'react-native';
import * as Speech from 'expo-speech';
import * as Haptics from 'expo-haptics';

const WS_URL = 'wss://sensex-backend.onrender.com/ws/haptics';

export default function App() {
  const [status, setStatus] = useState('Connecting...');
  const [lastAction, setLastAction] = useState('');
  const ws = useRef(null);
  const reconnectTimer = useRef(null);

  useEffect(() => {
    connectWebSocket();
    return () => {
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      ws.current?.close();
    };
  }, []);

  const connectWebSocket = () => {
    // Close any existing connection before opening a new one
    if (ws.current) {
      ws.current.onclose = null; // prevent auto-reconnect loop
      ws.current.close();
    }

    const socket = new WebSocket(WS_URL);
    ws.current = socket;

    socket.onopen = () => {
      setStatus('Connected');
      // Start heartbeat ping every 25s to keep Render connection alive
      const ping = setInterval(() => {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send('ping');
        }
      }, 25000);
      socket._pingInterval = ping;
    };

    socket.onmessage = (e) => {
      if (e.data === 'pong') return; // heartbeat reply, ignore

      try {
        const data = JSON.parse(e.data);
        if (data.type === 'VIBRATE') {
          triggerHaptic(data.pattern);
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

  // Cross-platform haptic feedback
  const triggerHaptic = (pattern) => {
    if (Platform.OS === 'ios') {
      // expo-haptics works on iOS; pattern drives intensity
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
    } else {
      // Android supports Vibration.vibrate with pattern arrays
      Vibration.vibrate(pattern);
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
    // 1. Speak aloud for people around the user
    Speech.speak(message, { language: 'en' });

    // 2. Haptic confirmation so the user knows it fired
    triggerHaptic(confirmPattern);

    // 3. Update UI label
    setLastAction(displayLabel);

    // 4. Send to backend over WebSocket
    if (ws.current?.readyState === WebSocket.OPEN) {
      ws.current.send(JSON.stringify({ action: message }));
    }
  };

  const statusColor =
    status === 'Connected' ? '#00ff88' : '#ff4d4d';

  return (
    <View style={styles.container} {...panResponder.panHandlers}>
      {/* Connection status */}
      <View style={styles.statusBar}>
        <View style={[styles.dot, { backgroundColor: statusColor }]} />
        <Text style={[styles.statusText, { color: statusColor }]}>
          {status}
        </Text>
      </View>

      {/* Last fired action */}
      {lastAction ? (
        <Text style={styles.lastAction}>{lastAction}</Text>
      ) : null}

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
  instructions: {
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
