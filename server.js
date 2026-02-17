const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 8002;
const DIR = __dirname;
const LAYOUT_FILE = path.join(DIR, 'layout.json');

const MIME_TYPES = {
    '.html': 'text/html',
    '.js': 'application/javascript',
    '.css': 'text/css',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.json': 'application/json',
    '.glb': 'model/gltf-binary',
    '.gltf': 'model/gltf+json',
};

const server = http.createServer((req, res) => {
    // Save layout endpoint
    if (req.method === 'POST' && req.url === '/save-layout') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                JSON.parse(body); // validate JSON
                fs.writeFileSync(LAYOUT_FILE, body, 'utf8');
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end('{"ok":true}');
            } catch (e) {
                res.writeHead(400);
                res.end('Invalid JSON');
            }
        });
        return;
    }

    // Load layout endpoint
    if (req.method === 'GET' && req.url === '/load-layout') {
        if (fs.existsSync(LAYOUT_FILE)) {
            const data = fs.readFileSync(LAYOUT_FILE, 'utf8');
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(data);
        } else {
            res.writeHead(404);
            res.end('{}');
        }
        return;
    }

    // Static file serving
    let filePath = path.join(DIR, req.url === '/' ? 'index.html' : req.url);
    const ext = path.extname(filePath);
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    fs.readFile(filePath, (err, data) => {
        if (err) {
            res.writeHead(404);
            res.end('Not found');
            return;
        }
        res.writeHead(200, { 'Content-Type': contentType });
        res.end(data);
    });
});

server.listen(PORT, () => {
    console.log(`Business World running at http://localhost:${PORT}`);
});
