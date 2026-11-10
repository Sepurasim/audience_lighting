/**
 * Local Art-Net → WebSocket Forwarder
 * Run this on a computer that is in the SAME network as the grandMA2
 * and can reach the public Audience Lighting server over the internet.
 *
 * Usage:
 *   node forwarder.js
 *
 * Environment variables (optional):
 *   SERVER_URL      = wss://your-server.com   (or ws:// for local testing)
 *   FORWARDER_SECRET = the same secret as on the server
 *   ARTNET_UNIVERSE  = 0                      (which universe to listen to)
 */

const dgram = require('dgram');
const WebSocket = require('ws');

const SERVER_URL = process.env.SERVER_URL || 'ws://localhost:3000';
const SECRET = process.env.FORWARDER_SECRET || 'change-me-to-a-strong-secret';
const UNIVERSE = parseInt(process.env.ARTNET_UNIVERSE || '0', 10);

const ARTNET_PORT = 6454;
const HEADER = Buffer.from('Art-Net\0');

let ws = null;
let lastSent = null;
let reconnectTimer = null;

function connectWS() {
  console.log(`Connecting to ${SERVER_URL} …`);
  ws = new WebSocket(SERVER_URL);

  ws.on('open', () => {
    console.log('Connected to public server');
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  });

  ws.on('close', () => {
    console.log('Disconnected from server – reconnecting in 3 s');
    scheduleReconnect();
  });

  ws.on('error', (err) => {
    console.error('WS error:', err.message);
    ws.close();
  });
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectWS();
  }, 3000);
}

function sendUniverse(data) {
  if (!ws || ws.readyState !== 1) return;

  // Only send if something changed (simple optimisation)
  const key = data.slice(0, 60).join(',');
  if (key === lastSent) return;
  lastSent = key;

  ws.send(JSON.stringify({
    type: 'artnet',
    secret: SECRET,
    data: Array.from(data)   // 512 values
  }));
}

// ---- Art-Net UDP receiver ----
const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

socket.on('message', (msg, rinfo) => {
  // Basic Art-Net DMX packet validation
  if (msg.length < 18) return;
  if (!msg.slice(0, 8).equals(HEADER)) return;

  const opcode = msg.readUInt16LE(8);
  if (opcode !== 0x5000) return; // OpDmx / OpOutput

  const sequence = msg[12];
  const physical = msg[13];
  const universe = msg.readUInt16LE(14);
  const length = msg.readUInt16BE(16);

  // Filter to the universe we care about
  if (universe !== UNIVERSE) return;

  const dmx = msg.slice(18, 18 + Math.min(length, 512));
  // Pad to 512 if needed
  const full = Buffer.alloc(512);
  dmx.copy(full);

  sendUniverse(full);
});

socket.on('listening', () => {
  const addr = socket.address();
  console.log(`Art-Net listener on ${addr.address}:${addr.port}`);
  console.log(`Watching Universe ${UNIVERSE}`);
  console.log(`Forwarding to ${SERVER_URL}`);
  console.log('Make sure grandMA2 is outputting Art-Net to this machine (Broadcast or Unicast).');
});

socket.on('error', (err) => {
  console.error('UDP error:', err);
});

socket.bind(ARTNET_PORT, () => {
  // Enable broadcast reception if needed
  try {
    socket.setBroadcast(true);
  } catch (e) {}
});

// Start WebSocket
connectWS();

// Keep process alive
process.on('SIGINT', () => {
  console.log('\nShutting down…');
  socket.close();
  if (ws) ws.close();
  process.exit(0);
});
