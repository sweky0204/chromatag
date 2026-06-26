const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const publicDir = path.join(__dirname, 'public');
app.use(express.static(publicDir));
app.get('/', (req, res) => res.sendFile(path.join(publicDir, 'index.html')));
app.get('*', (req, res) => res.sendFile(path.join(publicDir, 'index.html')));

// ── Constants ──────────────────────────────────────────────────────────────
const TILE = { WHITE: 'white', RED: 'red', BLUE: 'blue', GREEN: 'green' };
const COLOR = { RED: 'red', BLUE: 'blue', GREEN: 'green' };
const PICKUP = { SPEED: 'speed', SHIELD: 'shield', PORTAL_PURPLE: 'portal_purple', PORTAL_GREEN: 'portal_green' };

const INITIAL_MAP_SIZE = 40;
const MIN_MAP_SIZE = 16;
const MAP_SHRINK_AMOUNT = 2;
const SHRINK_EVERY_N_ELIMINATIONS = 2;
const WHITE_RATIO = 0.60;
const MAX_LIVES = 3;
const RESHUFFLE_START_MS = 5000;
const RESHUFFLE_END_MS = 3000;
const SPEED_DURATION_MS = 5000;
const SHIELD_DURATION_MS = 4000;
const PORTAL_DURATION_MS = 8000;
const PORTAL_COOLDOWN_MS = 1500;
const INVINCIBILITY_DURATION_MS = 2000;
const MAX_PICKUPS_PER_TYPE = 2;
const PICKUP_SPAWN_INTERVAL_MS = 3000;
const TICK_RATE_MS = 50;
const PLAYER_COLORS = [COLOR.RED, COLOR.BLUE, COLOR.GREEN];

// ── Game State ─────────────────────────────────────────────────────────────
let state = null;
let gameLoop = null;
let reshuffleTimer = null;
let pickupTimer = null;
let totalEliminations = 0;

function createGameState() {
  return {
    phase: 'lobby',   // lobby | countdown | playing | ended
    mapSize: INITIAL_MAP_SIZE,
    tiles: [],
    players: {},
    pickups: {},
    nextPickupId: 1,
    reshuffleInterval: RESHUFFLE_START_MS,
    countdown: 5,
  };
}

// ── Map Helpers ────────────────────────────────────────────────────────────
function generateTiles(size) {
  const total = size * size;
  const coloredCount = Math.floor(total * (1 - WHITE_RATIO));
  const perColor = Math.floor(coloredCount / 3);
  const pool = [
    ...Array(perColor).fill(TILE.RED),
    ...Array(perColor).fill(TILE.BLUE),
    ...Array(coloredCount - 2 * perColor).fill(TILE.GREEN),
    ...Array(total - coloredCount).fill(TILE.WHITE),
  ];
  // Fisher-Yates shuffle
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool;
}

function tileIndex(x, y, size) {
  return y * size + x;
}

function getTile(x, y) {
  if (!state) return TILE.WHITE;
  return state.tiles[tileIndex(x, y, state.mapSize)] || TILE.WHITE;
}

// ── Player Helpers ─────────────────────────────────────────────────────────
function randomSpawnPos() {
  const s = state.mapSize;
  return {
    x: Math.floor(Math.random() * s),
    y: Math.floor(Math.random() * s),
  };
}

function randomColor() {
  return PLAYER_COLORS[Math.floor(Math.random() * PLAYER_COLORS.length)];
}

function createPlayer(id, name) {
  const pos = randomSpawnPos();
  return {
    id,
    name,
    x: pos.x,
    y: pos.y,
    color: randomColor(),
    lives: MAX_LIVES,
    alive: true,
    spectating: false,
    shield: false,
    shieldEnd: 0,
    speedBoost: false,
    speedEnd: 0,
    invincible: false,
    invincibleEnd: 0,
    portalCooldownEnd: 0,
    score: 0,
  };
}

// ── Catch Logic ────────────────────────────────────────────────────────────
// Red catches Blue, Blue catches Green, Green catches Red
function catches(attackerColor, defenderColor) {
  if (attackerColor === COLOR.RED && defenderColor === COLOR.BLUE) return true;
  if (attackerColor === COLOR.BLUE && defenderColor === COLOR.GREEN) return true;
  if (attackerColor === COLOR.GREEN && defenderColor === COLOR.RED) return true;
  return false;
}

// ── Pickup Helpers ─────────────────────────────────────────────────────────
function spawnPickups() {
  if (!state || state.phase !== 'playing') return;

  const now = Date.now();
  const counts = { speed: 0, shield: 0, portal_purple: 0, portal_green: 0 };
  for (const p of Object.values(state.pickups)) {
    counts[p.type] = (counts[p.type] || 0) + 1;
  }

  // Occupied tiles (by players or existing pickups)
  const occupiedKeys = new Set();
  for (const pl of Object.values(state.players)) {
    if (pl.alive) occupiedKeys.add(`${pl.x},${pl.y}`);
  }
  for (const p of Object.values(state.pickups)) {
    occupiedKeys.add(`${p.x},${p.y}`);
  }

  // Portal pairs - track if we need to add a pair
  const portalTypes = [PICKUP.PORTAL_PURPLE, PICKUP.PORTAL_GREEN];
  const gemTypes = [PICKUP.SPEED, PICKUP.SHIELD];

  // Spawn gems
  for (const type of gemTypes) {
    while (counts[type] < MAX_PICKUPS_PER_TYPE) {
      const pos = findFreePos(occupiedKeys);
      if (!pos) break;
      const id = `p${state.nextPickupId++}`;
      state.pickups[id] = { id, type, x: pos.x, y: pos.y, expiresAt: now + (type === PICKUP.SPEED ? PORTAL_DURATION_MS + 2000 : PORTAL_DURATION_MS) };
      occupiedKeys.add(`${pos.x},${pos.y}`);
      counts[type]++;
    }
  }

  // Spawn portal pairs
  for (const type of portalTypes) {
    while (counts[type] < MAX_PICKUPS_PER_TYPE) {
      // Need 2 free spots for a pair
      const pos1 = findFreePos(occupiedKeys);
      if (!pos1) break;
      occupiedKeys.add(`${pos1.x},${pos1.y}`);
      const pos2 = findFreePos(occupiedKeys);
      if (!pos2) { occupiedKeys.delete(`${pos1.x},${pos1.y}`); break; }
      occupiedKeys.add(`${pos2.x},${pos2.y}`);

      const id1 = `p${state.nextPickupId++}`;
      const id2 = `p${state.nextPickupId++}`;
      const pairId = `pair_${id1}_${id2}`;
      const exp = now + PORTAL_DURATION_MS;
      state.pickups[id1] = { id: id1, type, x: pos1.x, y: pos1.y, expiresAt: exp, pairId, partnerId: id2 };
      state.pickups[id2] = { id: id2, type, x: pos2.x, y: pos2.y, expiresAt: exp, pairId, partnerId: id1 };
      counts[type] += 2;
    }
  }
}

function findFreePos(occupiedKeys) {
  const s = state.mapSize;
  let attempts = 0;
  while (attempts < 100) {
    const x = Math.floor(Math.random() * s);
    const y = Math.floor(Math.random() * s);
    if (!occupiedKeys.has(`${x},${y}`)) return { x, y };
    attempts++;
  }
  return null;
}

// ── Reshuffle ──────────────────────────────────────────────────────────────
function reshuffleMap() {
  if (!state || state.phase !== 'playing') return;
  state.tiles = generateTiles(state.mapSize);
  // Apply color changes to players standing on colored tiles
  const now = Date.now();
  for (const pl of Object.values(state.players)) {
    if (!pl.alive) continue;
    if (pl.shield && now < pl.shieldEnd) continue;
    const tile = getTile(pl.x, pl.y);
    if (tile !== TILE.WHITE) pl.color = tile;
  }
  // After reshuffle, resolve catches
  resolveCatches();
}

function getShuffleInterval() {
  const alive = Object.values(state.players).filter(p => p.alive).length;
  const total = Object.keys(state.players).length;
  const eliminated = total - alive;
  // Linearly interpolate from START to END as eliminations increase
  const t = Math.min(eliminated / Math.max(total - 2, 1), 1);
  return Math.round(RESHUFFLE_START_MS + t * (RESHUFFLE_END_MS - RESHUFFLE_START_MS));
}

function scheduleReshuffle() {
  clearTimeout(reshuffleTimer);
  if (!state || state.phase !== 'playing') return;
  const interval = getShuffleInterval();
  state.reshuffleInterval = interval;
  reshuffleTimer = setTimeout(() => {
    reshuffleMap();
    broadcast({ type: 'reshuffle', tiles: state.tiles, reshuffleIn: getShuffleInterval() });
    scheduleReshuffle();
  }, interval);
}

// ── Catch Resolution ───────────────────────────────────────────────────────
function resolveCatches() {
  const now = Date.now();
  const alivePlayers = Object.values(state.players).filter(p => p.alive);

  // Group by position
  const byPos = {};
  for (const pl of alivePlayers) {
    const key = `${pl.x},${pl.y}`;
    if (!byPos[key]) byPos[key] = [];
    byPos[key].push(pl);
  }

  for (const group of Object.values(byPos)) {
    if (group.length < 2) continue;
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i], b = group[j];
        if (catches(a.color, b.color)) tryHit(b, a, now);
        else if (catches(b.color, a.color)) tryHit(a, b, now);
      }
    }
  }
}

function tryHit(victim, attacker, now) {
  if (victim.shield && now < victim.shieldEnd) return;
  if (victim.invincible && now < victim.invincibleEnd) return;
  victim.lives--;
  if (victim.lives <= 0) {
    victim.alive = false;
    victim.lives = 0;
    totalEliminations++;
    checkShrink();
    broadcast({ type: 'eliminated', playerId: victim.id, byId: attacker.id });
    checkWin();
  } else {
    // Respawn
    const pos = randomSpawnPos();
    victim.x = pos.x; victim.y = pos.y;
    victim.color = randomColor();
    victim.invincible = true;
    victim.invincibleEnd = now + INVINCIBILITY_DURATION_MS;
    broadcast({ type: 'hit', playerId: victim.id, lives: victim.lives, x: victim.x, y: victim.y, color: victim.color });
  }
}

// ── Map Shrink ─────────────────────────────────────────────────────────────
let lastShrinkAt = 0;

function checkShrink() {
  if (totalEliminations > 0 && totalEliminations % SHRINK_EVERY_N_ELIMINATIONS === 0) {
    if (totalEliminations !== lastShrinkAt) {
      lastShrinkAt = totalEliminations;
      shrinkMap();
    }
  }
}

function shrinkMap() {
  if (!state) return;
  const newSize = Math.max(state.mapSize - MAP_SHRINK_AMOUNT, MIN_MAP_SIZE);
  if (newSize === state.mapSize) return;
  state.mapSize = newSize;
  state.tiles = generateTiles(newSize);

  // Push players inside bounds
  const now = Date.now();
  for (const pl of Object.values(state.players)) {
    if (!pl.alive) continue;
    let moved = false;
    if (pl.x >= newSize) { pl.x = newSize - 1; moved = true; }
    if (pl.y >= newSize) { pl.y = newSize - 1; moved = true; }
    // Apply tile color after push
    if (moved) {
      const tile = getTile(pl.x, pl.y);
      if (tile !== TILE.WHITE && !(pl.shield && now < pl.shieldEnd)) pl.color = tile;
    }
  }

  // Remove out-of-bounds pickups
  for (const [id, pk] of Object.entries(state.pickups)) {
    if (pk.x >= newSize || pk.y >= newSize) {
      // Remove partner too if portal
      if (pk.partnerId && state.pickups[pk.partnerId]) {
        const partner = state.pickups[pk.partnerId];
        if (partner.x >= newSize || partner.y >= newSize) {
          delete state.pickups[pk.partnerId];
        }
      }
      delete state.pickups[id];
    }
  }

  broadcast({ type: 'shrink', mapSize: newSize, tiles: state.tiles });
  resolveCatches();
}

// ── Win Check ──────────────────────────────────────────────────────────────
function checkWin() {
  const alive = Object.values(state.players).filter(p => p.alive);
  if (alive.length <= 1) {
    state.phase = 'ended';
    clearTimeout(reshuffleTimer);
    clearInterval(pickupTimer);
    clearInterval(gameLoop);
    gameLoop = null;
    const winner = alive[0] || null;
    broadcast({ type: 'gameOver', winnerId: winner ? winner.id : null, winnerName: winner ? winner.name : 'Nobody' });
  }
}

// ── Pickup Collection ──────────────────────────────────────────────────────
function checkPickups(player) {
  const now = Date.now();
  for (const [id, pk] of Object.entries(state.pickups)) {
    if (pk.x === player.x && pk.y === player.y) {
      if (pk.type === PICKUP.SPEED) {
        player.speedBoost = true;
        player.speedEnd = now + SPEED_DURATION_MS;
        delete state.pickups[id];
        broadcast({ type: 'pickupCollected', pickupId: id, playerId: player.id, effect: 'speed', duration: SPEED_DURATION_MS });
      } else if (pk.type === PICKUP.SHIELD) {
        player.shield = true;
        player.shieldEnd = now + SHIELD_DURATION_MS;
        delete state.pickups[id];
        broadcast({ type: 'pickupCollected', pickupId: id, playerId: player.id, effect: 'shield', duration: SHIELD_DURATION_MS });
      } else if (pk.type === PICKUP.PORTAL_PURPLE || pk.type === PICKUP.PORTAL_GREEN) {
        if (now < player.portalCooldownEnd) continue;
        const partner = state.pickups[pk.partnerId];
        if (!partner) continue;
        // Teleport player to partner location
        player.x = partner.x;
        player.y = partner.y;
        player.portalCooldownEnd = now + PORTAL_COOLDOWN_MS;
        // Apply tile color at destination
        if (!(player.shield && now < player.shieldEnd)) {
          const destTile = getTile(partner.x, partner.y);
          if (destTile !== TILE.WHITE) player.color = destTile;
        }
        // Remove portal pair after teleport
        const partnerId = pk.partnerId;
        delete state.pickups[id];
        delete state.pickups[partnerId];
        broadcast({ type: 'portalUsed', pickupId: id, partnerId, playerId: player.id, x: player.x, y: player.y, color: player.color });
        resolveCatches();
        return; // only one pickup per step
      }
    }
  }
}

// ── Expire Pickups ─────────────────────────────────────────────────────────
function expirePickups() {
  if (!state || state.phase !== 'playing') return;
  const now = Date.now();
  const removed = [];
  for (const [id, pk] of Object.entries(state.pickups)) {
    if (now >= pk.expiresAt) {
      removed.push(id);
      // Remove portal partner too if it still exists
      if (pk.partnerId && state.pickups[pk.partnerId]) {
        const partner = state.pickups[pk.partnerId];
        if (now >= partner.expiresAt) {
          removed.push(pk.partnerId);
          delete state.pickups[pk.partnerId];
        }
      }
      delete state.pickups[id];
    }
  }
  if (removed.length > 0) broadcast({ type: 'pickupsExpired', ids: removed });
}

// ── Game Loop ──────────────────────────────────────────────────────────────
function startGameLoop() {
  gameLoop = setInterval(() => {
    if (!state || state.phase !== 'playing') return;
    const now = Date.now();
    // Expire power-ups
    for (const pl of Object.values(state.players)) {
      if (!pl.alive) continue;
      if (pl.speedBoost && now >= pl.speedEnd) { pl.speedBoost = false; }
      if (pl.shield && now >= pl.shieldEnd) { pl.shield = false; }
      if (pl.invincible && now >= pl.invincibleEnd) { pl.invincible = false; }
    }
    expirePickups();
    broadcastState();
  }, TICK_RATE_MS);
}

// ── Broadcast ──────────────────────────────────────────────────────────────
function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(data);
  }
}

function broadcastState() {
  broadcast({
    type: 'state',
    players: state.players,
    pickups: state.pickups,
    mapSize: state.mapSize,
    reshuffleInterval: state.reshuffleInterval,
  });
}

// ── WebSocket Handlers ─────────────────────────────────────────────────────
wss.on('connection', (ws) => {
  let playerId = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'join') {
      if (!state) state = createGameState();
      if (state.phase !== 'lobby') {
        ws.send(JSON.stringify({ type: 'error', message: 'Game already in progress' }));
        return;
      }
      const playerCount = Object.keys(state.players).length;
      if (playerCount >= 8) {
        ws.send(JSON.stringify({ type: 'error', message: 'Game is full (8 players max)' }));
        return;
      }
      playerId = `player_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      const name = (msg.name || `Player${playerCount + 1}`).slice(0, 16);
      state.players[playerId] = createPlayer(playerId, name);
      ws.send(JSON.stringify({ type: 'joined', playerId, players: state.players, phase: state.phase }));
      broadcast({ type: 'playerJoined', player: state.players[playerId], players: state.players });
    }

    else if (msg.type === 'startGame') {
      if (!state || state.phase !== 'lobby') return;
      const pCount = Object.keys(state.players).length;
      if (pCount < 2) {
        ws.send(JSON.stringify({ type: 'error', message: 'Need at least 2 players to start' }));
        return;
      }
      // Scale starting map size to player count
      // 2 players -> 20x20, 3-4 -> 26x26, 5-6 -> 32x32, 7-8 -> 40x40
      if      (pCount <= 2) state.mapSize = 20;
      else if (pCount <= 4) state.mapSize = 26;
      else if (pCount <= 6) state.mapSize = 32;
      else                  state.mapSize = 40;
      // Init map
      state.tiles = generateTiles(state.mapSize);
      // Random spawn all players
      const occupied = new Set();
      for (const pl of Object.values(state.players)) {
        let pos;
        do { pos = { x: Math.floor(Math.random() * state.mapSize), y: Math.floor(Math.random() * state.mapSize) }; }
        while (occupied.has(`${pos.x},${pos.y}`));
        occupied.add(`${pos.x},${pos.y}`);
        pl.x = pos.x; pl.y = pos.y;
        pl.color = randomColor();
        // Apply starting tile
        const tile = getTile(pl.x, pl.y);
        if (tile !== TILE.WHITE) pl.color = tile;
      }
      state.phase = 'countdown';
      state.countdown = 5;
      broadcast({ type: 'countdown', count: 5, tiles: state.tiles, mapSize: state.mapSize, players: state.players });
      let c = 4;
      const cdTimer = setInterval(() => {
        state.countdown = c;
        broadcast({ type: 'countdown', count: c });
        c--;
        if (c < 0) {
          clearInterval(cdTimer);
          state.phase = 'playing';
          totalEliminations = 0;
          lastShrinkAt = 0;
          broadcast({ type: 'gameStart', players: state.players, tiles: state.tiles, mapSize: state.mapSize });
          startGameLoop();
          scheduleReshuffle();
          pickupTimer = setInterval(() => { spawnPickups(); }, PICKUP_SPAWN_INTERVAL_MS);
        }
      }, 1000);
    }

    else if (msg.type === 'move') {
      if (!state || state.phase !== 'playing') return;
      const pl = state.players[playerId];
      if (!pl || !pl.alive) return;
      const now = Date.now();
      const { dx, dy } = msg;
      if (typeof dx !== 'number' || typeof dy !== 'number') return;
      if (Math.abs(dx) + Math.abs(dy) !== 1) return; // only cardinal
      const nx = pl.x + dx;
      const ny = pl.y + dy;
      if (nx < 0 || ny < 0 || nx >= state.mapSize || ny >= state.mapSize) return;
      pl.x = nx; pl.y = ny;
      // Apply tile color
      if (!(pl.shield && now < pl.shieldEnd)) {
        const tile = getTile(pl.x, pl.y);
        if (tile !== TILE.WHITE) pl.color = tile;
      }
      // Check pickups
      checkPickups(pl);
      // Resolve catches
      resolveCatches();
    }

    else if (msg.type === 'spectate') {
      if (!state) return;
      const pl = state.players[playerId];
      if (pl) pl.spectating = true;
    }

    else if (msg.type === 'resetGame') {
      // Reset for new game
      clearTimeout(reshuffleTimer);
      clearInterval(pickupTimer);
      clearInterval(gameLoop);
      gameLoop = null;
      state = createGameState();
      totalEliminations = 0;
      lastShrinkAt = 0;
      broadcast({ type: 'reset' });
    }
  });

  ws.on('close', () => {
    if (playerId && state && state.players[playerId]) {
      delete state.players[playerId];
      broadcast({ type: 'playerLeft', playerId });
      // If no players left at all, fully reset regardless of game phase
      if (Object.keys(state.players).length === 0) {
        clearTimeout(reshuffleTimer);
        clearInterval(pickupTimer);
        clearInterval(gameLoop);
        gameLoop = null;
        state = null;
      } else if (state.phase === 'playing') {
        // Mark disconnected player as dead so game can continue/end
        checkWin();
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`ChromaTag server running on port ${PORT}`));
