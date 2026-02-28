import http from 'http';

const port = 3000;

const server = http.createServer((req, res) => {
    console.log(`Mock server received request: ${req.method} ${req.url}`);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ message: 'Success', url: req.url }));
});

server.listen(port, () => {
    console.log(`Mock server for TestSprite listening at http://localhost:${port}`);
});
