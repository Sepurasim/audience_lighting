/**
 * Stadium Light Backend
 * - Multi-Session support (custom name + password)
 * - 10 Zones x (Dimmer + R + G + B + W + Strobe + Torch)
 * - Zone rename + 2D layout positions
 * - Art-Net via local forwarder
 */

const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');
const cors = require('cors');
const crypto = require('crypto');
const fs = require('fs');

const PORT = process.env.PORT || 3000;
const FORWARDER_SECRET = process.env.FORWARDER_SECRET || 'change-me-to-a-strong-secret';
const NUM_ZONES = 10;
const DATA_FILE = path.join(__dirname, 'sessions-data.json');

function hashPw(pw) {
  return crypto.createHash('sha256').update(String(pw) + 'stadium-salt').digest('hex');
}

function makeZone(id, name) {
  return {
    id,
    name: name || ('Zone ' + id),
    x: 0.1 + ((id - 1) % 5) * 0.18,
    y: 0.2 + Math.floor((id - 1) / 5) * 0.35,
    dimmer: 0, r: 0, g: 0, b: 0, w: 0, strobe: 0, torch: 0,
    clients: 0
  };
}

function createSession(name, password) {
  const id = crypto.randomBytes(6).toString('hex');
  const session = {
    id,
    name: String(name).trim().slice(0, 64),
    passwordHash: hashPw(password),
    zones: Array.from({ length: NUM_ZONES }, function(_, i) { return makeZone(i + 1); }),
    createdAt: Date.now()
  };
  sessions[id] = session;
  saveSessions();
  return session;
}

function saveSessions() {
  try {
    const data = {};
    for (const id of Object.keys(sessions)) {
      const s = sessions[id];
      data[id] = {
        id: s.id,
        name: s.name,
        passwordHash: s.passwordHash,
        zones: s.zones.map(function(z) {
          return { id: z.id, name: z.name, x: z.x, y: z.y };
        }),
        createdAt: s.createdAt
      };
    }
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  } catch (e) {
    console.warn('Could not save sessions:', e.message);
  }
}

function loadSessions() {
  try {
    if (!fs.existsSync(DATA_FILE)) return;
    const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    for (const id of Object.keys(raw)) {
      const s = raw[id];
      sessions[id] = {
        id: s.id,
        name: s.name,
        passwordHash: s.passwordHash,
        zones: (s.zones || []).map(function(z, i) {
          const base = makeZone(z.id || (i + 1), z.name);
          base.x = typeof z.x === 'number' ? z.x : base.x;
          base.y = typeof z.y === 'number' ? z.y : base.y;
          return base;
        }),
        createdAt: s.createdAt || Date.now()
      };
      while (sessions[id].zones.length < NUM_ZONES) {
        const n = sessions[id].zones.length + 1;
        sessions[id].zones.push(makeZone(n));
      }
    }
    console.log('Loaded ' + Object.keys(sessions).length + ' sessions');
  } catch (e) {
    console.warn('Could not load sessions:', e.message);
  }
}

const sessions = {};
loadSessions();

if (Object.keys(sessions).length === 0) {
  createSession('Default', '1328');
  console.log('Created default session Default / password 1328');
}

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/health', function(req, res) {
  res.json({ status: 'ok', sessions: Object.keys(sessions).length, time: new Date().toISOString() });
});

app.get('/api/sessions', function(req, res) {
  res.json(Object.values(sessions).map(function(s) {
    return {
      id: s.id,
      name: s.name,
      zoneCount: s.zones.length,
      clients: s.zones.reduce(function(a, z) { return a + z.clients; }, 0)
    };
  }));
});

app.post('/api/sessions', function(req, res) {
  const body = req.body || {};
  const name = body.name;
  const password = body.password;
  if (!name || !password) return res.status(400).json({ error: 'name und password erforderlich' });
  if (String(password).length < 4) return res.status(400).json({ error: 'Passwort mindestens 4 Zeichen' });
  const exists = Object.values(sessions).some(function(s) {
    return s.name.toLowerCase() === String(name).trim().toLowerCase();
  });
  if (exists) return res.status(409).json({ error: 'Session-Name bereits vergeben' });
  const session = createSession(name, password);
  res.json({ id: session.id, name: session.name });
});

app.post('/api/sessions/auth', function(req, res) {
  const body = req.body || {};
  const name = body.name;
  const password = body.password;
  const session = Object.values(sessions).find(function(s) {
    return s.name.toLowerCase() === String(name || '').trim().toLowerCase();
  });
  if (!session || session.passwordHash !== hashPw(password)) {
    return res.status(401).json({ error: 'Name oder Passwort falsch' });
  }
  res.json({
    id: session.id,
    name: session.name,
    zones: session.zones.map(function(z) {
      return {
        id: z.id, name: z.name, x: z.x, y: z.y,
        dimmer: z.dimmer, r: z.r, g: z.g, b: z.b, w: z.w,
        strobe: z.strobe, torch: z.torch, clients: z.clients
      };
    })
  });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const clients = new Map();

function getSession(sessionId) {
  return sessions[sessionId] || null;
}

function broadcastZone(sessionId, zoneId) {
  const session = getSession(sessionId);
  if (!session) return;
  const zone = session.zones[zoneId - 1];
  if (!zone) return;
  const payload = JSON.stringify({
    type: 'zoneUpdate',
    sessionId: sessionId,
    zoneId: zoneId,
    name: zone.name,
    dimmer: zone.dimmer,
    r: zone.r, g: zone.g, b: zone.b, w: zone.w,
    strobe: zone.strobe,
    torch: zone.torch
  });
  for (const entry of clients) {
    const ws = entry[0];
    const meta = entry[1];
    if (ws.readyState !== 1) continue;
    if (meta.sessionId !== sessionId) continue;
    if (meta.type === 'audience' && meta.zoneId === zoneId) ws.send(payload);
    if (meta.type === 'control') ws.send(payload);
  }
}

function broadcastStatus(sessionId) {
  const session = getSession(sessionId);
  if (!session) return;
  const status = JSON.stringify({
    type: 'status',
    sessionId: sessionId,
    zones: session.zones.map(function(z) {
      return { id: z.id, name: z.name, x: z.x, y: z.y, clients: z.clients };
    })
  });
  for (const entry of clients) {
    const ws = entry[0];
    const meta = entry[1];
    if (meta.type === 'control' && meta.sessionId === sessionId && ws.readyState === 1) {
      ws.send(status);
    }
  }
}

function broadcastLayout(sessionId) {
  const session = getSession(sessionId);
  if (!session) return;
  const payload = JSON.stringify({
    type: 'layout',
    sessionId: sessionId,
    zones: session.zones.map(function(z) {
      return { id: z.id, name: z.name, x: z.x, y: z.y };
    })
  });
  for (const entry of clients) {
    const ws = entry[0];
    const meta = entry[1];
    if (meta.sessionId === sessionId && ws.readyState === 1) {
      if (meta.type === 'control' || meta.type === 'audience') ws.send(payload);
    }
  }
}

function clamp(v) {
  return Math.max(0, Math.min(255, Math.round(Number(v) || 0)));
}

wss.on('connection', function(ws) {
  const id = crypto.randomBytes(4).toString('hex');
  clients.set(ws, { type: 'unknown', sessionId: null, zoneId: null, id: id });

  ws.on('message', function(raw) {
    var msg;
    try { msg = JSON.parse(raw.toString()); } catch (e) { return; }
    var meta = clients.get(ws);
    if (!meta) return;

    if (msg.type === 'registerControl') {
      var session = getSession(msg.sessionId);
      if (!session) {
        ws.send(JSON.stringify({ type: 'error', error: 'Session nicht gefunden' }));
        return;
      }
      if (msg.password && session.passwordHash !== hashPw(msg.password)) {
        ws.send(JSON.stringify({ type: 'error', error: 'Passwort falsch' }));
        return;
      }
      meta.type = 'control';
      meta.sessionId = session.id;
      clients.set(ws, meta);
      ws.send(JSON.stringify({
        type: 'sessionData',
        sessionId: session.id,
        name: session.name,
        zones: session.zones.map(function(z) {
          return {
            id: z.id, name: z.name, x: z.x, y: z.y,
            dimmer: z.dimmer, r: z.r, g: z.g, b: z.b, w: z.w,
            strobe: z.strobe, torch: z.torch, clients: z.clients
          };
        })
      }));
      console.log('[+] Control ' + id + ' -> Session "' + session.name + '"');
    }

    if (msg.type === 'registerAudience') {
      var sessionA = null;
      if (msg.sessionId) sessionA = getSession(msg.sessionId);
      if (!sessionA && msg.sessionName) {
        sessionA = Object.values(sessions).find(function(s) {
          return s.name.toLowerCase() === String(msg.sessionName).trim().toLowerCase();
        });
      }
      if (!sessionA) {
        var ids = Object.keys(sessions);
        if (ids.length) sessionA = sessions[ids[0]];
      }
      if (!sessionA) {
        ws.send(JSON.stringify({ type: 'error', error: 'Keine Session verfuegbar' }));
        return;
      }
      var zoneId = Math.max(1, Math.min(NUM_ZONES, parseInt(msg.zoneId) || 1));
      meta.type = 'audience';
      meta.sessionId = sessionA.id;
      meta.zoneId = zoneId;
      sessionA.zones[zoneId - 1].clients++;
      clients.set(ws, meta);
      var z = sessionA.zones[zoneId - 1];
      ws.send(JSON.stringify({
        type: 'zoneUpdate',
        sessionId: sessionA.id,
        zoneId: zoneId,
        name: z.name,
        dimmer: z.dimmer, r: z.r, g: z.g, b: z.b, w: z.w,
        strobe: z.strobe, torch: z.torch
      }));
      ws.send(JSON.stringify({
        type: 'layout',
        sessionId: sessionA.id,
        zones: sessionA.zones.map(function(zz) {
          return { id: zz.id, name: zz.name, x: zz.x, y: zz.y };
        })
      }));
      broadcastStatus(sessionA.id);
      console.log('[+] Audience ' + id + ' -> Session "' + sessionA.name + '" Zone ' + zoneId);
    }

    if (msg.type === 'artnet' && msg.secret === FORWARDER_SECRET) {
      var data = msg.data;
      if (!Array.isArray(data) || data.length < 70) return;
      for (var sid of Object.keys(sessions)) {
        var sess = sessions[sid];
        for (var zi = 0; zi < NUM_ZONES; zi++) {
          var base = zi * 7;
          var dimmer = data[base] || 0;
          var r = data[base + 1] || 0;
          var g = data[base + 2] || 0;
          var b = data[base + 3] || 0;
          var w = data[base + 4] || 0;
          var strobe = data[base + 5] || 0;
          var torch = data[base + 6] || 0;
          var zone = sess.zones[zi];
          if (!zone) continue;
          if (zone.dimmer !== dimmer || zone.r !== r || zone.g !== g ||
              zone.b !== b || zone.w !== w || zone.strobe !== strobe ||
              zone.torch !== torch) {
            zone.dimmer = dimmer;
            zone.r = r; zone.g = g; zone.b = b; zone.w = w;
            zone.strobe = strobe;
            zone.torch = torch;
            broadcastZone(sess.id, zi + 1);
          }
        }
      }
    }

    if (msg.type === 'manual' && meta.type === 'control' && meta.sessionId) {
      var sessM = getSession(meta.sessionId);
      if (!sessM) return;
      var zm = sessM.zones[(msg.zoneId || 1) - 1];
      if (!zm) return;
      if (typeof msg.dimmer === 'number') zm.dimmer = clamp(msg.dimmer);
      if (typeof msg.r === 'number') zm.r = clamp(msg.r);
      if (typeof msg.g === 'number') zm.g = clamp(msg.g);
      if (typeof msg.b === 'number') zm.b = clamp(msg.b);
      if (typeof msg.w === 'number') zm.w = clamp(msg.w);
      if (typeof msg.strobe === 'number') zm.strobe = clamp(msg.strobe);
      if (typeof msg.torch === 'number') zm.torch = clamp(msg.torch);
      broadcastZone(sessM.id, msg.zoneId);
    }

    if (msg.type === 'renameZone' && meta.type === 'control' && meta.sessionId) {
      var sessR = getSession(meta.sessionId);
      if (!sessR) return;
      var zr = sessR.zones[(msg.zoneId || 1) - 1];
      if (!zr) return;
      var newName = String(msg.name || '').trim().slice(0, 32);
      if (!newName) return;
      zr.name = newName;
      saveSessions();
      broadcastLayout(sessR.id);
      broadcastStatus(sessR.id);
      broadcastZone(sessR.id, zr.id);
    }

    if (msg.type === 'updateLayout' && meta.type === 'control' && meta.sessionId) {
      var sessL = getSession(meta.sessionId);
      if (!sessL) return;
      if (!Array.isArray(msg.zones)) return;
      for (var i = 0; i < msg.zones.length; i++) {
        var item = msg.zones[i];
        var zl = sessL.zones[(item.id || 0) - 1];
        if (!zl) continue;
        if (typeof item.x === 'number') zl.x = Math.max(0, Math.min(1, item.x));
        if (typeof item.y === 'number') zl.y = Math.max(0, Math.min(1, item.y));
        if (typeof item.name === 'string' && item.name.trim()) {
          zl.name = item.name.trim().slice(0, 32);
        }
      }
      saveSessions();
      broadcastLayout(sessL.id);
      broadcastStatus(sessL.id);
    }
  });

  ws.on('close', function() {
    var meta = clients.get(ws);
    if (meta && meta.type === 'audience' && meta.sessionId && meta.zoneId) {
      var sess = getSession(meta.sessionId);
      if (sess && sess.zones[meta.zoneId - 1]) {
        sess.zones[meta.zoneId - 1].clients = Math.max(0, sess.zones[meta.zoneId - 1].clients - 1);
        broadcastStatus(meta.sessionId);
      }
    }
    clients.delete(ws);
  });

  ws.on('error', function() { clients.delete(ws); });
});

server.listen(PORT, function() {
  console.log('Stadium Light Server on port ' + PORT);
  console.log('Forwarder secret: ' + FORWARDER_SECRET);
  console.log('Sessions: ' + Object.keys(sessions).length);
});
