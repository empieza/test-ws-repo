import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import crypto from 'crypto';

const PORT = process.env.PORT || 8080;
const CLOUD_API_SECRET = process.env.CLOUD_API_SECRET || "IuMR2uiNClsz4oDC9tjgWT10BPbXb6pzKAGpNyXQWo";

// In-memory storage
const configs = new Map();
const likes = new Map(); // config_id -> Set of usernames

// Генерация ID (32 символа hex)
function generateId() {
    return crypto.randomBytes(16).toString('hex');
}

// Валидация Bearer токена
function verifyBearerToken(token) {
    if (!token) return false;
    const cleaned = token.replace(/^Bearer\s+/i, '');
    return cleaned === CLOUD_API_SECRET;
}

// Получение публичных конфигов
function getPublicConfigs(username = null) {
    const result = [];
    for (const [id, config] of configs.entries()) {
        result.push(enrichWithLikes(config, username));
    }
    return result.sort((a, b) => (b.is_pinned ? 1 : 0) - (a.is_pinned ? 1 : 0));
}

// Получение конфигов пользователя
function getUserConfigs(username) {
    const result = [];
    for (const [id, config] of configs.entries()) {
        if (config.nl_username.toLowerCase() === username.toLowerCase()) {
            result.push(enrichWithLikes(config, username));
        }
    }
    return result;
}

// Обогащение информацией о лайках
function enrichWithLikes(config, username) {
    const likeSet = likes.get(config.id) || new Set();
    return {
        ...config,
        likes: likeSet.size,
        liked: username ? likeSet.has(username.toLowerCase()) : false,
    };
}

// Поиск конфига по ID (только публичные)
function findPublicConfigById(id) {
    const config = configs.get(id);
    if (config) {
        const { payload_b64, ...rest } = config;
        return { ...rest, payload_b64 };
    }
    return null;
}

// Сохранение конфига
function saveConfig(username, name, payloadB64, existingId = null) {
    let id = existingId;
    let isUpdate = false;
    
    if (id) {
        const existing = configs.get(id);
        if (existing && existing.nl_username.toLowerCase() === username.toLowerCase()) {
            isUpdate = true;
        } else if (existing) {
            return { error: 'forbidden' };
        } else {
            return { error: 'not_found' };
        }
    }
    
    if (!id) {
        id = generateId();
    }
    
    const now = new Date().toISOString();
    const config = {
        id,
        name,
        payload_b64: payloadB64,
        nl_username: username,
        created_at: isUpdate ? configs.get(id).created_at : now,
        updated_at: now,
        is_pinned: isUpdate ? (configs.get(id).is_pinned || false) : false,
        name_color: isUpdate ? (configs.get(id).name_color || '') : ''
    };
    
    configs.set(id, config);
    
    return { config: { ...config } };
}

// Удаление конфига
function deleteConfig(username, id) {
    const config = configs.get(id);
    if (!config) return { error: 'not_found' };
    if (config.nl_username.toLowerCase() !== username.toLowerCase()) {
        return { error: 'forbidden' };
    }
    configs.delete(id);
    likes.delete(id);
    return { ok: true };
}

// Toggle like
function toggleLike(id, username) {
    const config = configs.get(id);
    if (!config) return { ok: false, error: 'not_found' };
    if (config.nl_username.toLowerCase() === username.toLowerCase()) {
        return { ok: false, error: 'own_config' };
    }
    
    if (!likes.has(id)) likes.set(id, new Set());
    const likeSet = likes.get(id);
    const liked = likeSet.has(username.toLowerCase());
    
    if (liked) {
        likeSet.delete(username.toLowerCase());
    } else {
        likeSet.add(username.toLowerCase());
    }
    
    return {
        ok: true,
        likes: likeSet.size,
        liked: !liked
    };
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
            configs_count: configs.size
        }));
        return;
    }
    
    res.writeHead(404);
    res.end();
});

// WebSocket сервер
const wss = new WebSocketServer({ server });

wss.on('connection', (ws, req) => {
    console.log(`[${new Date().toISOString()}] Client connected`);
    
    ws.on('message', (data) => {
        try {
            const message = JSON.parse(data.toString());
            console.log(`[${new Date().toISOString()}] Received action:`, message.action);
            
            // Пропускаем пинги
            if (message.action === 'ping') {
                ws.send(JSON.stringify({ type: 'pong', request_id: message.request_id }));
                return;
            }
            
            // Проверка авторизации для всех запросов кроме пинга
            if (!verifyBearerToken(message.authorization)) {
                ws.send(JSON.stringify({ 
                    request_id: message.request_id, 
                    ok: false, 
                    error: 'unauthorized' 
                }));
                return;
            }
            
            const username = message.username || 'unknown';
            let response = { request_id: message.request_id, ok: false };
            
            switch (message.action) {
                case 'list':
                    const onlyMine = message.mine_only === true || message.mine_only === 'true';
                    const configsList = onlyMine ? getUserConfigs(username) : getPublicConfigs(username);
                    response = {
                        request_id: message.request_id,
                        ok: true,
                        configs: configsList
                    };
                    break;
                    
                case 'load':
                    const loadId = message.id;
                    if (!loadId) {
                        response.error = 'invalid_id';
                    } else {
                        const config = findPublicConfigById(loadId);
                        if (!config) {
                            response.error = 'not_found';
                        } else {
                            response = {
                                request_id: message.request_id,
                                ok: true,
                                ...config
                            };
                        }
                    }
                    break;
                    
                case 'save':
                    const { name, payload_b64, id: saveId } = message;
                    if (!name || name.trim() === '') {
                        response.error = 'invalid_name';
                    } else if (!payload_b64) {
                        response.error = 'invalid_payload_b64';
                    } else {
                        const result = saveConfig(username, name.trim(), payload_b64, saveId);
                        if (result.error) {
                            response.error = result.error;
                        } else {
                            response = {
                                request_id: message.request_id,
                                ok: true,
                                config: result.config
                            };
                        }
                    }
                    break;
                    
                case 'delete':
                    const deleteId = message.id;
                    if (!deleteId) {
                        response.error = 'invalid_id';
                    } else {
                        const result = deleteConfig(username, deleteId);
                        if (result.error) {
                            response.error = result.error;
                        } else {
                            response = {
                                request_id: message.request_id,
                                ok: true
                            };
                        }
                    }
                    break;
                    
                case 'like':
                    const likeId = message.id;
                    if (!likeId) {
                        response.error = 'invalid_id';
                    } else {
                        const result = toggleLike(likeId, username);
                        if (!result.ok) {
                            response.error = result.error;
                        } else {
                            response = {
                                request_id: message.request_id,
                                ok: true,
                                likes: result.likes,
                                liked: result.liked
                            };
                        }
                    }
                    break;
                    
                default:
                    response.error = 'unknown_action';
            }
            
            console.log(`[${new Date().toISOString()}] Sending response for ${message.action}:`, response.ok);
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
        console.error('WebSocket error:', error);
    });
    
    // Приветственное сообщение
    ws.send(JSON.stringify({ 
        type: 'welcome', 
        message: 'Connected to Cloud Configs Server',
        timestamp: Date.now()
    }));
});

server.listen(PORT, () => {
    console.log(`[${new Date().toISOString()}] Server running on port ${PORT}`);
    console.log(`Health check: http://localhost:${PORT}/health`);
    console.log(`WebSocket endpoint: ws://localhost:${PORT}`);
});
