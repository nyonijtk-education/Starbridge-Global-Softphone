/**
 * Production WebRTC/SIP Router & Static Host with Keep-Alive
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8089;

// 1. Static File HTTP Server
const server = http.createServer((req, res) => {
  let filePath = req.url === '/' ? '/index.html' : req.url;
  let fullPath = path.join(__dirname, filePath);

  fs.readFile(fullPath, (err, data) => {
    if (err) {
      fs.readFile(path.join(__dirname, 'index.html'), (errIdx, idxData) => {
        if (errIdx) {
          res.writeHead(500);
          res.end('Error loading softphone interface');
        } else {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(idxData);
        }
      });
    } else {
      let ext = path.extname(fullPath);
      let contentType = 'text/html';
      if (ext === '.js') contentType = 'text/javascript';
      if (ext === '.css') contentType = 'text/css';
      if (ext === '.json') contentType = 'application/json';

      res.writeHead(200, { 'Content-Type': contentType });
      res.end(data);
    }
  });
});

// 2. WebSocket Signaling Proxy
const wss = new WebSocketServer({ server });
const clients = new Map(); // ext string -> ws socket

// Keep-Alive Ping Interval (Prevents Render 55s timeout)
const pingInterval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

wss.on('connection', (ws, req) => {
  let registeredExt = null;
  ws.isAlive = true;

  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (data) => {
    const rawSip = data.toString();
    const firstLine = rawSip.split('\r\n')[0] || '';

    // A. JSON Protocol Handling (WebRTC Direct Signaling)
    try {
      const msg = JSON.parse(rawSip);

      if (msg.type === 'register') {
        registeredExt = String(msg.ext);
        clients.set(registeredExt, ws);
        console.log(`✅ [REGISTER] Ext ${registeredExt} registered`);
        ws.send(JSON.stringify({ type: 'registered', ext: registeredExt }));
        return;
      }

      if (['invite', 'answer', 'ice-candidate', 'bye', 'cancel'].includes(msg.type)) {
        const targetExt = String(msg.target);
        const targetWs = clients.get(targetExt);

        if (targetWs && targetWs.readyState === 1) {
          console.log(`📲 [RELAY] ${msg.type.toUpperCase()} from ${msg.from} -> ${targetExt}`);
          targetWs.send(JSON.stringify(msg));
        } else {
          console.log(`⚠️ [DROPPED] Target ${targetExt} not reachable`);
          ws.send(JSON.stringify({ type: 'error', reason: `Extension ${targetExt} is offline` }));
        }
        return;
      }
    } catch (e) {}

    // B. Standard SIP Header Fallback
    if (firstLine.startsWith('REGISTER')) {
      const fromMatch = rawSip.match(/From:\s*<sip:([^@>]+)/i) || rawSip.match(/From:\s*sip:([^@>]+)/i);
      const ext = fromMatch ? fromMatch[1] : '1001';
      registeredExt = String(ext);
      clients.set(registeredExt, ws);
      console.log(`✅ [SIP REGISTER] Ext ${registeredExt} registered`);

      const res = `SIP/2.0 200 OK\r\nVia: SIP/2.0/WSS localhost\r\nFrom: <sip:${ext}@localhost>\r\nTo: <sip:${ext}@localhost>;tag=reg123\r\nCSeq: 1 REGISTER\r\nContent-Length: 0\r\n\r\n`;
      ws.send(res);
      return;
    }

    const toMatch = rawSip.match(/To:\s*<sip:([^@>]+)/i) || rawSip.match(/^(?:INVITE|BYE|CANCEL|ACK)\s+sip:([^@>]+)/i);
    const toExt = toMatch ? String(toMatch[1]) : null;

    if (toExt && clients.has(toExt)) {
      clients.get(toExt).send(rawSip);
    } else if (firstLine.startsWith('SIP/2.0')) {
      for (const [ext, clientWs] of clients.entries()) {
        if (clientWs !== ws && clientWs.readyState === 1) clientWs.send(rawSip);
      }
    }
  });

  ws.on('close', () => {
    // ONLY delete if this specific socket is the active registered one
    if (registeredExt && clients.get(registeredExt) === ws) {
      clients.delete(registeredExt);
      console.log(`[-] Ext ${registeredExt} disconnected`);
    }
  });
});

wss.on('close', () => clearInterval(pingInterval));

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 NexusVoIP Server listening on port ${PORT}`);
});