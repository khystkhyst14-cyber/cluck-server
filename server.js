// Cluck Arena relay server. Run: npm install && node server.js
const http = require('http');
const { WebSocketServer } = require('ws');
const PORT = process.env.PORT || 8080;
const MIN_DEAD_MS = process.env.MIN_DEAD_MS !== undefined ? +process.env.MIN_DEAD_MS : 1500;
const MAPS = 25, SECONDS = 480;
const CH = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const rooms = new Map();
let nextId = 1;

const server = http.createServer((q, r) => { r.writeHead(200); r.end('Cluck Arena server OK'); });
const wss = new WebSocketServer({ server, maxPayload: 4096 });

function code() { let c; do { c = ''; for (let i = 0; i < 4; i++) c += Math.floor(Math.random() * 10); } while (rooms.has(c) && rooms.size < 9000); return c; }
function send(p, o) { if (p.ws.readyState === 1) p.ws.send(typeof o === 'string' ? o : JSON.stringify(o)); }
function all(rm, o, except) { const s = typeof o === 'string' ? o : JSON.stringify(o); for (const p of rm.players.values()) if (p !== except && p.ws.readyState === 1) p.ws.send(s); }
function plist(rm) { return [...rm.players.values()].map(p => ({ id: p.id, nick: p.nick, team: p.team, k: p.k, d: p.d, cs: p.cs, slot: 0 })); }
function scores(rm) { const s = [0, 0]; for (const p of rm.players.values()) if (p.team === 0 || p.team === 1) s[p.team] += p.k; return s; }
function roomMsg(rm, p) { return { t: 'room', code: rm.code, name: rm.name || '', you: p.id, host: rm.host, size: rm.size, map: rm.map, state: rm.state, players: plist(rm), scores: scores(rm) }; }
function bcastRoom(rm) { for (const p of rm.players.values()) send(p, roomMsg(rm, p)); }
function clean(s) { return String(s || 'Player').replace(/[^\w \-؀-ۿ]/g, '').slice(0, 14) || 'Player'; }

function toLobby(rm) {
  rm.state = 'lobby'; if (rm.timer) clearTimeout(rm.timer); rm.timer = null;
  for (const p of rm.players.values()) { p.k = 0; p.d = 0; }
  bcastRoom(rm);
}
function endMatch(rm, winner) {
  if (rm.state !== 'play') return;
  rm.state = 'end'; if (rm.timer) clearTimeout(rm.timer);
  all(rm, { t: 'end', winner, scores: scores(rm), players: plist(rm) });
  rm.timer = setTimeout(() => toLobby(rm), 10000);
}
function leave(p) {
  const rm = p.room; if (!rm) return; p.room = null;
  rm.players.delete(p.id);
  if (rm.players.size === 0) { if (rm.timer) clearTimeout(rm.timer); rooms.delete(rm.code); return; }
  if (rm.host === p.id) rm.host = rm.players.keys().next().value;
  all(rm, 'x|' + p.id);
  if (rm.state === 'play') {
    const c = [0, 0]; for (const q of rm.players.values()) if (q.team === 0 || q.team === 1) c[q.team]++;
    if (c[0] === 0 || c[1] === 0) { endMatch(rm, c[0] === 0 && c[1] === 0 ? -1 : (c[0] === 0 ? 1 : 0)); return; }
  }
  bcastRoom(rm);
}
function join(p, rm) {
  if (rm.players.size >= 16) return send(p, { t: 'err', m: 'Room full' });
  if (rm.state !== 'lobby') return send(p, { t: 'err', m: 'Match already running' });
  for (const q of rm.players.values()) if (q.nick === p.nick) { p.nick = p.nick.slice(0, 10) + '#' + p.id; break; }
  p.room = rm; p.team = -1; p.k = 0; p.d = 0; rm.players.set(p.id, p);
  bcastRoom(rm);
}

wss.on('connection', ws => {
  const p = { id: nextId++, ws, room: null, nick: 'Player', team: -1, k: 0, d: 0, cs: 0, alive: false, deadAt: 0, alive_: true };
  ws.isAlive = true; ws.on('pong', () => ws.isAlive = true);
  ws.on('message', (data, isBin) => {
    if (isBin) return;
    const s = data.toString(); const rm = p.room;
    if (s[0] === 's' && s[1] === '|') { if (rm && rm.state === 'play') all(rm, 's|' + p.id + s.slice(1), p); return; }
    if (s[0] === 'f' && s[1] === '|') { if (rm && rm.state === 'play') all(rm, 'f|' + p.id + s.slice(1), p); return; }
    if (s[0] === 'h' && s[1] === '|') {
      if (!rm || rm.state !== 'play') return;
      const a = s.split('|'); const v = rm.players.get(+a[1]); if (!v || v === p || v.team === p.team || p.team < 0) return;
      let dmg = +a[2]; if (!(dmg > 0) || dmg > 200) return;
      send(v, 'h|' + p.id + '|' + dmg + '|' + (a[3] === '1' ? 1 : 0)); return;
    }
    let m; try { m = JSON.parse(s); } catch { return; }
    if (!m || typeof m.t !== 'string') return;
    switch (m.t) {
      case 'create': {
        if (p.room) leave(p);
        p.nick = clean(m.nick); p.cs = m.cs | 0;
        const rm = { code: code(), name: String(m.name || '').replace(/[^\w \-]/g, '').slice(0, 20), host: p.id, size: Math.min(8, Math.max(1, m.size | 0 || 2)), map: Math.min(MAPS - 1, Math.max(0, m.map | 0)), state: 'lobby', players: new Map(), timer: null };
        rooms.set(rm.code, rm); join(p, rm); break;
      }
      case 'join': {
        if (p.room) leave(p);
        p.nick = clean(m.nick); p.cs = m.cs | 0;
        const rm = rooms.get(String(m.code || '').toUpperCase().trim());
        if (!rm) return send(p, { t: 'err', m: 'Room not found' });
        join(p, rm); break;
      }
      case 'team': {
        if (!rm || rm.state !== 'lobby') return;
        const t = m.team | 0; if (t !== 0 && t !== 1) return;
        const c = [0, 0]; for (const q of rm.players.values()) if (q !== p && (q.team === 0 || q.team === 1)) c[q.team]++;
        if (c[t] >= rm.size) return send(p, { t: 'err', m: 'Team full' });
        p.team = t; bcastRoom(rm); break;
      }
      case 'cfg': {
        if (!rm || rm.state !== 'lobby' || rm.host !== p.id) return;
        rm.size = Math.min(8, Math.max(1, m.size | 0 || rm.size)); rm.map = Math.min(MAPS - 1, Math.max(0, m.map | 0)); bcastRoom(rm); break;
      }
      case 'start': {
        if (!rm || rm.state !== 'lobby' || rm.host !== p.id) return;
        const c = [0, 0]; let un = 0;
        for (const q of rm.players.values()) { if (q.team === 0 || q.team === 1) c[q.team]++; else un++; }
        if (un) return send(p, { t: 'err', m: 'Everyone must choose a team' });
        if (c[0] < 1 || c[1] < 1) return send(p, { t: 'err', m: 'Both teams need a player' });
        rm.state = 'play'; for (const q of rm.players.values()) { q.k = 0; q.d = 0; q.deadAt = 0; }
        const lim = Math.max(10, rm.size * 10);
        for (const q of rm.players.values()) send(q, { t: 'start', map: rm.map, size: rm.size, limit: lim, seconds: SECONDS, you: q.id, players: plist(rm) });
        rm.timer = setTimeout(() => { const s2 = scores(rm); endMatch(rm, s2[0] === s2[1] ? -1 : (s2[0] > s2[1] ? 0 : 1)); }, SECONDS * 1000 + 3000);
        rm.lim = lim; break;
      }
      case 'dead': {
        if (!rm || rm.state !== 'play') return;
        const now = Date.now(); if (now - p.deadAt < MIN_DEAD_MS) return; p.deadAt = now;
        p.d++;
        const k = rm.players.get(m.killer | 0);
        if (k && k !== p && k.team !== p.team) k.k++;
        all(rm, { t: 'kill', killer: k ? k.id : 0, victim: p.id, head: !!m.head, scores: scores(rm), players: plist(rm) });
        const sc = scores(rm);
        if (sc[0] >= rm.lim) endMatch(rm, 0); else if (sc[1] >= rm.lim) endMatch(rm, 1);
        break;
      }
      case 'back': { if (rm && rm.state === 'end') { /* client leaving end screen; stays in room */ } break; }
    }
  });
  ws.on('close', () => leave(p));
  ws.on('error', () => {});
});
setInterval(() => { for (const ws of wss.clients) { if (!ws.isAlive) { ws.terminate(); continue; } ws.isAlive = false; ws.ping(); } }, 25000);
server.listen(PORT, () => console.log('Cluck Arena server on :' + PORT));
