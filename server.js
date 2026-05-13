import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import crypto from 'crypto';

const PORT = process.env.PORT || 8080;
const CLOUD_API_SECRET = process.env.CLOUD_API_SECRET || "IuMR2uiNClsz4oDC9tjgWT10BPbXb6pzKAGpNyXQWo";

// In-memory storage
const configs = new Map();
const likes = new Map();

// Генерация ID
function generateId() {
    return crypto.randomBytes(16).toString('hex');
}

// HTTP сервер для health check
const server = createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    
    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }
    
    if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ 
            status: 'ok', 
            timestamp: new Date().toISOString(),
            websocket: true,
            configs_count: configs.size
        }));
        return;
    }
    
    res.writeHead(404);
    res.end();
});

// WebSocket сервер
const wss = new WebSocketServer({ 
    server,
    path: '/ws' // WebSocket на пути /ws
});

console.log(`WebSocket server created on path /ws`);

wss.on('connection', (ws, req) => {
    console.log(`[${new Date().toISOString()}] Client connected from ${req.socket.remoteAddress}`);
    
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    
    ws.on('message', (data) => {
        try {
            const message = JSON.parse(data.toString());
            console.log(`[${new Date().toISOString()}] Received:`, message.action || message.type);
            
            // Обработка разных типов сообщений
            if (message.type === 'ping') {
                ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
                return;
            }
            
            // Обработка API запросов
            const { request_id, action, ...params } = message;
            
            // Простая эхо-ответ для теста
            const response = {
                request_id: request_id,
                ok: true,
                echo: true,
                message: "Server is working",
                timestamp: Date.now()
            };
            
            ws.send(JSON.stringify(response));
            
        } catch (e) {
            console.error('Parse error:', e);
            ws.send(JSON.stringify({ ok: false, error: 'Invalid JSON' }));
        }
    });
    
    ws.on('close', () => {
        console.log(`[${new Date().toISOString()}] Client disconnected`);
    });
    
    ws.on('error', (error) => {
        console.error(`WebSocket error:`, error);
    });
    
    // Приветственное сообщение
    ws.send(JSON.stringify({ 
        type: 'welcome', 
        message: 'Connected to Cloud Configs Server',
        timestamp: Date.now()
    }));
});

// Ping интервал для поддержания соединений
const interval = setInterval(() => {
    wss.clients.forEach((ws) => {
        if (ws.isAlive === false) {
            return ws.terminate();
        }
        ws.isAlive = false;
        ws.ping();
    });
}, 30000);

wss.on('close', () => {
    clearInterval(interval);
});

server.listen(PORT, () => {
    console.log(`[${new Date().toISOString()}] HTTP server running on port ${PORT}`);
    console.log(`Health check: https://test-ws-repo.onrender.com/health`);
    console.log(`WebSocket endpoint: wss://test-ws-repo.onrender.com/ws`);
});
