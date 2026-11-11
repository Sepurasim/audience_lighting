# Stadium Audience Lighting System

Vollständiges System für 10 Zonen mit RGBW + Dimmer + Strobe.
Zuschauer-Handys brauchen **kein** Show-WLAN – sie verbinden sich über das Internet.

## Dateien

```
audience-lighting/
├── package.json
├── server.js                 ← Öffentlicher Backend-Server
├── public/
│   ├── index.html            ← Zuschauer-App (Fullscreen + Zone-Auswahl)
│   └── control.html          ← Operator-Panel (manuelle Steuerung + Status)
└── local-forwarder/
    └── forwarder.js          ← Läuft lokal im Art-Net-Netz der grandMA2
```

## 1. Öffentlichen Server starten (einmalig)

### Variante A – Schnell lokal testen
```bash
cd audience-lighting
npm install
FORWARDER_SECRET=mein-geheimes-passwort node server.js
```
Dann im Browser:
- Zuschauer: http://localhost:3000/
- Control:   http://localhost:3000/control.html

### Variante B – Online hosten (empfohlen für echte Events)

Mögliche Anbieter (Node.js Support):
- Railway.app
- Render.com
- Fly.io
- DigitalOcean App Platform
- eigener VPS (Ubuntu + Node)

Beispiel Railway / Render:
1. Repository auf GitHub pushen (oder ZIP hochladen)
2. Neues Web-Service anlegen
3. Build Command: `npm install`
4. Start Command: `node server.js`
5. Environment Variable setzen:
   - `FORWARDER_SECRET` = ein starkes Passwort (z. B. `Stadion2026!xyz`)
   - optional `PORT` (die meisten Plattformen setzen das automatisch)

Nach dem Deploy bekommst du eine URL wie:
`https://audience-lighting-xxxx.up.railway.app`

Diese URL teilst du den Zuschauern (QR-Code, Link in der App, etc.).

## 2. Lokalen Art-Net-Forwarder starten

Auf einem Laptop/PC, der im **selben Netzwerk** wie die grandMA2 steht:

```bash
cd audience-lighting
npm install          # falls noch nicht geschehen
SERVER_URL=wss://deine-server-url.up.railway.app \
FORWARDER_SECRET=mein-geheimes-passwort \
ARTNET_UNIVERSE=0 \
node local-forwarder/forwarder.js
```

Hinweise:
- Bei `https`-Servern immer `wss://` verwenden.
- `ARTNET_UNIVERSE` muss zum Universe passen, das die MA ausgibt (meist 0).
- Der Forwarder empfängt Art-Net auf Port 6454 und schickt nur die ersten 60 Kanäle weiter.

## 3. grandMA2 konfigurieren

1. Setup → Network Protocols → Art-Net Tab
2. Eine Zeile hinzufügen:
   - Mode: **OutputBroadcast** (oder OutputUnicast an die IP des Forwarder-PCs)
   - Local Start: 1 (oder das Universe, in dem deine Zonen liegen)
   - Amount: 1
   - Network / Subnet / Universe so einstellen, dass Universe 0 (oder das gewünschte) rausgeht
3. „Art-Net Output Active“ und „Network DMX if Alone“ aktivieren
4. Session starten

### Patch-Vorschlag in der MA

Erstelle 10 RGBW-Fixtures + Strobe-Kanal, oder ein Custom-Fixture mit 6 Kanälen:

| Kanal | Funktion   |
|-------|------------|
| 1     | Dimmer     |
| 2     | Red        |
| 3     | Green      |
| 4     | Blue       |
| 5     | White      |
| 6     | Strobe     |

Zone 1 = Adresse 1, Zone 2 = Adresse 7, … Zone 10 = Adresse 55.

## 4. Zuschauer-App nutzen

1. Handy öffnet die öffentliche URL
2. Zone auswählen (1–10)
3. „Fullscreen starten“ tippen
4. Display bleibt dunkel und reagiert auf DMX

Die App versucht Fullscreen + Screen-Wake-Lock.

## 5. Wichtige Sicherheitshinweise

- Ändere `FORWARDER_SECRET` unbedingt!
- Der Forwarder muss das gleiche Secret wie der Server haben.
- Für große Events (≥ 2000 Handys) brauchst du einen starken Server und ggf. Load-Balancing.
- Teste vorher mit 50–100 Geräten.

## 6. Fehleranalyse / Häufige Probleme

| Problem | Ursache | Lösung |
|---------|---------|--------|
| Keine Farbe auf den Handys | Forwarder nicht verbunden oder falsches Secret | Logs vom Forwarder prüfen, Secret vergleichen |
| Nur manche Zonen reagieren | Falsches Universe oder Adress-Mapping | Art-Net-Monitor (ArtNetominator) nutzen |
| High Latency / unsauberer Strobe | Schlechtes Internet auf dem Forwarder-PC | Kabelgebundenes Netz, guter Upstream |
| iPhone geht nicht in Fullscreen | Safari-Einschränkung | User muss den Button selbst tippen (Gesture) |
| Viele Clients, Server laggt | Zu schwache Instanz | Größeren Plan wählen oder horizontal skalieren |
| Art-Net kommt nicht an | Firewall / falsches Subnet | Forwarder und MA im gleichen Layer-2, Port 6454 UDP offen |

## Lizenz / Nutzung

Für Live-Events gedacht. Keine Gewähr für Produktionsstabilität ohne eigene Lasttests.
