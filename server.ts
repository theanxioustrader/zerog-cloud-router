import * as http from 'http';
import { WebSocketServer, WebSocket } from 'ws';

const PORT = process.env.PORT || 8080;

const server = http.createServer((req, res) => {
    // Healthcheck endpoint for Fly.io
    if (req.url === '/health' || req.url === '/') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ 
            status: 'online', 
            mobile_connections: mobileClients.size,
            host_connections: hostClients.size
        }));
        return;
    }
    
    res.writeHead(404);
    res.end('Not Found');
});

// Create a single WebSocket server overriding the default HTTP upgrade
const wss = new WebSocketServer({ noServer: true });

// Core State Maps tracking connected users by their secret pairing token
const mobileClients = new Map<string, WebSocket>();
const hostClients = new Map<string, WebSocket>();

// Upgrade interceptor: reads the ?token= querystring to map users together
server.on('upgrade', (request, socket, head) => {
    try {
        const urlObj = new URL(request.url || '', `http://${request.headers.host}`);
        const token = urlObj.searchParams.get('token');
        const pathname = urlObj.pathname;

        if (!token) {
            socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
            socket.destroy();
            return;
        }

        if (pathname === '/client' || pathname === '/host') {
            wss.handleUpgrade(request, socket, head, (ws) => {
                wss.emit('connection', ws, request, pathname, token);
            });
        } else {
            socket.destroy();
        }
    } catch {
        socket.destroy();
    }
});

wss.on('connection', (ws: WebSocket, request: any, type: string, token: string) => {
    console.log(`[CONNECT] New ${type} connected with token: ${token.substring(0, 5)}...`);

    // Register active user
    let pool = type === '/client' ? mobileClients : hostClients;
    let targetPool = type === '/client' ? hostClients : mobileClients;
    
    // If a connection for this device already existed, severely terminate it.
    if (pool.has(token)) {
        console.log(`[KICK] Kicking zombie ${type} connection for token: ${token.substring(0,5)}...`);
        pool.get(token)?.terminate();
    }
    pool.set(token, ws);
    
    // Send hello heartbeat
    ws.send(JSON.stringify({ event: 'system', message: 'Relay Connected.' }));

    // Message shuffler logic
    ws.on('message', (message: Buffer) => {
        try {
            const target = targetPool.get(token);
            if (target && target.readyState === WebSocket.OPEN) {
                target.send(message.toString());
            } else {
                // Return an explicit error if the other side is offline
                ws.send(JSON.stringify({ event: 'error', message: `Target peer offline. (Type: ${type === '/client' ? '/host' : '/client'})` }));
            }
        } catch (err) {
            console.error('Relay error:', err);
        }
    });

    ws.on('close', () => {
        console.log(`[DISCONNECT] ${type} disconnected. Token: ${token.substring(0,5)}...`);
        if (pool.get(token) === ws) pool.delete(token); // Avoid race condition deletes
    });
});

server.listen(PORT, () => {
    console.log(`🚀 ZeroG Cloud Router Active on port ${PORT}`);
});
