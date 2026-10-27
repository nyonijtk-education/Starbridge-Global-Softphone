/**
 * Render-Compatible Cloud WebRTC/SIP Router & Static Host
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8089;

// 1. Create HTTP Server to serve index.html
const server = http.createServer((req, res) => {
  let filePath = req.url === '/' ? '/index.html' : req.url;
  let fullPath = path.join(__dirname, filePath);

  fs.readFile(fullPath, (err, data) => {
    if (err) {
      // Fallback to index.html for single-page routing
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

// 2. Attach WebSocket Server to the same HTTP Server
const wss = new WebSocketServer({ server });
const clients = new Map(); // ext -> ws socket

wss.on('connection', (ws, req) => {
  let registeredExt = null;
  console.log(`[+] Client connected from ${req.socket.remoteAddress}`);

  ws.on('message', (data) => {
    const rawSip = data.toString();
    const firstLine = rawSip.split('\r\n')[0] || '';

    // A. JSON Message Router (WebRTC Multi-tab signaling)
    try {
      const msg = JSON.parse(rawSip);
      if (msg.type === 'register') {
        registeredExt = String(msg.ext);
        clients.set(registeredExt, ws);
        console.log(`✅ [REGISTRATION] Extension ${registeredExt} is ONLINE`);
        ws.send(JSON.stringify({ type: 'registered', ext: registeredExt }));
        return;
      }
      if (['invite', 'answer', 'ice-candidate', 'bye'].includes(msg.type)) {
        const targetWs = clients.get(String(msg.target));
        if (targetWs && targetWs.readyState === 1) {
          targetWs.send(JSON.stringify(msg));
        }
        return;
      }
    } catch (e) {}

    // B. Standard SIP Packet Routing Fallback
    if (firstLine.startsWith('REGISTER')) {
      const fromMatch = rawSip.match(/From:\s*<sip:([^@>]+)/i) || rawSip.match(/From:\s*sip:([^@>]+)/i);
      const ext = fromMatch ? fromMatch[1] : '1001';
      registeredExt = ext;
      clients.set(ext, ws);
      console.log(`✅ [SIP REGISTER] Extension ${ext} ONLINE`);

      const res = `SIP/2.0 200 OK\r\nVia: SIP/2.0/WSS localhost\r\nFrom: <sip:${ext}@localhost>\r\nTo: <sip:${ext}@localhost>;tag=reg123\r\nCSeq: 1 REGISTER\r\nContent-Length: 0\r\n\r\n`;
      ws.send(res);
      return;
    }

    const toMatch = rawSip.match(/To:\s*<sip:([^@>]+)/i) || rawSip.match(/^(?:INVITE|BYE|CANCEL|ACK)\s+sip:([^@>]+)/i);
    const toExt = toMatch ? toMatch[1] : null;

    if (toExt && clients.has(toExt)) {
      clients.get(toExt).send(rawSip);
    } else if (firstLine.startsWith('SIP/2.0')) {
      for (const [ext, clientWs] of clients.entries()) {
        if (clientWs !== ws && clientWs.readyState === 1) clientWs.send(rawSip);
      }
    }
  });

  ws.on('close', () => {
    if (registeredExt) clients.delete(registeredExt);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`===================================================`);
  console.log(`🚀 NexusVoIP Server listening on port ${PORT}`);
  console.log(`===================================================`);
});