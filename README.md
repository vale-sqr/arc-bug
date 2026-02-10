# Arc Bug Tracker

A simple bug tracking dashboard for Discord channels. Monitors messages starting with `▶️` and displays them in a clean web interface.

## Features

- 🐛 Automatically tracks messages starting with `▶️`
- 💬 Tracks replies to bug reports
- 🤖 **AI-powered status detection** using Claude Haiku - understands natural language!
- ✅ Auto-detects status changes from casual messages and reactions
- 🌐 Clean web dashboard (read-only for humans)
- 🔄 Auto-refreshes every 30 seconds
- ⚡ **Slash commands** for dynamic channel management

## Slash Commands

| Command | Description |
|---------|-------------|
| `/addchannel #channel` | Start monitoring a channel for bugs |
| `/removechannel #channel` | Stop monitoring a channel |
| `/listchannels` | List all monitored channels |
| `/recentbugs [count] [status]` | Show recent bugs with Discord links |

## Quick Start

### 1. Create a Discord Bot

1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. Click "New Application" → name it "Arc Bug Tracker"
3. Go to **Bot** tab → Click "Add Bot"
4. Under **Privileged Gateway Intents**, enable:
   - ✅ MESSAGE CONTENT INTENT (required to read message content)
5. Click "Reset Token" and copy the token (keep it secret!)

### 2. Invite Bot to Your Server

1. Go to **OAuth2** → **URL Generator**
2. Select scopes:
   - ✅ `bot`
   - ✅ `applications.commands`
3. Select permissions:
   - ✅ Read Messages/View Channels
   - ✅ Read Message History
   - ✅ Send Messages
   - ✅ Use Slash Commands
4. Copy the generated URL and visit it to invite the bot

### 3. Run Locally

```bash
# Install dependencies
npm install

# Create token file
echo "your-discord-bot-token" > discord_token

# Run
npm run dev
```

Open http://localhost:3000 to see the dashboard!

### 4. Configure Channels

In Discord, use the slash command:
```
/addchannel #your-bug-channel
```

That's it! The bot will now monitor that channel.

> 📖 **For detailed setup instructions, deployment to Railway, and more, see [SETUP.md](./SETUP.md)**

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DISCORD_TOKEN` | Yes* | Discord bot token |
| `CHANNEL_IDS` | No | Fallback channel IDs (use `/addchannel` instead) |
| `PORT` | No | Server port (default: 3000) |
| `DB_PATH` | No | Database path (default: `./data/bugs.db`) |
| `ANTHROPIC_API_KEY` | No** | Anthropic API key for AI analysis |
| `DASHBOARD_PASSWORD` | No*** | Password to protect dashboard viewing |
| `ADMIN_PASSWORD` | No*** | Password to protect admin operations |
| `GUILD_ID` | No | Discord server ID (faster slash command registration) |

*Can also be provided via `discord_token` file  
**Can also be provided via `anthropic_key` file. Without this, falls back to keyword-based detection.  
***Recommended for production deployments

## How It Works

### Bug Detection

The bot tracks any message that starts with `▶️`:

```
▶️ The chat window doesn't scroll properly on mobile
```

### Status Updates

When someone replies to a tracked bug with keywords, the status auto-updates:

| Keywords | Result |
|----------|--------|
| "fixed", ✅ | Bug marked as Fixed ✅ |

### Dashboard

- Shows all bugs sorted by newest first
- Click stat cards or use filter buttons to filter by status
- Click "→ Discord" to jump to the original message
- Auto-refreshes every 30 seconds

## Deploy to Railway

1. Push this project to a GitHub repository
2. Go to [Railway](https://railway.app) and create a new project
3. Select "Deploy from GitHub repo" and choose your repo
4. Add environment variables:
   - `DISCORD_TOKEN`: Your bot token
   - `PORT`: `3000`
   - `DB_PATH`: `/data/bugs.db`
5. **Add a Persistent Volume** (critical!):
   - Mount Path: `/data`
   - Size: 500 MB

Your URL will be: `https://your-project.up.railway.app/`

> 📖 **See [SETUP.md](./SETUP.md) for detailed Railway deployment instructions**

## Architecture

```
┌─────────────────┐
│   Discord API   │
└────────┬────────┘
         │
         ▼
┌─────────────────┐     ┌──────────────────┐
│   Bot (bot.ts)  │────▶│ Slash Commands   │
│   Monitors &    │     │ /addchannel etc. │
│   detects bugs  │     └──────────────────┘
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  SQLite (db.ts) │ ← Stores bugs, channels & updates
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Web (server.ts) │ ← Serves dashboard & REST API
└─────────────────┘
```

## API Endpoints

The dashboard uses a REST API that can connect to any frontend:

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/bugs` | GET | List all bugs |
| `/api/bugs/:id` | GET | Get single bug |
| `/api/stats` | GET | Get statistics |
| `/health` | GET | Health check |

## License

MIT
