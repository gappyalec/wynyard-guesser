# Wynyard Guesser — Setup Guide

A GeoGuesser-style multiplayer game for Wynyard Quarter, Auckland.

---

## Project Structure

```
wynyard-guesser/
├── backend/
│   ├── server.js          ← Node.js + Express + Socket.io server
│   ├── schema.sql         ← Run this in Supabase SQL Editor
│   ├── package.json
│   └── .env.example       ← Copy to .env and fill in
│
└── frontend/
    ├── game/
    │   └── index.html     ← What players open to play
    └── admin/
        └── index.html     ← What you open to manage rounds and create games
```

---

## Step 1 — Supabase Setup

1. Go to https://supabase.com and open your project.

2. In the left sidebar: **SQL Editor → New Query**

3. Paste the contents of `backend/schema.sql` and click **Run**.

4. In the left sidebar: **Storage → New Bucket**
   - Bucket name: `game-assets`
   - Toggle **Public bucket** to ON
   - Click Create

5. Get your **Service Role Key**:
   - Settings → API → `service_role` key (the secret one, NOT the anon key)
   - You'll need this for the backend `.env`

---

## Step 2 — Backend Setup & Deploy to Railway

### Local test first:

```bash
cd backend
npm install
cp .env.example .env
```

Edit `.env`:
```
SUPABASE_URL=https://rccuypvywdmrethmhvnj.supabase.co
SUPABASE_SERVICE_KEY=your_service_role_key_here   ← from Supabase Settings → API
PORT=3001
FRONTEND_URL=http://localhost:5500
ADMIN_PASSWORD=pick_a_strong_password_here
```

Run locally:
```bash
npm run dev
```

Visit http://localhost:3001 — you should see the server is running.

### Deploy to Railway:

1. Go to https://railway.app and sign up (free tier works).

2. Click **New Project → Deploy from GitHub repo**
   - Connect your GitHub account
   - Push the `backend/` folder to a GitHub repo first (or the whole project)

3. Railway will auto-detect Node.js and deploy.

4. In Railway project settings → **Variables**, add:
   ```
   SUPABASE_URL=https://rccuypvywdmrethmhvnj.supabase.co
   SUPABASE_SERVICE_KEY=your_service_role_key
   ADMIN_PASSWORD=your_chosen_password
   FRONTEND_URL=https://yourusername.github.io/wynyard-guesser
   ```

5. Railway gives you a URL like `https://wynyard-guesser.up.railway.app`
   — **Copy this URL**, you need it in Step 3.

> **Alternative**: You can also use Render.com (same process, also free tier).

---

## Step 3 — Frontend Configuration

In BOTH frontend files, find and replace `YOUR_BACKEND_URL_HERE`:

**`frontend/game/index.html`** — around line 290:
```js
const BACKEND_URL = 'https://your-railway-url.up.railway.app';
```

**`frontend/admin/index.html`** — around line 310:
```js
const BACKEND_URL = 'https://your-railway-url.up.railway.app';
const GAME_URL = 'https://yourusername.github.io/wynyard-guesser/game';
```

---

## Step 4 — Host Frontend on GitHub Pages

1. Create a new GitHub repository (e.g. `wynyard-guesser`).

2. Push the entire `wynyard-guesser/` folder to it:
```bash
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/yourusername/wynyard-guesser.git
git push -u origin main
```

3. In your GitHub repo: **Settings → Pages**
   - Source: `Deploy from a branch`
   - Branch: `main`, folder: `/ (root)`
   - Click Save

4. After a minute, your game will be live at:
   - Game: `https://yourusername.github.io/wynyard-guesser/frontend/game/`
   - Admin: `https://yourusername.github.io/wynyard-guesser/frontend/admin/`

---

## Step 5 — First Time: Upload Map & Add Rounds

1. Open the Admin panel in your browser.

2. Enter your `ADMIN_PASSWORD`.

3. Go to **Map Setup** tab:
   - Upload your Wynyard Quarter map PNG.

4. Go to **Add Round** tab:
   - Upload a location photo
   - Click the map where the photo was taken
   - Optionally add a label (e.g. "North Wharf looking east")
   - Click Add Round
   - Repeat for as many rounds as you want

5. Go to **Rounds** tab:
   - Select the rounds you want in your game (in the order you want)
   - Click **Create Game**
   - You'll get an invite code and a shareable link

---

## Step 6 — Running a Game

1. Share the invite link (or just the 6-letter code) with players.

2. Players open the link on their devices and enter their display name.

3. You (the host) press **Start Game** in the lobby.

4. Each round:
   - Everyone gets the photo at the same time
   - They click the map to place their guess
   - They click "Confirm Guess"
   - 30 seconds per round (server-controlled)
   - After time is up, the correct location is shown with everyone's scores
   - Next round starts automatically after 8 seconds

5. Final leaderboard shown at the end.

---

## Scoring

| Component | Points |
|---|---|
| Perfect guess (0m away) | 5000 |
| 1800m away (edge of map) | 0 |
| Time bonus (full time remaining) | up to 2000 |
| **Max per round** | **7000** |

---

## FAQ

**Q: Can I change the round duration?**
A: Yes. In `backend/server.js`, find `const ROUND_DURATION = 30` and change it.

**Q: Can I run multiple games simultaneously?**
A: Yes. Each game has its own room code and runs independently.

**Q: What if the host disconnects?**
A: The next player in the room automatically becomes host.

**Q: How do I reset / delete all rounds and start fresh?**
A: In Supabase SQL Editor: `DELETE FROM rounds;`
   And in Supabase Storage, manually delete files in the `game-assets/rounds/` folder.

**Q: How many players can one game support?**
A: Comfortably 20-30. Socket.io can handle more but hasn't been load-tested for this project.
