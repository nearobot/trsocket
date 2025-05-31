"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.walletWebSocketClient = void 0;
const ws_1 = require("ws");
const crypto_1 = require("crypto");
class WalletWebSocketClient {
    constructor(serverUrl) {
        this.sessions = new Map();
        this.userToSession = new Map();
        // Event emitter functionality
        this.eventCallbacks = new Map();
        this.serverUrl = serverUrl;
        this.ws = new ws_1.WebSocket(this.serverUrl);
        this.setupWebSocketClient();
        console.log(`WebSocket client connected to ${serverUrl}`);
    }
    setupWebSocketClient() {
        this.ws.on('open', () => {
            console.log('Connected to WebSocket server');
        });
        this.ws.on('message', (data) => {
            try {
                const message = JSON.parse(data.toString());
                this.handleMessage(message);
            }
            catch (error) {
                console.error('Error parsing WebSocket message:', error);
            }
        });
        this.ws.on('close', () => {
            console.log('Disconnected from WebSocket server');
            this.cleanupAllSessions();
        });
        this.ws.on('error', (error) => {
            console.error('WebSocket error:', error);
        });
    }
    handleMessage(message) {
        switch (message.type) {
            case 'init_session':
                this.initializeSession(message);
                break;
            case 'wallet_connected':
                this.handleWalletConnection(message);
                break;
            case 'ping':
                this.ws.send(JSON.stringify({ type: 'pong' }));
                break;
            default:
                console.log('Unknown message type', message);
        }
    }
    initializeSession(message) {
        const { sessionId } = message;
        const session = this.sessions.get(sessionId);
        if (!session) {
            this.ws.send(JSON.stringify({ type: 'error', message: 'Invalid session ID' }));
            return;
        }
        // Update session with WebSocket connection (this is for internal tracking)
        session.websocket = this.ws;
        session.connected = true;
        this.sessions.set(sessionId, session);
        this.ws.send(JSON.stringify({
            type: 'session_initialized',
            userId: session.userId,
            username: session.username,
        }));
        console.log(`Session ${sessionId} initialized for user ${session.username}`);
    }
    handleWalletConnection(message) {
        const { sessionId, walletId, txnLink } = message;
        const session = this.sessions.get(sessionId);
        if (!session) {
            this.ws.send(JSON.stringify({ type: 'error', message: 'Invalid session' }));
            return;
        }
        // Emit wallet connection event (you could modify this if you need specific handling)
        this.emit('wallet_connected', {
            userId: session.userId,
            chatId: session.chatId,
            username: session.username,
            walletId,
            txnLink,
            sessionId,
        });
        this.ws.send(JSON.stringify({
            type: 'wallet_connection_received',
            message: 'Wallet connection data sent',
        }));
    }
    cleanupAllSessions() {
        console.log('Cleaning up all sessions');
        this.sessions.clear();
        this.userToSession.clear();
    }
    // Method to create a new session when a user clicks /connect
    createSession(userId, chatId, username) {
        const sessionId = (0, crypto_1.randomUUID)();
        // Remove any existing session for this user
        const existingSessionId = this.userToSession.get(userId);
        if (existingSessionId) {
            this.sessions.delete(existingSessionId);
        }
        const session = {
            userId,
            chatId,
            username,
            sessionId,
            connected: false,
            timestamp: Date.now(),
        };
        this.sessions.set(sessionId, session);
        this.userToSession.set(userId, sessionId);
        console.log(`Created session ${sessionId} for user ${username} (${userId})`);
        return sessionId;
    }
    on(event, callback) {
        if (!this.eventCallbacks.has(event)) {
            this.eventCallbacks.set(event, []);
        }
        this.eventCallbacks.get(event).push(callback);
    }
    emit(event, data) {
        const callbacks = this.eventCallbacks.get(event);
        if (callbacks) {
            callbacks.forEach(callback => callback(data));
        }
    }
}
// Create singleton instance and connect to the WebSocket server
exports.walletWebSocketClient = new WalletWebSocketClient('wss://ws.textroyale.com');
// Cleanup old sessions every 30 minutes
setInterval(() => {
    exports.walletWebSocketClient.cleanupAllSessions();
}, 30 * 60 * 1000);
exports.default = exports.walletWebSocketClient;
