// test-server/server.js
// A test WebSocket server for Google Meet Recorder
// This server accepts connections and saves all received data to files

require('dotenv').config();

const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

// Configuration
const PORT = process.env.PORT || 8080;
const HOST = process.env.HOST || '0.0.0.0';
const OUTPUT_DIR = path.join(__dirname, 'recordings');

// Create output directory
if (!fs.existsSync(OUTPUT_DIR)) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

// Meeting sessions
const sessions = new Map();

// Create WebSocket server
const wss = new WebSocket.Server({ host: HOST, port: PORT });

console.log(`[GMR Server] WebSocket server listening on ${HOST}:${PORT}`);
console.log(`[GMR Server] Recordings will be saved to: ${OUTPUT_DIR}`);

wss.on('connection', (ws, req) => {
  console.log(`[GMR Server] Client connected from ${req.socket.remoteAddress}`);
  
  let heartbeatInterval = null;
  
  // Handle messages
  ws.on('message', (data) => {
    try {
      const activeSession = sessions.get(ws);
      // Check if it's binary (recording chunk)
      if (data instanceof Buffer) {
        handleBinaryMessage(data, activeSession);
      } else {
        // JSON message
        const message = JSON.parse(data);
        handleJSONMessage(message, ws, activeSession);
      }
    } catch (err) {
      console.error('[GMR Server] Error handling message:', err);
    }
  });
  
  // Handle close
  ws.on('close', () => {
    console.log('[GMR Server] Client disconnected');
    if (heartbeatInterval) {
      clearInterval(heartbeatInterval);
    }
    const activeSession = sessions.get(ws);
    if (activeSession) {
      closeSession(activeSession);
      sessions.delete(ws); // Clean up session mapping
    }
  });
  
  // Handle errors
  ws.on('error', (err) => {
    console.error('[GMR Server] WebSocket error:', err);
  });
  
  // Setup heartbeat
  heartbeatInterval = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'ping' }));
    }
  }, 10000);
});

// Handle binary messages (recording chunks)
function handleBinaryMessage(buffer, session) {
  if (!session) {
    console.log('[GMR Server] Binary message received but no session');
    return;
  }
  
  // Parse binary protocol
  // [1 byte: type][4 bytes: sequence][8 bytes: timestamp][N bytes: data]
  if (buffer.length < 13) {
    console.log('[GMR Server] Binary message too short');
    return;
  }
  
  const messageType = buffer.readUInt8(0);
  const sequence = buffer.readUInt32BE(1);
  const timestamp = Number(buffer.readBigUInt64BE(5));
  const chunkData = buffer.slice(13);
  
  switch (messageType) {
    case 0x01: // Recording chunk
      handleRecordingChunk(session, sequence, timestamp, chunkData);
      break;
    case 0x04: // Recording end
      console.log(`[GMR Server] Recording ended. Total chunks: ${sequence}`);
      closeSession(session);
      break;
    default:
      console.log(`[GMR Server] Unknown binary message type: ${messageType}`);
  }
}

// Handle recording chunk
function handleRecordingChunk(session, sequence, timestamp, data) {
  if (!session.recordingFile) {
    const filename = `meeting_${session.meetingId}_${Date.now()}.webm`;
    session.recordingFile = path.join(OUTPUT_DIR, filename);
    session.recordingStream = fs.createWriteStream(session.recordingFile);
    console.log(`[GMR Server] Recording to: ${filename}`);
  }
  
  session.recordingStream.write(data);
  session.chunkCount = sequence;
  
  // Log progress every 10 chunks
  if (sequence % 10 === 0) {
    const size = (fs.statSync(session.recordingFile).size / (1024 * 1024)).toFixed(2);
    console.log(`[GMR Server] Chunks: ${sequence}, Size: ${size} MB`);
  }
}

// Handle JSON messages
function handleJSONMessage(message, ws, sessionRef) {
  console.log(`[GMR Server] JSON message: ${message.type}`);
  
  switch (message.type) {
    case 'auth':
      handleAuth(message, ws);
      break;
    case 'ping':
      ws.send(JSON.stringify({ type: 'pong' }));
      break;
    case 'pong':
      // Client responded to our ping
      break;
    case 'participant':
      handleParticipantEvent(message, sessionRef);
      break;
    case 'transcript':
      handleTranscriptLine(message, sessionRef);
      break;
    case 'recording_end':
      console.log(`[GMR Server] Recording ended: ${JSON.stringify(message)}`);
      break;
    default:
      console.log(`[GMR Server] Unknown message type: ${message.type}`);
  }
}

// Handle authentication
function handleAuth(message, ws) {
  const { meetingId, clientType } = message;
  console.log(`[GMR Server] Auth: meeting=${meetingId}, type=${clientType}`);
  
  // Create session
  const session = {
    meetingId,
    clientType,
    startTime: Date.now(),
    chunkCount: 0,
    participants: [],
    transcript: [],
    recordingFile: null,
    recordingStream: null,
    ws
  };
  
  // Store session globally (for this demo, we use a simple approach)
  // In production, you'd use a Map keyed by client ID
  sessions.set(ws, session);
  
  // Send status response
  ws.send(JSON.stringify({
    type: 'status',
    recording: false,
    message: 'Authenticated successfully'
  }));
}

// Handle participant event
function handleParticipantEvent(message, session) {
  if (!session) return;
  
  const event = {
    event: message.event,
    name: message.name,
    timestamp: message.timestamp,
    receivedAt: new Date().toISOString()
  };
  
  session.participants.push(event);
  
  // Save to file
  saveJSON(session, 'participants.json', session.participants);
  
  console.log(`[GMR Server] Participant: ${message.name} ${message.event} at ${message.timestamp}`);
}

// Handle transcript line
function handleTranscriptLine(message, session) {
  if (!session) return;
  
  const line = {
    speaker: message.speaker,
    text: message.text,
    timestamp: message.timestamp,
    receivedAt: new Date().toISOString()
  };
  
  session.transcript.push(line);
  
  // Save to file
  saveJSON(session, 'transcript.json', session.transcript);
  
  console.log(`[GMR Server] Transcript: [${message.speaker}] ${message.text.substring(0, 60)}...`);
}

// Save JSON data to file
function saveJSON(session, filename, data) {
  if (!session) return;
  
  const filepath = path.join(OUTPUT_DIR, `meeting_${session.meetingId}_${filename}`);
  fs.writeFileSync(filepath, JSON.stringify(data, null, 2));
}

// Close session
function closeSession(session) {
  if (!session) return;
  
  console.log(`[GMR Server] Closing session for meeting: ${session.meetingId}`);
  
  // Close recording stream
  if (session.recordingStream) {
    session.recordingStream.end();
    console.log(`[GMR Server] Recording saved: ${session.recordingFile}`);
    console.log(`[GMR Server] Total chunks: ${session.chunkCount}`);
  }
  
  // Save final participant list
  if (session.participants.length > 0) {
    saveJSON(session, 'participants_final.json', session.participants);
    console.log(`[GMR Server] Total participant events: ${session.participants.length}`);
  }
  
  // Save final transcript
  if (session.transcript.length > 0) {
    saveJSON(session, 'transcript_final.json', session.transcript);
    console.log(`[GMR Server] Total transcript lines: ${session.transcript.length}`);
  }
  
  // Calculate duration
  const duration = Date.now() - session.startTime;
  console.log(`[GMR Server] Session duration: ${(duration / 1000).toFixed(1)}s`);
}

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n[GMR Server] Shutting down...');
  sessions.forEach((session) => closeSession(session));
  wss.close(() => {
    process.exit(0);
  });
});

console.log('[GMR Server] Ready! Waiting for connections...');
