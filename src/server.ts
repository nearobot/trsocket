import { WebSocketServer, WebSocket as WSWebSocket, VerifyClientCallbackSync } from 'ws';
import http from 'http';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';

// Interfaces
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
  // Transaction data prepared by bot
  transactionData?: {
    amount: string;
    receiver: string;
    purpose?: string;
    metadata?: any;
  };
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

// Global stores
const sessions = new Map<string, Session>();
const connections = new Map<string, WSWebSocket>();
const events: Record<string, Function[]> = {};
const botConnections = new Set<WSWebSocket>(); // Track bot connections

// Event system
function on(event: string, callback: (data: any) => void): void {
  if (!events[event]) events[event] = [];
  events[event].push(callback);
}

function emit(event: string, data: any): void {
  events[event]?.forEach(callback => {
    try {
      callback(data);
    } catch (error) {
      console.error(`Event callback error for ${event}:`, error);
    }
  });
}

// Send message to bot connections
function sendToBot(message: Message): void {
  botConnections.forEach(ws => {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify(message));
    }
  });
}

// Message handling
function sendMessage(ws: WSWebSocket, message: Message): void {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(message));
  }
}

function handleMessage(ws: WSWebSocket, message: string): void {
  try {
    const data = JSON.parse(message);
    console.log(`[${new Date().toISOString()}] Received:`, {
      type: data.type,
      sessionId: data.sessionId || 'none',
      from: (ws as any).isBot ? 'BOT' : 'CLIENT'
    });

    switch (data.type) {
      case 'bot_connect':
        handleBotConnect(ws, data);
        break;
      case 'create_session':
        handleCreateSession(ws, data);
        break;
      case 'init_session':
        handleInitSession(ws, data);
        break;
      case 'wallet_connected':
        handleWalletConnected(ws, data);
        break;
      case 'process_transaction':
        handleProcessTransaction(ws, data);
        break;
      case 'transaction_result':
        handleTransactionResult(ws, data);
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
    console.error(`Message parsing error:`, error);
    sendMessage(ws, {
      type: 'error',
      message: 'Invalid message format',
      timestamp: new Date().toISOString()
    });
  }
}

// Handle bot connection
function handleBotConnect(ws: WSWebSocket, data: any): void {
  (ws as any).isBot = true;
  botConnections.add(ws);
  console.log(`🤖 Bot connected. Total bot connections: ${botConnections.size}`);
  
  sendMessage(ws, {
    type: 'bot_connected',
    message: 'Bot connection established',
    timestamp: new Date().toISOString()
  });
}

// Handle session creation from bot
function handleCreateSession(ws: WSWebSocket, data: any): void {
  const { sessionId, userId, chatId, username, transactionData } = data;
  
  if (!sessionId || !userId || !chatId || !username) {
    sendMessage(ws, {
      type: 'error',
      message: 'Missing required session data (sessionId, userId, chatId, username)',
      timestamp: new Date().toISOString()
    });
    return;
  }

  // Validate transaction data if provided
  if (transactionData) {
    if (!transactionData.amount || !transactionData.receiver) {
      sendMessage(ws, {
        type: 'error',
        message: 'Transaction data must include amount and receiver',
        timestamp: new Date().toISOString()
      });
      return;
    }
  }

  // Create session with transaction data
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
    txnLink: null,
    transactionData: transactionData || undefined
  });

  console.log(`🆕 Session created by bot: ${sessionId} for ${username} (${userId})`);
  if (transactionData) {
    console.log(`💰 Transaction data included: ${transactionData.amount} to ${transactionData.receiver}`);
  }
  
  sendMessage(ws, {
    type: 'session_created',
    sessionId,
    hasTransactionData: !!transactionData,
    timestamp: new Date().toISOString()
  });
}

// Session management
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

  console.log(`[${new Date().toISOString()}] ✅ Session ${sessionId} initialized for user ${session.username}`);
  if (session.transactionData) {
    console.log(`💰 Transaction data available: ${session.transactionData.amount} to ${session.transactionData.receiver}`);
  }

  sendMessage(ws, {
    type: 'session_initialized',
    userId: session.userId,
    username: session.username,
    sessionId: sessionId,
    transactionData: session.transactionData || null,
    timestamp: new Date().toISOString()
  });
}

function handleWalletConnected(ws: WSWebSocket, data: any): void {
  const { sessionId, walletId, txnLink } = data;
  
  if (!sessionId || !walletId) {
    sendMessage(ws, {
      type: 'error',
      message: 'Session ID and wallet ID required',
      timestamp: new Date().toISOString()
    });
    return;
  }

  const session = sessions.get(sessionId);
  if (!session) {
    sendMessage(ws, {
      type: 'error',
      message: 'Invalid session',
      timestamp: new Date().toISOString()
    });
    return;
  }

  session.walletId = walletId;
  session.txnLink = txnLink || '';
  session.status = 'wallet_connected';
  session.walletConnectedAt = new Date();

  console.log(`💰 Wallet ${walletId} connected for session ${sessionId}`);

  // Send to bot via WebSocket
  const walletData = {
    type: 'wallet_connected',
    userId: session.userId,
    chatId: session.chatId,
    username: session.username,
    walletId,
    txnLink: txnLink || '',
    sessionId,
    timestamp: new Date().toISOString()
  };

  sendToBot(walletData);

  // Send confirmation to frontend
  sendMessage(ws, {
    type: 'wallet_connection_received',
    message: 'Wallet connected successfully!',
    timestamp: new Date().toISOString()
  });
}

// Handle transaction processing request from bot
function handleProcessTransaction(ws: WSWebSocket, data: any): void {
  const { sessionId, transactionData, transactionId } = data;
  
  if (!sessionId || !transactionData) {
    sendMessage(ws, {
      type: 'error',
      message: 'Session ID and transaction data are required',
      timestamp: new Date().toISOString()
    });
    return;
  }

  const session = sessions.get(sessionId);
  if (!session || session.status !== 'wallet_connected') {
    sendMessage(ws, {
      type: 'error',
      message: 'Invalid session or wallet not connected',
      timestamp: new Date().toISOString()
    });
    return;
  }

  // Get the frontend connection
  const frontendWs = connections.get(sessionId);
  if (!frontendWs) {
    sendMessage(ws, {
      type: 'error',
      message: 'Frontend not connected',
      timestamp: new Date().toISOString()
    });
    return;
  }

  const txnId = transactionId || uuidv4();
  
  console.log(`💳 Sending transaction ${txnId} to frontend for session ${sessionId}`);

  // Send transaction to frontend for processing
  sendMessage(frontendWs, {
    type: 'process_transaction',
    transactionId: txnId,
    transactionData,
    timestamp: new Date().toISOString()
  });

  // Confirm to bot that transaction was sent to frontend
  sendMessage(ws, {
    type: 'transaction_sent',
    transactionId: txnId,
    message: 'Transaction sent to frontend for processing',
    timestamp: new Date().toISOString()
  });
}

// Handle transaction result from frontend
function handleTransactionResult(ws: WSWebSocket, data: any): void {
  const { transactionId, success, signature, txHash, error, sessionId } = data;
  
  if (!transactionId || success === undefined) {
    sendMessage(ws, {
      type: 'error',
      message: 'Transaction ID and success status are required',
      timestamp: new Date().toISOString()
    });
    return;
  }

  const session = sessions.get(sessionId);
  if (!session) {
    sendMessage(ws, {
      type: 'error',
      message: 'Invalid session',
      timestamp: new Date().toISOString()
    });
    return;
  }

  console.log(`${success ? '✅' : '❌'} Transaction ${transactionId} ${success ? 'completed' : 'failed'} for session ${sessionId}`);

  // Send result to bot
  const resultData = {
    type: 'transaction_completed',
    transactionId,
    success,
    userId: session.userId,
    chatId: session.chatId,
    username: session.username,
    walletId: session.walletId,
    sessionId,
    timestamp: new Date().toISOString(),
    ...(success && signature && { signature }),
    ...(success && txHash && { txHash }),
    ...(error && { error })
  };

  sendToBot(resultData);

  // Confirm to frontend
  sendMessage(ws, {
    type: 'transaction_result_received',
    transactionId,
    message: 'Transaction result sent to bot',
    timestamp: new Date().toISOString()
  });
}

// Cleanup functions
function cleanupConnection(ws: WSWebSocket): void {
  const sessionId = (ws as any).sessionId;
  const isBot = (ws as any).isBot;
  
  if (sessionId) {
    connections.delete(sessionId);
    console.log(`🧹 Cleaned up connection for session ${sessionId}`);
  }
  
  if (isBot) {
    botConnections.delete(ws);
    console.log(`🤖 Bot disconnected. Remaining bot connections: ${botConnections.size}`);
  }
}

function cleanupExpiredSessions(): void {
  const now = new Date();
  const expiredSessions: string[] = [];

  sessions.forEach((session, sessionId) => {
    if (now.getTime() - session.createdAt.getTime() > 60 * 60 * 1000) {
      expiredSessions.push(sessionId);
    }
  });

  expiredSessions.forEach(sessionId => {
    sessions.delete(sessionId);
    connections.delete(sessionId);
    console.log(`🗑️ Cleaned up expired session: ${sessionId}`);
  });

  if (expiredSessions.length > 0) {
    console.log(`📊 Cleaned up ${expiredSessions.length} expired sessions`);
  }
}

// Utility functions
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
  console.log(`📊 Server Stats:`, {
    sessions: stats.activeSessions,
    connections: stats.activeConnections,
    botConnections: botConnections.size,
    uptime: `${Math.floor(stats.uptime / 3600)}h ${Math.floor((stats.uptime % 3600) / 60)}m`,
    memory: `${Math.round(stats.memory.used / 1024 / 1024)}MB`
  });
}

// Public API
function createSessionAPI(userId: string, chatId: string, username: string): string {
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

  console.log(`🆕 Created session ${sessionId} for ${username}`);
  return sessionId;
}

function getSession(sessionId: string): Session | undefined {
  return sessions.get(sessionId);
}

function getAllSessions(): Session[] {
  return Array.from(sessions.values());
}

// Server startup
function startServer(port: number = 3001): void {
  const server = http.createServer((req, res) => {
    // Enable CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(200);
      res.end();
      return;
    }

    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'healthy',
        ...getStats()
      }));
      return;
    }

    if (req.url === '/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(getStats()));
      return;
    }

    // Get transaction data for a specific session
    if (req.url?.startsWith('/session/') && req.url.includes('/transaction')) {
      const sessionId = req.url.split('/')[2];
      if (sessionId) {
        const session = sessions.get(sessionId);
        if (session && session.transactionData) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            sessionId,
            transactionData: session.transactionData,
            status: session.status,
            timestamp: new Date().toISOString()
          }));
          return;
        } else {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            error: 'Session not found or no transaction data',
            timestamp: new Date().toISOString()
          }));
          return;
        }
      }
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      service: 'Text Royale WebSocket Server',
      status: 'running',
      version: '1.0.0',
      activeSessions: sessions.size,
      botConnections: botConnections.size
    }));
  });

  const wss = new WebSocketServer({ 
    server,
    verifyClient: (info: Parameters<VerifyClientCallbackSync>[0]) => {
      console.log(`[${new Date().toISOString()}] New connection from ${info.origin || 'unknown'}`);
      return true; // Add authentication logic here if needed
    }
  });

  wss.on('connection', (ws, req) => {
    const clientIp = req.socket.remoteAddress;
    console.log(`[${new Date().toISOString()}] New WebSocket connection from ${clientIp}`);
    
    ws.on('message', (message) => {
      handleMessage(ws, message.toString());
    });

    ws.on('close', (code, reason) => {
      console.log(`[${new Date().toISOString()}] Connection closed: ${code} ${reason}`);
      cleanupConnection(ws);
    });

    ws.on('error', (error) => {
      console.error(`[${new Date().toISOString()}] WebSocket error:`, error);
      cleanupConnection(ws);
    });

    // Send welcome message
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
    console.log(`📡 Internal Port: ${port}`);
    console.log(`🌐 Health: http://localhost:${port}/health`);
    console.log(`📊 Status: http://localhost:${port}/status`);
    console.log(`💳 Session Transaction: http://localhost:${port}/session/{sessionId}/transaction`);
    console.log(`🔗 WebSocket: ws://localhost:${port}`);
    console.log(`🔒 Public WSS: wss://ws.textroyale.com/`);
    console.log(`🕒 Started: ${new Date().toISOString()}`);
    console.log('='.repeat(60));
  });

  // Cleanup every 5 minutes
  setInterval(cleanupExpiredSessions, 5 * 60 * 1000);
  
  // Log stats every 10 minutes
  setInterval(logStats, 10 * 60 * 1000);
}

// Start server
startServer(process.env.PORT ? parseInt(process.env.PORT) : 3001);

// Export public API
export {
  on,
  emit,
  createSessionAPI as createSession,
  getSession,
  getAllSessions,
  getStats,
  startServer
}; 