/**
 * Arc Bug Tracker - Main Entry Point
 * 
 * Monitors Discord channels for bug reports and displays them on a dashboard.
 */

import { readFileSync, existsSync } from 'fs'
import { BugDatabase } from './db.js'
import { BugTrackerBot } from './bot.js'
import { createServer } from './server.js'
import { MessageAnalyzer } from './analyzer.js'

async function main() {
  console.log('═══════════════════════════════════════')
  console.log('  🐛 Arc Bug Tracker')
  console.log('═══════════════════════════════════════')
  console.log()

  // Load configuration from environment or files
  let discordToken = process.env.DISCORD_TOKEN
  
  // Try loading from file if not in env
  if (!discordToken && existsSync('./discord_token')) {
    discordToken = readFileSync('./discord_token', 'utf-8').trim()
  }

  if (!discordToken) {
    console.error('❌ Error: No Discord token found!')
    console.error('   Set DISCORD_TOKEN env var or create a discord_token file')
    process.exit(1)
  }

  // Load Anthropic API key for AI analysis
  let anthropicApiKey = process.env.ANTHROPIC_API_KEY
  
  // Try loading from file if not in env
  if (!anthropicApiKey && existsSync('./anthropic_key')) {
    anthropicApiKey = readFileSync('./anthropic_key', 'utf-8').trim()
  }


  // Server port
  const port = parseInt(process.env.PORT || '3000')
  
  // API secret for write operations (optional)
  const apiSecret = process.env.API_SECRET

  // Admin password for dashboard management (optional)
  let adminPassword = process.env.ADMIN_PASSWORD
  if (!adminPassword && existsSync('./admin_password')) {
    adminPassword = readFileSync('./admin_password', 'utf-8').trim()
  }

  // Dashboard password for viewing (optional)
  let dashboardPassword = process.env.DASHBOARD_PASSWORD
  if (!dashboardPassword && existsSync('./dashboard_password')) {
    dashboardPassword = readFileSync('./dashboard_password', 'utf-8').trim()
  }

  // Database path
  const dbPath = process.env.DB_PATH || './data/bugs.db'

  // Initialize database
  console.log(`📁 Database: ${dbPath}`)
  const db = new BugDatabase(dbPath)

  // Initialize AI analyzer if API key is available
  let analyzer: MessageAnalyzer | undefined
  if (anthropicApiKey) {
    analyzer = new MessageAnalyzer(anthropicApiKey)
    console.log(`🤖 AI Analysis: Enabled (Claude Haiku)`)
  } else {
    console.log(`⚠️  AI Analysis: Disabled (no ANTHROPIC_API_KEY)`)
    console.log(`   Set ANTHROPIC_API_KEY env var or create anthropic_key file to enable`)
  }

  // Start web server FIRST so healthcheck passes quickly
  const server = createServer({ port, apiSecret, adminPassword, dashboardPassword }, db)
  
  if (adminPassword) {
    console.log(`🔐 Admin mode: Enabled (password protected)`)
  } else {
    console.log(`⚠️  Admin mode: Disabled (no ADMIN_PASSWORD set)`)
  }

  if (dashboardPassword) {
    console.log(`🔒 Dashboard: Password protected`)
  } else {
    console.log(`⚠️  Dashboard: Public (no DASHBOARD_PASSWORD set)`)
  }

  // Optional: Guild ID for faster slash command registration (during development)
  const guildId = process.env.GUILD_ID

  // Initialize and start bot (after server is up)
  const bot = new BugTrackerBot({
    token: discordToken,
    channelIds: channelIds.length > 0 ? channelIds : undefined,
    guildId,
  }, db, analyzer)

  await bot.start()

  // Check if we have any channels to monitor
  const monitoredChannels = db.getAllMonitoredChannelIds()
  const hasChannels = monitoredChannels.length > 0 || (channelIds && channelIds.length > 0)

  // Scan existing messages
  // SCAN_SINCE_DATE: ISO date string (e.g., "2025-01-01") - for initial setup in existing channels
  // If not set, will resume from last saved position (or skip if first run)
  const scanSinceDate = process.env.SCAN_SINCE_DATE
  
  if (hasChannels) {
    if (scanSinceDate) {
      const sinceDate = new Date(scanSinceDate)
      if (isNaN(sinceDate.getTime())) {
        console.error(`❌ Invalid SCAN_SINCE_DATE: ${scanSinceDate}`)
        console.error('   Use ISO format like: 2025-01-01 or 2025-01-01T00:00:00Z')
      } else {
        console.log(`📅 Scanning messages since: ${sinceDate.toISOString()}`)
        await bot.scanExistingMessages({ sinceDate, resumeFromSaved: false })
      }
    } else {
      // Resume from saved position (or start fresh if first run)
      await bot.scanExistingMessages({ resumeFromSaved: true })
    }
  } else {
    console.log('⚠️  No channels configured yet - use /addchannel in Discord to add channels')
  }

  // Sync reactions on open bugs (catches ✅ reactions added while bot was offline)
  if (hasChannels) {
    await bot.syncReactionsOnOpenBugs()
  }

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    console.log(`\n${signal} received, shutting down...`)
    
    // Save current scan position so we can resume later
    await bot.saveCurrentPosition()
    
    await bot.stop()
    server.close()
    db.close()
    process.exit(0)
  }

  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))

  console.log()
  console.log('═══════════════════════════════════════')
  console.log('  ✅ Bug tracker is running!')
  console.log('═══════════════════════════════════════')
}

main().catch(error => {
  console.error('Fatal error:', error)
  process.exit(1)
})
