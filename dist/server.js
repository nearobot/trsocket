"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.startServer = exports.getStats = exports.getAllSessions = exports.getSession = exports.createSession = exports.emit = exports.on = void 0;
const ws_1 = require("ws");
const http_1 = __importDefault(require("http"));
const uuid_1 = require("uuid");
const sessions = new Map();
const connections = new Map();
const events = {};
function on(event, callback) {
    if (!events[event]) {
        events[event] = [];
    }
    events[event].push(callback);
}
exports.on = on;
function emit(event, data) {
    if (events[event]) {
        events[event].forEach(callback => {
            try {
                callback(data);
            }
            catch (error) {
                console.error(`Error in event callback for ${event}:`, error);
            }
        });
    }
}
exports.emit = emit;
function sendMessage(ws, message) {
    if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify(message));
    }
}
function handleMessage(ws, message) {
    try {
        const data = JSON.parse(message);
        console.log(`[${new Date().toISOString()}] Received message:`, {
            type: data.type,
            sessionId: data.sessionId || 'none',
            hasWalletId: !!data.walletId
        });
        switch (data.type) {
            case 'init_session':
                handleInitSession(ws, data);
                break;
            case 'wallet_connected':
                handleWalletConnected(ws, data);
                break;
            case 'ping':
                sendMessage(ws, {
                    type: 'pong',
                    timestamp: new Date().toISOString()
                });
                break;
            default:
                console.log(`[${new Date().toISOString()}] Unknown message type: ${data.type}`);
                sendMessage(ws, {
                    type: 'error',
                    message: 'Unknown message type',
                    timestamp: new Date().toISOString()
                });
        }
    }
    catch (error) {
        console.error(`[${new Date().toISOString()}] Error parsing message:`, error);
        sendMessage(ws, {
            type: 'error',
            message: 'Invalid message format',
            timestamp: new Date().toISOString()
        });
    }
}
function handleInitSession(ws, data) {
    const { sessionId } = data;
    if (!sessionId) {
        sendMessage(ws, {
            type: 'error',
            message: 'Session ID is required',
            timestamp: new Date().toISOString()
        });
        return;
    }
    const session = sessions.get(sessionId);
    if (!session) {
        console.log(`[${new Date().toISOString()}] Invalid session attempt: ${sessionId}`);
        sendMessage(ws, {
            type: 'error',
            message: 'Invalid or expired session',
            timestamp: new Date().toISOString()
        });
        return;
    }
    connections.set(sessionId, ws);
    ws.sessionId = sessionId;
    session.status = 'connected';
    session.connectedAt = new Date();
    sendMessage(ws, {
        type: 'session_initialized',
        userId: session.userId,
        username: session.username,
        sessionId: sessionId,
        timestamp: new Date().toISOString()
    });
    console.log(`[${new Date().toISOString()}] ✅ Session ${sessionId} initialized for user ${session.username}`);
}
function handleWalletConnected(ws, data) {
    const { sessionId, walletId, txnLink } = data;
    if (!sessionId || !walletId) {
        sendMessage(ws, {
            type: 'error',
            message: 'Session ID and wallet ID are required',
            timestamp: new Date().toISOString()
        });
        return;
    }
    const session = sessions.get(sessionId);
    if (!session) {
        sendMessage(ws, {
            type: 'error',
            message: 'Invalid or expired session',
            timestamp: new Date().toISOString()
        });
        return;
    }
    session.walletId = walletId;
    session.txnLink = txnLink || '';
    session.status = 'wallet_connected';
    session.walletConnectedAt = new Date();
    console.log(`[${new Date().toISOString()}] 💰 Wallet ${walletId} connected for session ${sessionId}`);
    emit('wallet_connected', {
        userId: session.userId,
        chatId: session.chatId,
        username: session.username,
        walletId: walletId,
        txnLink: txnLink || '',
        sessionId: sessionId,
        timestamp: new Date().toISOString()
    });
    sendMessage(ws, {
        type: 'wallet_connection_received',
        message: 'Wallet connected successfully!',
        timestamp: new Date().toISOString()
    });
}
function cleanupConnection(ws) {
    const sessionId = ws.sessionId;
    if (sessionId) {
        connections.delete(sessionId);
        console.log(`[${new Date().toISOString()}] 🧹 Cleaned up connection for session ${sessionId}`);
    }
}
function cleanupExpiredSessions() {
    const now = new Date();
    const expiredSessions = [];
    sessions.forEach((session, sessionId) => {
        const sessionAge = now.getTime() - session.createdAt.getTime();
        const oneHour = 60 * 60 * 1000;
        if (sessionAge > oneHour) {
            expiredSessions.push(sessionId);
        }
    });
    expiredSessions.forEach(sessionId => {
        console.log(`[${new Date().toISOString()}] 🗑️ Cleaning up expired session: ${sessionId}`);
        sessions.delete(sessionId);
        connections.delete(sessionId);
    });
    if (expiredSessions.length > 0) {
        console.log(`[${new Date().toISOString()}] 📊 Cleaned up ${expiredSessions.length} expired sessions`);
    }
}
function getStats() {
    const memUsage = process.memoryUsage();
    return {
        activeSessions: sessions.size,
        activeConnections: connections.size,
        uptime: process.uptime(),
        memory: {
            used: memUsage.heapUsed,
            total: memUsage.heapTotal,
            external: memUsage.external
        },
        timestamp: new Date().toISOString(),
        nodeVersion: process.version,
        platform: process.platform
    };
}
exports.getStats = getStats;
function logStats() {
    const stats = getStats();
    console.log(`[${new Date().toISOString()}] 📊 Server Stats:`, {
        activeSessions: stats.activeSessions,
        activeConnections: stats.activeConnections,
        uptime: `${Math.floor(stats.uptime / 3600)}h ${Math.floor((stats.uptime % 3600) / 60)}m`,
        memoryUsage: `${Math.round(stats.memory.used / 1024 / 1024)}MB`
    });
}
function createSession(userId, chatId, username) {
    const sessionId = (0, uuid_1.v4)();
    sessions.set(sessionId, {
        sessionId,
        userId,
        chatId,
        username,
        status: 'created',
        createdAt: new Date(),
        connectedAt: null,
        walletConnectedAt: null,
        walletId: null,
        txnLink: null
    });
    console.log(`[${new Date().toISOString()}] 🆕 Created session ${sessionId} for user ${username} (${userId})`);
    return sessionId;
}
exports.createSession = createSession;
function getSession(sessionId) {
    return sessions.get(sessionId);
}
exports.getSession = getSession;
function getAllSessions() {
    return Array.from(sessions.values());
}
exports.getAllSessions = getAllSessions;
function startServer(port = 8080) {
    const server = http_1.default.createServer((req, res) => {
        if (req.url === '/health') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                status: 'healthy',
                uptime: process.uptime(),
                timestamp: new Date().toISOString(),
                activeSessions: sessions.size,
                activeConnections: connections.size
            }));
            return;
        }
        if (req.url === '/status') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(getStats()));
            return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            service: 'Text Royale WebSocket Server',
            status: 'running',
            version: '1.0.0'
        }));
    });
    const wss = new ws_1.WebSocketServer({
        server,
        verifyClient: (info) => {
            const origin = info.origin;
            console.log(`[${new Date().toISOString()}] WebSocket connection from origin: ${origin}`);
            return true;
        }
    });
    wss.on('connection', (ws, request) => {
        const clientIp = request.socket.remoteAddress;
        console.log(`[${new Date().toISOString()}] New WebSocket connection from ${clientIp}`);
        ws.on('message', (message) => {
            handleMessage(ws, message.toString());
        });
        ws.on('close', () => {
            console.log(`[${new Date().toISOString()}] WebSocket connection closed`);
            cleanupConnection(ws);
        });
        ws.on('error', (error) => {
            console.error(`[${new Date().toISOString()}] WebSocket error:`, error);
            cleanupConnection(ws);
        });
        sendMessage(ws, {
            type: 'connected',
            message: 'WebSocket connection established',
            timestamp: new Date().toISOString()
        });
    });
    server.listen(port, () => {
        console.log('='.repeat(60));
        console.log('🚀 Text Royale WebSocket Server Started');
        console.log('='.repeat(60));
        console.log(`📡 Port: ${port}`);
        console.log(`🌐 Health Check: http://localhost:${port}/health`);
        console.log(`📊 Status: http://localhost:${port}/status`);
        console.log(`🔗 WebSocket: ws://localhost:${port}`);
        console.log(`🕒 Started at: ${new Date().toISOString()}`);
        console.log('='.repeat(60));
    });
    setInterval(() => {
        cleanupExpiredSessions();
    }, 5 * 60 * 1000);
    setInterval(() => {
        logStats();
    }, 10 * 60 * 1000);
}
exports.startServer = startServer;
// Start the server
startServer(process.env.PORT ? parseInt(process.env.PORT) : 8080);
