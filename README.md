# 🎮 ChromaTag

A fast-paced multiplayer tile-based tag game for 2–8 players.

**Red catches Blue · Blue catches Green · Green catches Red**

---

## 🚀 Deploy to Railway (Free, Online Multiplayer)

1. Push this folder to a GitHub repo
2. Go to [railway.app](https://railway.app) → **New Project** → **Deploy from GitHub**
3. Select your repo → Railway auto-detects the Dockerfile and deploys
4. Click the generated URL (e.g. `https://chromatag.up.railway.app`) → share with friends!

> Railway gives $5 free credit/month — more than enough for game sessions.

---

## 🖥️ Run Locally (Same WiFi)

```bash
npm install
node server.js
```

- Host opens `http://localhost:3000`
- Others on same WiFi open `http://<your-local-ip>:3000`
  - Find your IP: `ipconfig` (Windows) or `ifconfig` (Mac/Linux)

---

## 🎮 How to Play

| Key | Action |
|-----|--------|
| WASD / Arrow Keys | Move |
| Movement is tile-snapped | One tile per step |

### Colors & Catching
- 🔴 **Red** catches 🔵 **Blue**
- 🔵 **Blue** catches 🟢 **Green**  
- 🟢 **Green** catches 🔴 **Red**
- Stepping on a colored tile **turns you that color**
- White tiles **preserve** your current color

### Power-ups
| Icon | Item | Effect |
|------|------|--------|
| 🟡 Yellow Gem | Speed Boost | 2× movement speed for 5 seconds |
| 🩷 Pink Gem | Shield | Immune to catching & color change for 4 seconds |
| 🟣 Purple Portal | Teleport | Teleports to the other purple portal |
| 🟢 Green Portal | Teleport | Teleports to the other green portal |

### Rules
- Each player starts with **3 lives ❤️❤️❤️**
- Losing all 3 lives = eliminated (can spectate)
- Map **reshuffles** tile colors every 5 seconds (speeds up as players are eliminated)
- Map **shrinks** every 2 eliminations (like a battle royale zone)
- **Last player standing wins!**

---

## ⚙️ Tech Stack
- **Server:** Node.js + Express + WebSocket (`ws`)
- **Client:** Vanilla HTML/CSS/JS — no frameworks, no build step
- **Deploy:** Docker → Railway / Render
