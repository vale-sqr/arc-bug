# Arc Bug Tracker - Complete Setup Guide

This guide will walk you through setting up the Arc Bug Tracker from scratch, whether you want to run it locally or deploy it to the cloud.

---

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [Creating a Discord Bot](#creating-a-discord-bot)
3. [Running Locally](#running-locally)
4. [Deploying to Railway](#deploying-to-railway)
5. [Configuring Channels](#configuring-channels)
6. [Optional: AI-Powered Analysis](#optional-ai-powered-analysis)
7. [Using the Dashboard](#using-the-dashboard)
8. [Bot Commands Reference](#bot-commands-reference)
9. [Future: Custom Domain Setup](#future-custom-domain-setup)
10. [Troubleshooting](#troubleshooting)

---

## Prerequisites

- **Node.js 20+** - [Download here](https://nodejs.org/)
- **A Discord Account** with a server you manage
- **Git** (optional, for cloning)

---

## Creating a Discord Bot

### Step 1: Create Application

1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. Click **"New Application"**
3. Name it (e.g., "Arc Bug Tracker")
4. Click **"Create"**

### Step 2: Configure Bot

1. Go to the **"Bot"** tab in the left sidebar
2. Click **"Add Bot"** → **"Yes, do it!"**
3. Under **"Privileged Gateway Intents"**, enable:
   - ✅ **MESSAGE CONTENT INTENT** (required to read message content)
4. Click **"Reset Token"** and copy the token
   - ⚠️ **Keep this secret!** Never share or commit this token.

### Step 3: Invite Bot to Your Server

1. Go to **"OAuth2"** → **"URL Generator"**
2. Select scopes:
   - ✅ `bot`
   - ✅ `applications.commands` (required for slash commands)
3. Select bot permissions:
   - ✅ Read Messages/View Channels
   - ✅ Read Message History
   - ✅ Send Messages
   - ✅ Use Slash Commands
4. Copy the generated URL and open it in your browser
5. Select your server and authorize the bot

---

## Running Locally

This is the simplest way to get started. The dashboard will be accessible at `http://localhost:3000`.

### Step 1: Clone & Install

```bash
# Clone the repository (or download and extract)
git clone https://github.com/YOUR_USERNAME/arc-bug-tracker.git
cd arc-bug-tracker

# Install dependencies
npm install
```

### Step 2: Configure

Create a `discord_token` file with your bot token:

```bash
echo "YOUR_BOT_TOKEN_HERE" > discord_token
```

Or use environment variables:

```bash
export DISCORD_TOKEN="YOUR_BOT_TOKEN_HERE"
```

### Step 3: Run

```bash
# Development mode (with hot reload)
npm run dev

# Or build and run production
npm run build
npm start
```

### Step 4: Access Dashboard

Open `http://localhost:3000` in your browser!

### Step 5: Configure Channels

In Discord, use the slash command:
```
/addchannel #your-bug-channel
```

The bot will now monitor that channel for bug reports.

---

## Deploying to Railway

Railway provides free hosting with persistent storage - perfect for keeping your bug database alive.

### Step 1: Push to GitHub

1. Create a new GitHub repository
2. Push your code:

```bash
git remote add origin https://github.com/YOUR_USERNAME/arc-bug-tracker.git
git push -u origin main
```

### Step 2: Create Railway Project

1. Go to [Railway](https://railway.app)
2. Click **"New Project"**
3. Select **"Deploy from GitHub repo"**
4. Choose your repository

### Step 3: Configure Environment Variables

In the Railway dashboard, go to **Variables** and add:

| Variable | Value | Required |
|----------|-------|----------|
| `DISCORD_TOKEN` | Your bot token | ✅ Yes |
| `PORT` | `3000` | ✅ Yes |
| `DB_PATH` | `/data/bugs.db` | ✅ Yes |
| `DASHBOARD_PASSWORD` | Any secure password | Recommended |
| `ADMIN_PASSWORD` | Any secure password | Recommended |
| `ANTHROPIC_API_KEY` | Your Anthropic API key | Optional |
| `GUILD_ID` | Your Discord server ID | Optional (faster commands) |

### Step 4: Add Persistent Volume

**⚠️ Critical - Without this, your data will be lost on every deploy!**

1. In Railway, go to **Settings** → **Volumes**
2. Click **"+ New Volume"**
3. Set **Mount Path**: `/data`
4. Set **Size**: `500 MB` (plenty for bug tracking)

### Step 5: Deploy

Railway will automatically deploy when you push to GitHub. Your dashboard URL will be:
```
https://YOUR-PROJECT-NAME.up.railway.app
```

---

## Configuring Channels

The bot uses **slash commands** to manage which channels to monitor. No need to set environment variables!

### Add a Channel

```
/addchannel #channel-name
```

Only users with "Manage Channels" permission can use this command.

### Remove a Channel

```
/removechannel #channel-name
```

### List Monitored Channels

```
/listchannels
```

---

## Optional: AI-Powered Analysis

The bot can use Claude AI to intelligently:
- Match bug completions to the correct bug
- Determine if contextual messages relate to bugs

### Setup

1. Get an API key from [Anthropic](https://console.anthropic.com/)
2. Create an `anthropic_key` file:

```bash
echo "sk-ant-..." > anthropic_key
```

Or set the environment variable:

```bash
export ANTHROPIC_API_KEY="sk-ant-..."
```

Without AI, the bot falls back to keyword-based detection (still works well!).

---

## Using the Dashboard

### Main Dashboard (`/`)

- View all bugs sorted by newest first
- Filter by status (Open, Fixed, All)
- Click stat cards to filter
- Each bug shows:
  - Original content
  - Discord link to jump to message
  - Replies and context
  - Reactions

### Admin Dashboard (`/admin`)

Requires `ADMIN_PASSWORD` to be set. Allows:
- Editing bug content
- Changing bug status
- Deleting bugs
- Viewing system stats

### Password Protection

Set these environment variables to protect your dashboards:

```bash
# Protects viewing the main dashboard
export DASHBOARD_PASSWORD="your-view-password"

# Protects admin operations
export ADMIN_PASSWORD="your-admin-password"
```

---

## Bot Commands Reference

| Command | Description | Permission |
|---------|-------------|------------|
| `/addchannel #channel` | Start monitoring a channel | Manage Channels |
| `/removechannel #channel` | Stop monitoring a channel | Manage Channels |
| `/listchannels` | List all monitored channels | Everyone |
| `/recentbugs [count] [status]` | Show recent bugs with Discord links | Everyone |

### Bug Reporting Format

Messages starting with `▶️` are tracked as bugs:

```
▶️ The sidebar doesn't scroll on mobile devices
```

Messages containing `✅` mark bugs as fixed:

```
✅ Fixed the sidebar scrolling issue
```

Or simply reply with ✅ to any bug message.

---

## Future: Custom Domain Setup

The architecture is designed for easy transition to a custom domain:

### Current Architecture

```
┌─────────────────┐
│  Discord Bot    │ ← Monitors channels
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│    SQLite DB    │ ← Stores bugs
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  Express API    │ ← Serves dashboard + API
└─────────────────┘
```

### API Endpoints

The dashboard uses a clean REST API that can easily connect to any frontend:

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/bugs` | GET | List all bugs |
| `/api/bugs/:id` | GET | Get single bug |
| `/api/stats` | GET | Get statistics |
| `/api/bugs/:id/context` | POST | Add context to bug |
| `/health` | GET | Health check |

### Transitioning to Custom Domain

1. **Option A: Reverse Proxy**
   - Point your domain to Railway/your server
   - Railway supports custom domains natively

2. **Option B: Separate Frontend**
   - Build a custom frontend (React, Vue, etc.)
   - Connect to the API endpoints
   - The bot/API can run headless

3. **Option C: Full Migration**
   - Export bug data from SQLite
   - Import to a managed database (Postgres, etc.)
   - The API structure remains the same

The SQLite database is easily exportable and the API is stateless, making migration straightforward.

---

## Troubleshooting

### Bot not responding to messages

1. Check **MESSAGE CONTENT INTENT** is enabled in Discord Developer Portal
2. Verify the bot has permission to read the channel
3. Check if the channel is added via `/listchannels`

### Slash commands not appearing

1. It can take up to 1 hour for global commands to appear
2. For faster testing, set `GUILD_ID` to your server ID
3. Re-invite the bot with `applications.commands` scope

### Database errors on Railway

1. Make sure you added a persistent volume
2. Verify `DB_PATH` is set to `/data/bugs.db`

### Dashboard shows "Unauthorized"

1. Set `DASHBOARD_PASSWORD` environment variable
2. Clear browser cache and try again

### Bot token errors

1. Reset your token in Discord Developer Portal
2. Update the `discord_token` file or environment variable
3. Make sure there are no extra spaces/newlines

---

## Support

If you encounter issues:

1. Check the logs (`npm run dev` shows detailed output)
2. Verify all environment variables are set correctly
3. Make sure the bot has proper Discord permissions

Happy bug tracking! 🐛
