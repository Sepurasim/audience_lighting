/**
 * Audience Lighting Backend
 * - Serves both frontends (Audience + Control)
 * - WebSocket hub for phones
 * - Receives zone data from local Art-Net forwarder
 * - 10 Zones × (Dimmer + R + G + B + W + Strobe + Torch)
 */

const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');
const cors = require('cors');

const PORT = process.env.PORT || 3000;
const FORWARDER_SECRET = process.env.FORWARDER_SECRET || 'change-me-to-a-strong-secret';

// 10 Zones, each with current values
const NUM_ZONES = 10;
const zones = Array.from({ length: NUM_ZONES }, (_, i) => ({
  id: i + 1,
  dimmer: 0,
  r: 0,
  g: 0,
  b: 0,
  w: 0,
  strobe: 0,          // 0 = off, 1-255 = speed
  torch: 0,           // 0-127 = off, 128-255 = on
  clients: 0
}));

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Health
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    zones: zones.map(z => ({ id: z.id, clients: z.clients })),
    time: new Date().toISOString()
  });
});

// Current zone state (for control panel)
app.get('/api/zones', (req, res) => {
  res.json(zones);
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// All connected clients
const clients = new Map(); // ws -> { type, zoneId, id }

function broadcastZone(zoneId) {
  const zone = zones[zoneId - 1];
  if (!zone) return;

  const payload = JSON.stringify({
    type: 'zoneUpdate',
    zoneId,
    dimmer: zone.dimmer,
    r: zone.r,
    g: zone.g,
    b: zone.b,
    w: zone.w,
    strobe: zone.strobe,
    torch: zone.torch
  });

  for (const [ws, meta] of clients) {
    if (ws.readyState !== 1) continue;
    // Audience clients of this zone
    if (meta.type === 'audience' && meta.zoneId === zoneId) {
      ws.send(payload);
    }
    // All control panels get live updates
    if (meta.type === 'control') {
      ws.send(payload);
    }
  }
}

function broadcastStatus() {
  const status = JSON.stringify({
    type: 'status',
    zones: zones.map(z => ({ id: z.id, clients: z.clients }))
  });
  for (const [ws, meta] of clients) {
    if (meta.type === 'control' && ws.readyState === 1) {
      ws.send(status);
    }
  }
}

wss.on('connection', (ws, req) => {
  const id = Math.random().toString(36).slice(2, 10);
  clients.set(ws, { type: 'unknown', zoneId: null, id });

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    const meta = clients.get(ws);
    if (!meta) return;

    // ---- Audience client registers ----
    if (msg.type === 'registerAudience') {
      meta.type = 'audience';
      meta.zoneId = Math.max(1, Math.min(NUM_ZONES, parseInt(msg.zoneId) || 1));
      zones[meta.zoneId - 1].clients++;
      clients.set(ws, meta);

      // send current values immediately
      const z = zones[meta.zoneId - 1];
      ws.send(JSON.stringify({
        type: 'zoneUpdate',
        zoneId: meta.zoneId,
        dimmer: z.dimmer,
        r: z.r,
        g: z.g,
        b: z.b,
        w: z.w,
        strobe: z.strobe,
        torch: z.torch
      }));

      broadcastStatus();
      console.log(`[+] Audience ${id} → Zone ${meta.zoneId} (total ${zones[meta.zoneId - 1].clients})`);
    }

    // ---- Control panel registers ----
    if (msg.type === 'registerControl') {
      meta.type = 'control';
      clients.set(ws, meta);
      ws.send(JSON.stringify({
        type: 'status',
        zones: zones.map(z => ({ id: z.id, clients: z.clients }))
      }));
      console.log(`[+] Control panel ${id}`);
    }

    // ---- Local Art-Net Forwarder sends universe data ----
    if (msg.type === 'artnet' && msg.secret === FORWARDER_SECRET) {
      // msg.data = array of 512 channel values (0-255)
      // We map first 70 channels to our 10 zones (7 ch each)
      const data = msg.data;
      if (!Array.isArray(data) || data.length < 70) return;

      for (let z = 0; z < NUM_ZONES; z++) {
        const base = z * 7;
        const dimmer = data[base]     || 0;
        const r      = data[base + 1] || 0;
        const g      = data[base + 2] || 0;
        const b      = data[base + 3] || 0;
        const w      = data[base + 4] || 0;
        const strobe = data[base + 5] || 0;
        const torch  = data[base + 6] || 0;

        const zone = zones[z];
        if (zone.dimmer !== dimmer || zone.r !== r || zone.g !== g ||
            zone.b !== b || zone.w !== w || zone.strobe !== strobe ||
            zone.torch !== torch) {
          zone.dimmer = dimmer;
          zone.r = r;
          zone.g = g;
          zone.b = b;
          zone.w = w;
          zone.strobe = strobe;
          zone.torch = torch;
          broadcastZone(z + 1);
        }
      }
    }

    // ---- Manual control from Control Panel (for testing) ----
    if (msg.type === 'manual' && meta.type === 'control') {
      const z = zones[(msg.zoneId || 1) - 1];
      if (!z) return;
      if (typeof msg.dimmer === 'number') z.dimmer = clamp(msg.dimmer);
      if (typeof msg.r === 'number') z.r = clamp(msg.r);
      if (typeof msg.g === 'number') z.g = clamp(msg.g);
      if (typeof msg.b === 'number') z.b = clamp(msg.b);
      if (typeof msg.w === 'number') z.w = clamp(msg.w);
      if (typeof msg.strobe === 'number') z.strobe = clamp(msg.strobe);
      if (typeof msg.torch === 'number') z.torch = clamp(msg.torch);
      broadcastZone(msg.zoneId);
    }
  });

  ws.on('close', () => {
    const meta = clients.get(ws);
    if (meta && meta.type === 'audience' && meta.zoneId) {
      zones[meta.zoneId - 1].clients = Math.max(0, zones[meta.zoneId - 1].clients - 1);
      broadcastStatus();
      console.log(`[-] Audience ${meta.id} left Zone ${meta.zoneId}`);
    }
    clients.delete(ws);
  });

  ws.on('error', () => {
    clients.delete(ws);
  });
});

function clamp(v) {
  return Math.max(0, Math.min(255, Math.round(v)));
}

server.listen(PORT, () => {
  console.log(`Audience Lighting Server running on port ${PORT}`);
  console.log(`Forwarder secret: ${FORWARDER_SECRET}`);
  console.log(`Open http://localhost:${PORT}/ for audience`);
  console.log(`Open http://localhost:${PORT}/control.html for operator`);
});
