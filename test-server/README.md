# Test WebSocket Server

A simple Node.js WebSocket server for testing the Google Meet Recorder extension.

## Quick Start

```bash
# Install dependencies
npm install

# Start the server
npm start
```

The server will start on port 8080 (or set `PORT` env variable).

## What It Does

1. Accepts WebSocket connections from the extension
2. Authenticates clients and tracks meeting sessions
3. Receives and saves:
   - **Recording files**: WebM video files saved to `recordings/` folder
   - **Participant events**: JSON file with all join/leave events
   - **Transcript lines**: JSON file with all caption lines
4. Shows real-time progress in the console

## Output Files

All files are saved to the `recordings/` folder:

```
recordings/
  meeting_abc-defg-hij_1234567890.webm        # Video recording
  meeting_abc-defg-hij_participants.json      # Participant events
  meeting_abc-defg-hij_transcript.json        # Live transcript
```

## API Reference

The server implements the protocol described in the main README:

- Accepts binary chunks (WebM video data)
- Accepts JSON messages (auth, participants, transcripts)
- Sends ping/pong heartbeats
- Supports remote stop command

## Production Notes

This is a minimal test server. For production use, consider:
- Adding authentication (API keys, JWT tokens)
- Implementing proper session management
- Adding database persistence
- Handling concurrent recordings
- Adding rate limiting
- Using SSL/TLS (wss://)
