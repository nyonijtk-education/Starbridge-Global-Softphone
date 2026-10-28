const express = require('express');
const { createServer } = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const url = require('url');
const path = require('path');

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

// Serve static files from the project root directory
app.use(express.static(path.join(__dirname)));

// Track active clients: map userId -> WebSocket instance
const activeClients = new Map();

wss.on('connection', (ws, req) => {
    const parameters = url.parse(req.url, true).query;
    const userId = parameters.user;
    const token = parameters.token;

    if (!userId) {
        ws.close(4001, 'Unauthorized: Missing User ID');
        return;
    }

    // Register or overwrite active client connection
    activeClients.set(userId, ws);
    console.log(`Node Connected: #${userId} (Total online: ${activeClients.size})`);

    broadcastOnlineNodes();

    ws.on('message', (message) => {
        try {
            const msg = JSON.parse(message);
            const { event, target, data } = msg;

            console.log(`Relaying event [${event}] from #${userId} -> #${target || 'BROADCAST'}`);

            if (target && activeClients.has(target)) {
                // Direct message to a specific target node
                const targetWs = activeClients.get(target);
                if (targetWs.readyState === WebSocket.OPEN) {
                    targetWs.send(JSON.stringify({
                        sender_id: userId,
                        event: event,
                        data: data
                    }));
                }
            } else {
                // Broadcast to all other connected clients if no specific target is set
                wss.clients.forEach((client) => {
                    if (client !== ws && client.readyState === WebSocket.OPEN) {
                        client.send(JSON.stringify({
                            sender_id: userId,
                            event: event,
                            data: data
                        }));
                    }
                });
            }
        } catch (err) {
            console.error('Failed to parse incoming WebSocket message:', err);
        }
    });

    ws.on('close', () => {
        activeClients.delete(userId);
        console.log(`Node Disconnected: #${userId}`);
        broadcastOnlineNodes();
    });
});

function broadcastOnlineNodes() {
    const onlineUsers = Array.from(activeClients.keys());
    const payload = JSON.stringify({
        event: 'presence_update',
        data: JSON.stringify(onlineUsers)
    });

    wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(payload);
        }
    });
}

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
    console.log(`Starbridge Signaling Fabric running on port ${PORT}`);
});