// server.js - WebSocket сервер для облачных конфигов
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import crypto from 'crypto';
import fs from 'fs';

// Конфигурация
const PORT = process.env.PORT || 8080;
const CLOUD_API_SECRET = process.env.CLOUD_API_SECRET || "IuMR2uiNnClsz4oDC9tjgWT10BPbXb6pzKAGpNyXQWo";
const ADMIN_SECRET = process.env.ADMIN_SECRET || "SErcb4DkfdiKUIFyfheHxKpKSiEQ-ZDYQ0g0Y5yzoJ395fYRZpuqZA";

// In-memory storage (в реальном проекте используйте БД)
const configs = new Map(); // id -> config
const likes = new Map(); // config_id -> Set of usernames
const userConfigs = new Map(); // username -> Set of config ids

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

// Проверка админ прав
function verifyAdmin(token) {
    if (!token) return false;
    const cleaned = token.replace(/^Bearer\s+/i, '');
    return cleaned === ADMIN_SECRET;
}

// Получение username из заголовков
function getUsernameFromHeaders(headers) {
    return headers['x-cloud-nl-username'] || headers['x-curwe-nl-username'] || 'unknown';
}

// Получение публичных конфигов
function getPublicConfigs(username = null) {
    const result = [];
    for (const [id, config] of configs.entries()) {
        if (!config.is_private) {
            const enriched = enrichWithLikes(config, username);
            result.push(enriched);
        }
    }
    return result.sort((a, b) => (b.is_pinned ? 1 : 0) - (a.is_pinned ? 1 : 0));
}

// Получение конфигов пользователя
function getUserConfigs(username) {
    const result = [];
    for (const [id, config] of configs.entries()) {
        if (config.nl_username.toLowerCase() === username.toLowerCase()) {
            const enriched = enrichWithLikes(config, username);
            result.push(enriched);
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
        payload_b64: config.payload_b64
    };
}

// Поиск конфига по ID (только публичные)
function findPublicConfigById(id) {
    const config = configs.get(id);
    if (config && !config.is_private) {
        return { ...config };
    }
    return null;
}

// Поиск конфига с проверкой владельца
function findConfigWithOwnerCheck(id, username) {
    const config = configs.get(id);
    if (config && config.nl_username.toLowerCase() === username.toLowerCase()) {
        return { ...config };
    }
    return null;
}

// Установка метаданных
function setConfigMeta(username, id, isPinned = null, nameColor = null) {
    const config = configs.get(id);
    if (!config) return null;
    if (config.nl_username.toLowerCase() !== username.toLowerCase()) {
        throw new Error('forbidden');
    }
    if (isPinned !== null) config.is_pinned = isPinned;
    if (nameColor !== null) config.name_color = nameColor;
    config.updated_at = new Date().toISOString();
    configs.set(id, config);
    return { ...config };
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
            throw new Error('forbidden');
        } else {
            throw new Error('not_found');
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
        is_pinned: isUpdate ? configs.get(id).is_pinned : false,
        is_private: false,
        name_color: isUpdate ? configs.get(id).name_color : ''
    };
    
    configs.set(id, config);
    
    if (!isUpdate) {
        if (!userConfigs.has(username)) userConfigs.set(username, new Set());
        userConfigs.get(username).add(id);
    }
    
    return { ...config };
}

// Удаление конфига
function deleteConfig(username, id) {
    const config = configs.get(id);
    if (!config) return { error: 'not_found' };
    if (config.nl_username.toLowerCase() !== username.toLowerCase()) {
        return { error: 'forbidden' };
    }
    configs.delete(id);
    if (userConfigs.has(username)) {
        userConfigs.get(username).delete(id);
    }
    likes.delete(id);
    return { removed: true };
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

// Получение всех конфигов по создателям (админ)
function getAllByCreator() {
    const byCreator = new Map();
    for (const [id, config] of configs.entries()) {
        const creator = config.nl_username;
        if (!byCreator.has(creator)) byCreator.set(creator, []);
        byCreator.get(creator).push(enrichWithLikes(config));
    }
    return Object.fromEntries(byCreator);
}

// Получение карты лайков (админ)
function getLikesCountMap() {
    const map = {};
    for (const [id, likeSet] of likes.entries()) {
        map[id] = likeSet.size;
    }
    return map;
}

// Создание HTTP сервера
const server = createServer((req, res) => {
    // Health check для Render
    if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', timestamp: new Date().toISOString() }));
        return;
    }
    
    // Простой HTML интерфейс для проверки
    if (req.url === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>Cloud Configs WebSocket</title>
                <style>
                    body { font-family: monospace; padding: 20px; background: #1a1a2e; color: #eee; }
                    .status { color: #0f0; }
                    .error { color: #f00; }
                </style>
            </head>
            <body>
                <h1>☁️ Cloud Configs WebSocket Server</h1>
                <p>Status: <span class="status">● Running</span></p>
                <p>WebSocket endpoint: <code>ws://localhost:${PORT}</code></p>
                <p>Configs in memory: <strong id="count">0</strong></p>
                <script>
                    fetch('/health').then(r => r.json()).then(d => {
                        document.getElementById('count').textContent = d.configs_count || 0;
                    });
                </script>
            </body>
            </html>
        `);
        return;
    }
    
    res.writeHead(404);
    res.end();
});

// WebSocket сервер
const wss = new WebSocketServer({ server });

// Обработка сообщений
wss.on('connection', (ws, req) => {
    console.log(`[${new Date().toISOString()}] New client connected`);
    
    ws.on('message', async (data) => {
        let message;
        try {
            message = JSON.parse(data.toString());
        } catch (e) {
            ws.send(JSON.stringify({ error: 'Invalid JSON' }));
            return;
        }
        
        const { action, ...params } = message;
        
        // Получаем заголовки из URL query (если переданы)
        const url = new URL(req.url, `http://${req.headers.host}`);
        const authHeader = url.searchParams.get('authorization') || params.authorization;
        const usernameHeader = url.searchParams.get('username') || params.username;
        
        console.log(`[${new Date().toISOString()}] Action: ${action}, User: ${usernameHeader}`);
        
        // Валидация для всех запросов кроме админских
        const isAdminAction = action === 'admin_list' || action === 'admin_dump' || action === 'admin_set_meta';
        
        if (!isAdminAction && !verifyBearerToken(authHeader)) {
            ws.send(JSON.stringify({ ok: false, error: 'unauthorized' }));
            return;
        }
        
        if (isAdminAction && !verifyAdmin(authHeader)) {
            ws.send(JSON.stringify({ ok: false, error: 'admin_required' }));
            return;
        }
        
        const username = usernameHeader || 'unknown';
        
        try {
            let result;
            
            switch (action) {
                case 'list':
                    const mineOnly = params.mine_only === '1' || params.mine_only === true;
                    const configList = mineOnly ? getUserConfigs(username) : getPublicConfigs(username);
                    result = { ok: true, configs: configList };
                    break;
                    
                case 'load':
                    const { id: loadId } = params;
                    if (!loadId || !/^[a-f0-9]{32}$/.test(loadId)) {
                        result = { ok: false, error: 'invalid_id' };
                        break;
                    }
                    const loadedConfig = findPublicConfigById(loadId);
                    if (!loadedConfig) {
                        result = { ok: false, error: 'not_found' };
                        break;
                    }
                    result = { ok: true, ...loadedConfig };
                    break;
                    
                case 'save':
                    const { name, payload_b64, id: saveId } = params;
                    if (!name || name.trim() === '' || name.length > 128) {
                        result = { ok: false, error: 'invalid_name' };
                        break;
                    }
                    if (!payload_b64 || typeof payload_b64 !== 'string') {
                        result = { ok: false, error: 'invalid_payload_b64' };
                        break;
                    }
                    // Проверка base64
                    const base64Check = payload_b64.replace(/\s/g, '');
                    if (!/^[A-Za-z0-9+/=]+$/.test(base64Check)) {
                        result = { ok: false, error: 'invalid_base64' };
                        break;
                    }
                    try {
                        const saved = saveConfig(username, name.trim(), base64Check, saveId || null);
                        result = { ok: true, config: saved };
                    } catch (e) {
                        if (e.message === 'forbidden') {
                            result = { ok: false, error: 'forbidden' };
                        } else if (e.message === 'not_found') {
                            result = { ok: false, error: 'not_found' };
                        } else {
                            throw e;
                        }
                    }
                    break;
                    
                case 'delete':
                    const { id: deleteId } = params;
                    if (!deleteId || !/^[a-f0-9]{32}$/.test(deleteId)) {
                        result = { ok: false, error: 'invalid_id' };
                        break;
                    }
                    const deleteResult = deleteConfig(username, deleteId);
                    if (deleteResult.error) {
                        result = { ok: false, error: deleteResult.error };
                        if (deleteResult.error === 'forbidden') result = { ok: false, error: 'forbidden' };
                    } else {
                        result = { ok: true };
                    }
                    break;
                    
                case 'like':
                    const { id: likeId } = params;
                    if (!likeId || !/^[a-f0-9]{32}$/.test(likeId)) {
                        result = { ok: false, error: 'invalid_id' };
                        break;
                    }
                    const likeResult = toggleLike(likeId, username);
                    if (!likeResult.ok) {
                        result = { ok: false, error: likeResult.error };
                        if (likeResult.error === 'own_config') result = { ok: false, error: 'own_config' };
                    } else {
                        result = { ok: true, likes: likeResult.likes, liked: likeResult.liked };
                    }
                    break;
                    
                case 'meta':
                    const { id: metaId, is_pinned, name_color } = params;
                    if (!metaId || !/^[a-f0-9]{32}$/.test(metaId)) {
                        result = { ok: false, error: 'invalid_id' };
                        break;
                    }
                    try {
                        const metaResult = setConfigMeta(username, metaId, is_pinned, name_color);
                        if (!metaResult) {
                            result = { ok: false, error: 'not_found' };
                        } else {
                            result = { ok: true, config: metaResult };
                        }
                    } catch (e) {
                        if (e.message === 'forbidden') {
                            result = { ok: false, error: 'forbidden' };
                        } else {
                            throw e;
                        }
                    }
                    break;
                    
                case 'admin_list':
                    const publicList = getPublicConfigs();
                    const likesMap = getLikesCountMap();
                    const enrichedList = publicList.map(c => ({ ...c, likes: likesMap[c.id] || 0 }));
                    result = { ok: true, configs: enrichedList };
                    break;
                    
                case 'admin_dump':
                    const byCreator = getAllByCreator();
                    result = { ok: true, by_creator: byCreator };
                    break;
                    
                case 'admin_set_meta':
                    const { id: adminMetaId, is_pinned: adminIsPinned, name_color: adminNameColor } = params;
                    if (!adminMetaId || !/^[a-f0-9]{32}$/.test(adminMetaId)) {
                        result = { ok: false, error: 'invalid_id' };
                        break;
                    }
                    const config = configs.get(adminMetaId);
                    if (!config) {
                        result = { ok: false, error: 'not_found' };
                        break;
                    }
                    if (adminIsPinned !== undefined) config.is_pinned = adminIsPinned;
                    if (adminNameColor !== undefined) config.name_color = adminNameColor;
                    configs.set(adminMetaId, config);
                    result = { ok: true, config: { ...config } };
                    break;
                    
                default:
                    result = { ok: false, error: 'unknown_action' };
            }
            
            ws.send(JSON.stringify(result));
            
        } catch (error) {
            console.error(`Error processing action ${action}:`, error);
            ws.send(JSON.stringify({ ok: false, error: 'server_error' }));
        }
    });
    
    ws.on('close', () => {
        console.log(`[${new Date().toISOString()}] Client disconnected`);
    });
    
    ws.on('error', (error) => {
        console.error('WebSocket error:', error);
    });
});

// Сохранение данных при завершении (опционально)
function saveToFile() {
    const data = {
        configs: Array.from(configs.entries()),
        likes: Array.from(likes.entries()).map(([id, set]) => [id, Array.from(set)]),
        userConfigs: Array.from(userConfigs.entries()).map(([user, set]) => [user, Array.from(set)])
    };
    fs.writeFileSync('backup.json', JSON.stringify(data, null, 2));
    console.log('Data saved to backup.json');
}

function loadFromFile() {
    try {
        if (fs.existsSync('backup.json')) {
            const data = JSON.parse(fs.readFileSync('backup.json', 'utf8'));
            configs.clear();
            likes.clear();
            userConfigs.clear();
            
            for (const [id, config] of data.configs) {
                configs.set(id, config);
            }
            for (const [id, usernames] of data.likes) {
                likes.set(id, new Set(usernames));
            }
            for (const [user, ids] of data.userConfigs) {
                userConfigs.set(user, new Set(ids));
            }
            console.log('Data loaded from backup.json');
        }
    } catch (e) {
        console.log('No backup file found, starting fresh');
    }
}

// Graceful shutdown
process.on('SIGINT', () => {
    saveToFile();
    process.exit();
});

// Загрузка данных при старте
loadFromFile();

// Запуск сервера
server.listen(PORT, () => {
    console.log(`[${new Date().toISOString()}] WebSocket server running on port ${PORT}`);
    console.log(`Health check: http://localhost:${PORT}/health`);
    console.log(`WebSocket endpoint: ws://localhost:${PORT}`);
});

// Периодическое сохранение (каждые 5 минут)
setInterval(saveToFile, 5 * 60 * 1000);