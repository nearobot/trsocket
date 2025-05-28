import { WebSocketServer, WebSocket as WSWebSocket, VerifyClientCallbackSync } from 'ws';
import http from 'http';
import { v4 as uuidv4 } from 'uuid';

interface Session {
  sessionId: string;
  userId: string;
  chatId: string;
  username: string;
  status: 'created' | 'connected' | 'wallet_connected';
  createdAt: Date;
  connectedAt: Date | null;
  walletConnectedAt: Date | null;
  walletId: string | null;
  txnLink: string | null;
}

interface ServerStats {
  activeSessions: number;
  activeConnections: number;
  uptime: number;
  memory: {
    used: number;
    total: number;
    external: number;
  };
  timestamp: string;
  nodeVersion: string;
  platform: string;
}

interface Message {
  type: string;
  [key: string]: any;
}

const sessions = new Map<string, Session>();
const connections = new Map<string, WSWebSocket>();
const events: Record<string, Function[]> = {};

function on(event: string, callback: (data: any) => void): void {
  if (!events[event]) {
    events[event] = [];
  }
  events[event].push(callback);
}

function emit(event: string, data: any): void {
  if (events[event]) {
    events[event].forEach(callback => {
      try {
        callback(data);
      } catch (error) {
        console.error(`Error in event callback for ${event}:`, error);
      }
    });
  }
}

function sendMessage(ws: WSWebSocket, message: Message): void {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(message));
  }
}

function handleMessage(ws: WSWebSocket, message: string): void {
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
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Error parsing message:`, error);
    sendMessage(ws, {
      type: 'error',
      message: 'Invalid message format',
      timestamp: new Date().toISOString()
    });
  }
}

function handleInitSession(ws: WSWebSocket, data: any): void {
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
  (ws as any).sessionId = sessionId;

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

function handleWalletConnected(ws: WSWebSocket, data: any): void {
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

function cleanupConnection(ws: WSWebSocket): void {
  const sessionId = (ws as any).sessionId;
  if (sessionId) {
    connections.delete(sessionId);
    console.log(`[${new Date().toISOString()}] 🧹 Cleaned up connection for session ${sessionId}`);
  }
}

function cleanupExpiredSessions(): void {
  const now = new Date();
  const expiredSessions: string[] = [];

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

function getStats(): ServerStats {
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

function logStats(): void {
  const stats = getStats();
  console.log(`[${new Date().toISOString()}] 📊 Server Stats:`, {
    activeSessions: stats.activeSessions,
    activeConnections: stats.activeConnections,
    uptime: `${Math.floor(stats.uptime / 3600)}h ${Math.floor((stats.uptime % 3600) / 60)}m`,
    memoryUsage: `${Math.round(stats.memory.used / 1024 / 1024)}MB`
  });
}

function createSession(userId: string, chatId: string, username: string): string {
  const sessionId = uuidv4();
  
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

function getSession(sessionId: string): Session | undefined {
  return sessions.get(sessionId);
}

function getAllSessions(): Session[] {
  return Array.from(sessions.values());
}

function startServer(port: number = 8080): void {
  const server = http.createServer((req, res) => {
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

  const wss = new WebSocketServer({ 
    server,
    verifyClient: (info: Parameters<VerifyClientCallbackSync>[0]) => {
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

// Start the server
startServer(process.env.PORT ? parseInt(process.env.PORT) : 8080);

// Export for testing or module use
export {
  on,
  emit,
  createSession,
  getSession,
  getAllSessions,
  getStats,
  startServer
};