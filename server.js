import { WebSocketServer } from 'ws';
import { createServer } from 'http';

const PORT = process.env.PORT || 8080;
const CLOUD_API_SECRET = "IuMR2uiNClsz4oDC9tjgWT10BPbXb6pzKAGpNyXQWo";

// In-memory storage
const configs = new Map();

// HTTP сервер
const server = createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok' }));
        return;
    }
    res.writeHead(404);
    res.end();
});

// WebSocket сервер
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
    console.log('Client connected');
    
    ws.on('message', (data) => {
        try {
            const msg = JSON.parse(data.toString());
            console.log('Received:', msg.action);
            
            // Проверка токена
            if (msg.token !== CLOUD_API_SECRET) {
                ws.send(JSON.stringify({ 
                    request_id: msg.request_id, 
                    ok: false, 
                    error: 'unauthorized' 
                }));
                return;
            }
            
            let response = { request_id: msg.request_id, ok: true };
            
            switch (msg.action) {
                case 'list':
                    response.configs = [];
                    for (const [id, config] of configs) {
                        response.configs.push({
                            id: id,
                            name: config.name,
                            nl_username: config.nl_username,
                            likes: 0,
                            liked: false
                        });
                    }
                    break;
                    
                case 'save':
                    const id = msg.id || Math.random().toString(36).substring(2, 10);
                    configs.set(id, {
                        id: id,
                        name: msg.name,
                        payload_b64: msg.payload_b64,
                        nl_username: msg.username,
                        created_at: new Date().toISOString()
                    });
                    response.config = configs.get(id);
                    break;
                    
                case 'load':
                    const loadId = msg.id;
                    const config = configs.get(loadId);
                    if (config) {
                        response.payload_b64 = config.payload_b64;
                        response.name = config.name;
                    } else {
                        response.ok = false;
                        response.error = 'not_found';
                    }
                    break;
                    
                default:
                    response.ok = false;
                    response.error = 'unknown_action';
            }
            
            ws.send(JSON.stringify(response));
            
        } catch (e) {
            console.error('Error:', e);
            ws.send(JSON.stringify({ ok: false, error: 'invalid_json' }));
        }
    });
    
    ws.on('close', () => console.log('Client disconnected'));
    
    ws.send(JSON.stringify({ type: 'welcome', message: 'Connected!' }));
});

server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
