import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { SessionManager } from './sessions.js';
import { login, logout, requireAuth, verifyRequest } from './auth.js';
import { attachWs } from './ws.js';

const PORT = Number(process.env.PORT || 7681);
const HOST = process.env.HOST || '127.0.0.1'; // 0.0.0.0 금지. tailscale serve / cloudflared가 로컬로 프록시
const ORIGINS = (process.env.WEBTERM_ORIGINS || 'http://localhost:5173').split(',');
const BUFFER_CHARS = Number(process.env.WEBTERM_BUFFER_CHARS || 2_000_000); // 약 2MB ≫ 2,000줄

const sessions = new SessionManager(BUFFER_CHARS);
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '8kb' }));

app.post('/api/login', login);
app.post('/api/logout', logout);
app.get('/api/sessions', requireAuth, (_req, res) => res.json(sessions.list()));
app.post('/api/sessions', requireAuth, (req, res) => {
  const s = sessions.create({ title: typeof req.body?.title === 'string' ? req.body.title.slice(0, 40) : undefined });
  res.json({ id: s.id, title: s.title, exitCode: null });
});
app.delete('/api/sessions/:id', requireAuth, (req, res) => res.status(sessions.kill(req.params.id) ? 204 : 404).end());

const webDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web/dist');
app.use(express.static(webDist));

const server = http.createServer(app);
attachWs(server, sessions, verifyRequest, ORIGINS);
server.listen(PORT, HOST, () => console.log(`webterm on http://${HOST}:${PORT}  origins=${ORIGINS.join(',')}`));
