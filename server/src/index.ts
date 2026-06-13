import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { Server } from 'socket.io';
import { MAX_ORDER_BYTES } from '@tq/shared/constants';
import { registerHandlers } from './handlers';
import { RoomManager } from './rooms';
import { IpRateLimiter } from './rateLimit';

const PORT = Number(process.env.PORT ?? 3000);
const dirname = path.dirname(fileURLToPath(import.meta.url));
const clientDist = path.resolve(dirname, '../../client/dist');

const app = express();
app.disable('x-powered-by');

app.get('/healthz', (_req, res) => {
  res.json({ ok: true, uptime: process.uptime() });
});

if (existsSync(clientDist)) {
  app.use(
    express.static(clientDist, {
      setHeaders(res, filePath) {
        // index.html et sw.js pilotent les mises à jour : jamais cachés.
        if (filePath.endsWith('index.html') || filePath.endsWith('sw.js')) {
          res.setHeader('Cache-Control', 'no-cache');
        } else if (filePath.includes(`${path.sep}assets${path.sep}`)) {
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        }
      },
    }),
  );
  // Fallback SPA.
  app.use((_req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(path.join(clientDist, 'index.html'));
  });
} else {
  app.use((_req, res) => {
    res.status(503).send('Client non construit : lancez `npm run build` (ou utilisez le serveur de dev Vite).');
  });
}

const httpServer = createServer(app);
const io = new Server(httpServer, {
  // Doit dépasser MAX_ORDER_BYTES ; tout le reste est minuscule.
  maxHttpBufferSize: MAX_ORDER_BYTES * 2,
});

registerHandlers(io, new RoomManager(), new IpRateLimiter());

httpServer.listen(PORT, () => {
  console.log(`TacticalQuest serveur sur http://localhost:${PORT}`);
});
