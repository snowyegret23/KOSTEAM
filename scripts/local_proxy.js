import http from 'http';
import net from 'net';
import { URL } from 'url';

const PORT = 8888;

const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Proxy is running. Use HTTP CONNECT for proxying.');
});

// Handle HTTP CONNECT requests (HTTPS tunneling)
server.on('connect', (req, clientSocket, head) => {
    const { port, hostname } = new URL(`http://${req.url}`);

    console.log(`Proxying request to ${hostname}:${port}`);

    const serverSocket = net.connect(port || 80, hostname, () => {
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n' +
            'Proxy-agent: Node.js-Proxy\r\n' +
            '\r\n');
        serverSocket.write(head);
        serverSocket.pipe(clientSocket);
        clientSocket.pipe(serverSocket);
    });

    serverSocket.on('error', (err) => {
        console.error(`Destination Error (${hostname}):`, err.message);
        clientSocket.end();
    });

    clientSocket.on('error', (err) => {
        console.error('Client Error:', err.message);
        serverSocket.end();
    });
});

server.listen(PORT, () => {
    console.log(`=============================================`);
    console.log(`   Local Proxy Server running on port ${PORT}`);
    console.log(`=============================================`);
    console.log(`\nTo expose this to GitHub Actions:`);
    console.log(`1. Install ngrok (https://ngrok.com/download)`);
    console.log(`2. Run: ngrok http ${PORT}`);
    console.log(`3. Copy the Forwarding URL (e.g. https://xxxx.ngrok-free.app)`);
    console.log(`4. Set QUASARPLAY_PROXY secret in GitHub to that URL.`);
});
