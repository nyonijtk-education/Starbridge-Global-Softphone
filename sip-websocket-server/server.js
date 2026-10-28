import express from 'express';
import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import cors from 'cors';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import dotenv from 'dotenv';
import db, { initDb } from './db.js';

dotenv.config();

const PORT = process.env.PORT || 8080;
const JWT_SECRET = process.env.JWT_SECRET || 'starbridge_telecom_secret_key_2026';

const app = express();
app.use(cors());
app.use(express.json());

// Initialize SQLite Database
initDb();

// Active Connected WebSockets Registry: Map<ExtensionNumberString, WebSocket>
const activeSessions = new Map();

// Helper helpers for strict String-based Map operations
const getSession = (ext) => activeSessions.get(String(ext));
const setSession = (ext, ws) => activeSessions.set(String(ext), ws);
const hasSession = (ext) => activeSessions.has(String(ext));
const deleteSession = (ext) => activeSessions.delete(String(ext));

// Active Call Session Tracker
const activeCalls = new Map();

// Database Helper Utilities
function dbGet(sql, params = []) {
  if (typeof db.get === 'function') {
    return new Promise((resolve, reject) => {
      db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
    });
  }
  return Promise.resolve(db.prepare(sql).get(...params));
}

function dbAll(sql, params = []) {
  if (typeof db.all === 'function') {
    return new Promise((resolve, reject) => {
      db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
    });
  }
  return Promise.resolve(db.prepare(sql).all(...params));
}

function dbRun(sql, params = []) {
  if (typeof db.run === 'function') {
    return new Promise((resolve, reject) => {
      db.run(sql, params, function (err) { (err ? reject(err) : resolve(this)); });
    });
  }
  return Promise.resolve(db.prepare(sql).run(...params));
}

function updateOnlineStatus(ext, isOnline) {
  dbRun('UPDATE extensions SET is_online = ?, last_seen = CURRENT_TIMESTAMP WHERE extension = ?', [isOnline, String(ext)])
    .catch(err => console.error('Failed to update online status:', err));
}

function saveCallDetailRecord(cdr) {
  const sql = `
    INSERT INTO call_logs 
    (call_id, caller_ext, callee_ext, status, started_at, ended_at, duration_seconds, formatted_duration) 
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `;
  const params = [
    cdr.callId,
    String(cdr.caller),
    String(cdr.callee),
    cdr.status,
    cdr.startedAt.toISOString(),
    cdr.endedAt.toISOString(),
    cdr.durationSeconds,
    cdr.formattedDuration
  ];

  dbRun(sql, params).catch(err => console.error('Error persisting CDR to DB:', err));
}

// REST API Endpoints
app.post('/api/auth/login', async (req, res) => {
  const { extension, password } = req.body;
  if (!extension || !password) {
    return res.status(400).json({ error: 'Extension and password required' });
  }

  try {
    const user = await dbGet('SELECT * FROM extensions WHERE extension = ?', [String(extension)]);
    if (!user) {
      return res.status(401).json({ error: 'Invalid extension or credentials' });
    }

    const isValid = await bcrypt.compare(password, user.password_hash);
    if (!isValid) {
      return res.status(401).json({ error: 'Invalid extension or credentials' });
    }

    const token = jwt.sign(
      { extension: user.extension, role: user.role },
      JWT_SECRET,
      { expiresIn: '24h' }
    );

    res.json({
      message: 'Authentication successful',
      token,
      extension: user.extension,
      role: user.role
    });
  } catch (err) {
    res.status(500).json({ error: 'Internal server authentication error' });
  }
});

app.get('/api/cdr/history', async (req, res) => {
  const extension = req.query.extension;
  let sql = 'SELECT * FROM call_logs ORDER BY started_at DESC LIMIT 100';
  let params = [];

  if (extension) {
    sql = 'SELECT * FROM call_logs WHERE caller_ext = ? OR callee_ext = ? ORDER BY started_at DESC LIMIT 100';
    params = [String(extension), String(extension)];
  }

  try {
    const rows = await dbAll(sql, params);
    res.json({ callLogs: rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch call history' });
  }
});

// WebSocket Signaling Engine
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  let boundExtension = null;

  ws.on('message', async (message) => {
    const rawText = message.toString();
    let msg = null;

    try {
      msg = JSON.parse(rawText);
    } catch (e) {
      if (rawText.includes('REGISTER sip:')) {
        const extMatch = rawText.match(/From:\s*<sip:([^@]+)@/);
        if (extMatch && extMatch[1]) {
          const reqExt = String(extMatch[1]);

          if (hasSession(reqExt)) {
            const existingWs = getSession(reqExt);
            if (existingWs !== ws && existingWs.readyState === WebSocket.OPEN) {
              ws.send(`SIP/2.0 409 Conflict\r\nReason: Extension ${reqExt} already registered on another active device\r\n\r\n`);
              return;
            }
          }

          boundExtension = reqExt;
          setSession(boundExtension, ws);
          updateOnlineStatus(boundExtension, 1);

          ws.send(`SIP/2.0 200 OK\r\nContact: <sip:${boundExtension}>\r\n\r\n`);
        }
      }
      return;
    }

    switch (msg.type) {
      
      case 'register': {
        const reqExt = msg.extension ? String(msg.extension) : null;
        const password = msg.password;
        const authUser = msg.authUser ? String(msg.authUser) : reqExt;
        const isBiometricAuth = msg.biometricVerified === true;

        if (!reqExt || reqExt === 'undefined') {
          ws.send(JSON.stringify({ type: 'error', reason: 'Valid extension number is required', code: 400 }));
          return;
        }

        try {
          const dbUser = await dbGet('SELECT * FROM extensions WHERE extension = ? OR auth_user = ?', [reqExt, authUser]);
          
          if (dbUser) {
            if (!isBiometricAuth && password) {
              const isPasswordValid = await bcrypt.compare(password, dbUser.password_hash);
              if (!isPasswordValid) {
                ws.send(JSON.stringify({
                  type: 'error',
                  reason: `Invalid credentials for extension ${reqExt}`,
                  code: 401
                }));
                return;
              }
            }
          } else {
            if (password) {
              const hash = await bcrypt.hash(password, 10);
              await dbRun('INSERT INTO extensions (extension, auth_user, password_hash) VALUES (?, ?, ?)', [reqExt, authUser, hash]);
            }
          }
        } catch (err) {
          console.error('Error verifying database extension credentials:', err);
        }

        if (hasSession(reqExt)) {
          const existingWs = getSession(reqExt);
          if (existingWs !== ws && existingWs.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
              type: 'error',
              reason: `Extension ${reqExt} is already registered on another active session.`,
              code: 409
            }));
            return;
          }
        }

        boundExtension = reqExt;
        setSession(boundExtension, ws);
        updateOnlineStatus(boundExtension, 1);

        ws.send(JSON.stringify({
          type: 'registered',
          extension: boundExtension,
          authMethod: isBiometricAuth ? 'BIOMETRIC' : 'PASSWORD',
          status: 'SUCCESS'
        }));
        console.log(`[WS REGISTRATION] Extension ${boundExtension} active.`);
        break;
      }

      case 'invite': {
        const from = String(msg.from);
        const target = String(msg.target);
        const sdp = msg.sdp;
        const callId = msg.callId || `call-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
        
        const targetWs = getSession(target);

        activeCalls.set(callId, {
          callId,
          caller: from,
          callee: target,
          startTime: new Date(),
          answerTime: null
        });

        if (targetWs && targetWs.readyState === WebSocket.OPEN) {
          targetWs.send(JSON.stringify({
            type: 'invite',
            callId,
            from,
            target,
            sdp
          }));
          console.log(`[CALL INVITE FORWARDED] ${from} -> ${target}`);
        } else {
          ws.send(JSON.stringify({
            type: 'error',
            reason: `Extension ${target} is offline`,
            code: 404
          }));

          saveCallDetailRecord({
            callId,
            caller: from,
            callee: target,
            status: 'FAILED',
            startedAt: new Date(),
            endedAt: new Date(),
            durationSeconds: 0,
            formattedDuration: '00:00'
          });

          activeCalls.delete(callId);
          console.log(`[CALL INVITE FAILED] Target extension ${target} is offline.`);
        }
        break;
      }

      case 'answer': {
        const from = String(msg.from);
        const target = String(msg.target);
        const { sdp, callId } = msg;

        const targetWs = getSession(target);

        if (callId && activeCalls.has(callId)) {
          const callSession = activeCalls.get(callId);
          callSession.answerTime = new Date();
        }

        if (targetWs && targetWs.readyState === WebSocket.OPEN) {
          targetWs.send(JSON.stringify({ type: 'answer', from, target, sdp }));
          console.log(`[CALL ANSWERED] ${from} -> ${target}`);
        }
        break;
      }

      case 'ice-candidate': {
        const target = String(msg.target);
        const { candidate } = msg;
        const targetWs = getSession(target);
        if (targetWs && targetWs.readyState === WebSocket.OPEN) {
          targetWs.send(JSON.stringify({ type: 'ice-candidate', from: boundExtension, candidate }));
        }
        break;
      }

      case 'hold': {
        const target = String(msg.target);
        const { hold } = msg;
        const targetWs = getSession(target);
        if (targetWs && targetWs.readyState === WebSocket.OPEN) {
          targetWs.send(JSON.stringify({ type: 'hold', from: boundExtension, hold }));
        }
        break;
      }

      case 'bye':
      case 'hangup': {
        const target = String(msg.target);
        const { duration, callId } = msg;
        const targetWs = getSession(target);

        if (targetWs && targetWs.readyState === WebSocket.OPEN) {
          targetWs.send(JSON.stringify({
            type: 'bye',
            from: boundExtension,
            duration: duration || '00:00'
          }));
        }

        let durationSec = 0;
        let formattedDur = duration || '00:00';
        let startedAt = new Date();
        let endedAt = new Date();

        if (callId && activeCalls.has(callId)) {
          const session = activeCalls.get(callId);
          startedAt = session.startTime;
          if (session.answerTime) {
            durationSec = Math.floor((endedAt.getTime() - session.answerTime.getTime()) / 1000);
            const m = String(Math.floor(durationSec / 60)).padStart(2, '0');
            const s = String(durationSec % 60).padStart(2, '0');
            formattedDur = `${m}:${s}`;
          }
          activeCalls.delete(callId);
        }

        saveCallDetailRecord({
          callId: callId || `call-${Date.now()}`,
          caller: boundExtension || 'UNKNOWN',
          callee: target,
          status: 'ANSWERED',
          startedAt,
          endedAt,
          durationSeconds: durationSec,
          formattedDuration: formattedDur
        });

        console.log(`[CALL TERMINATED] ${boundExtension} -> ${target} | Duration: ${formattedDur}`);
        break;
      }

      case 'broadcast': {
        const { message: broadcastMsg } = msg;
        const sender = String(msg.from || boundExtension || 'ADMIN');

        dbRun('INSERT INTO broadcast_logs (sender_ext, message) VALUES (?, ?)', [sender, broadcastMsg])
          .catch(err => console.error('Error logging broadcast:', err));

        wss.clients.forEach((client) => {
          if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({
              type: 'broadcast',
              from: sender,
              message: broadcastMsg,
              timestamp: new Date().toISOString()
            }));
          }
        });
        break;
      }

      default:
        console.warn('Unknown WebSocket message type:', msg.type);
    }
  });

  ws.on('close', () => {
    if (boundExtension) {
      deleteSession(boundExtension);
      updateOnlineStatus(boundExtension, 0);
      console.log(`[DISCONNECTED] Extension ${boundExtension} offline.`);
    }
  });
});

server.listen(PORT, () => {
  console.log(`=================================================`);
  console.log(` STARBRIDGE PBX BACKEND SERVER RUNNING ON PORT ${PORT} `);
  console.log(`=================================================`);
});