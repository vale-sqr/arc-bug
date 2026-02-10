/**
 * Simple web server for the bug dashboard
 */

import express, { Request, Response } from 'express'
import { BugDatabase } from './db.js'
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

export interface ServerConfig {
  port: number
  apiSecret?: string  // Optional: for bot write operations
  adminPassword?: string  // Optional: for admin dashboard operations
  dashboardPassword?: string  // Optional: for dashboard viewing
}

export function createServer(config: ServerConfig, db: BugDatabase) {
  const app = express()
  
  app.use(express.json())

  // Helper: Check dashboard auth
  function checkDashboardAuth(req: Request): boolean {
    if (!config.dashboardPassword) return true // No password required
    const auth = req.headers['x-dashboard-password']
    return auth === config.dashboardPassword
  }

  // Serve static dashboard
  app.get('/', (_req: Request, res: Response) => {
    try {
      const html = readFileSync(join(__dirname, '../public/index.html'), 'utf-8')
      res.type('html').send(html)
    } catch {
      res.status(500).send('Dashboard not found')
    }
  })

  // API: Get all bugs (with updates included) - requires dashboard auth if password is set
  app.get('/api/bugs', (req: Request, res: Response) => {
    if (!checkDashboardAuth(req)) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }

    const statusParam = req.query.status
    const typeParam = req.query.type
    const channelParam = req.query.channel
    const limitParam = req.query.limit

    const status = typeof statusParam === 'string' ? statusParam : undefined
    const type = typeof typeParam === 'string' ? typeParam : undefined
    const channelId = typeof channelParam === 'string' ? channelParam : undefined
    const limit = typeof limitParam === 'string' ? parseInt(limitParam) : undefined

    const bugs = db.getAllBugs({
      status: status as any,
      type: type as any,
      channelId,
      limit
    })

    // Include updates and involved people for each bug
    const bugsWithUpdates = bugs.map(bug => {
      const updates = db.getBugUpdates(bug.id)
      
      // Collect unique people involved (author + anyone who replied)
      const involvedSet = new Set<string>()
      involvedSet.add(bug.author_name)
      for (const update of updates) {
        involvedSet.add(update.author_name)
      }
      const involved = Array.from(involvedSet)

      return {
        ...bug,
        updates,
        involved
      }
    })

    res.json(bugsWithUpdates)
  })

  // API: Get single bug with updates - requires dashboard auth if password is set
  app.get('/api/bugs/:id', (req: Request<{ id: string }>, res: Response) => {
    if (!checkDashboardAuth(req)) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }

    const bug = db.getBugById(parseInt(req.params.id))
    if (!bug) {
      res.status(404).json({ error: 'Bug not found' })
      return
    }

    const updates = db.getBugUpdates(bug.id)
    res.json({ ...bug, updates })
  })

  // API: Get stats - requires dashboard auth if password is set
  app.get('/api/stats', (req: Request, res: Response) => {
    if (!checkDashboardAuth(req)) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }

    const stats = db.getStats()
    res.json(stats)
  })

  // API: Get monitored channels - requires dashboard auth if password is set
  app.get('/api/channels', (req: Request, res: Response) => {
    if (!checkDashboardAuth(req)) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }

    const channels = db.getMonitoredChannels()
    res.json(channels)
  })

  // Helper: Check admin auth
  function checkAdminAuth(req: Request): boolean {
    if (!config.adminPassword) return true // No password required
    const auth = req.headers['x-admin-password']
    return auth === config.adminPassword
  }

  // API: Verify dashboard password
  app.post('/api/dashboard/verify', (req: Request, res: Response) => {
    const { password } = req.body
    if (!config.dashboardPassword) {
      res.json({ valid: true, message: 'No password required' })
      return
    }
    if (password === config.dashboardPassword) {
      res.json({ valid: true })
    } else {
      res.status(401).json({ valid: false, error: 'Invalid password' })
    }
  })

  // API: Verify admin password
  app.post('/api/admin/verify', (req: Request, res: Response) => {
    const { password } = req.body
    if (!config.adminPassword) {
      res.json({ valid: true, message: 'No password required' })
      return
    }
    if (password === config.adminPassword) {
      res.json({ valid: true })
    } else {
      res.status(401).json({ valid: false, error: 'Invalid password' })
    }
  })

  // API: Update bug status (requires secret for bot, or admin password)
  app.patch('/api/bugs/:id', (req: Request<{ id: string }>, res: Response) => {
    // Check authorization - allow bot secret OR admin password
    const botAuth = req.headers.authorization
    const isBotAuthed = config.apiSecret && botAuth === `Bearer ${config.apiSecret}`
    const isAdminAuthed = checkAdminAuth(req)

    if (!isBotAuthed && !isAdminAuthed) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }

    const { status } = req.body
    if (!['open', 'fixed'].includes(status)) {
      res.status(400).json({ error: 'Invalid status' })
      return
    }

    db.updateBugStatus(parseInt(req.params.id), status)
    res.json({ success: true })
  })

  // API: Add manual context to a bug (public - no auth required)
  app.post('/api/bugs/:id/context', (req: Request<{ id: string }>, res: Response) => {
    const bugId = parseInt(req.params.id)
    const bug = db.getBugById(bugId)
    
    if (!bug) {
      res.status(404).json({ error: 'Bug not found' })
      return
    }

    const { type, content, url, username } = req.body

    // Validate input
    if (!type || !['screenshot', 'link', 'conversation'].includes(type)) {
      res.status(400).json({ error: 'Invalid attachment type' })
      return
    }

    if (!content && !url) {
      res.status(400).json({ error: 'Content or URL required' })
      return
    }

    // Create a pseudo-message ID for manual entries
    const messageId = `manual-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
    
    const update = db.addBugUpdate({
      bug_id: bugId,
      discord_message_id: messageId,
      author_id: 'manual',
      author_name: username || 'Anonymous',
      content: content || '',
      created_at: new Date().toISOString(),
      discord_url: '',
      reactions: [],
      attachment_type: type as 'screenshot' | 'link' | 'conversation',
      attachment_url: url || null,
      attachment_data: (type === 'screenshot' || type === 'conversation') ? content : null
    })

    if (!update) {
      res.status(500).json({ error: 'Failed to add context' })
      return
    }

    res.json({ success: true, update })
  })

  // API: Admin edit bug (content, type, status)
  app.put('/api/admin/bugs/:id', (req: Request<{ id: string }>, res: Response) => {
    if (!checkAdminAuth(req)) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }

    const { content, type, status } = req.body
    const updates: { content?: string; type?: 'bug' | 'request'; status?: 'open' | 'fixed' } = {}

    if (content !== undefined) {
      if (typeof content !== 'string' || content.trim().length === 0) {
        res.status(400).json({ error: 'Content cannot be empty' })
        return
      }
      updates.content = content.trim()
    }

    if (type !== undefined) {
      if (!['bug', 'request'].includes(type)) {
        res.status(400).json({ error: 'Invalid type' })
        return
      }
      updates.type = type
    }

    if (status !== undefined) {
      if (!['open', 'fixed'].includes(status)) {
        res.status(400).json({ error: 'Invalid status' })
        return
      }
      updates.status = status
    }

    const bug = db.updateBug(parseInt(req.params.id), updates)
    if (!bug) {
      res.status(404).json({ error: 'Bug not found' })
      return
    }

    res.json(bug)
  })

  // API: Admin delete bug
  app.delete('/api/admin/bugs/:id', (req: Request<{ id: string }>, res: Response) => {
    if (!checkAdminAuth(req)) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }

    const deleted = db.deleteBug(parseInt(req.params.id))
    if (!deleted) {
      res.status(404).json({ error: 'Bug not found' })
      return
    }

    res.json({ success: true })
  })

  // Health check
  app.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok' })
  })

  // Track server start time for uptime
  const serverStartTime = Date.now()

  // Helper: Format uptime
  function formatUptime(ms: number): string {
    const seconds = Math.floor(ms / 1000)
    const minutes = Math.floor(seconds / 60)
    const hours = Math.floor(minutes / 60)
    const days = Math.floor(hours / 24)

    if (days > 0) return `${days}d ${hours % 24}h ${minutes % 60}m`
    if (hours > 0) return `${hours}h ${minutes % 60}m ${seconds % 60}s`
    if (minutes > 0) return `${minutes}m ${seconds % 60}s`
    return `${seconds}s`
  }

  // Admin Dashboard Page
  app.get('/admin', (_req: Request, res: Response) => {
    if (!config.adminPassword) {
      res.status(403).send('Admin dashboard is disabled. Set ADMIN_PASSWORD to enable.')
      return
    }

    try {
      const html = readFileSync(join(__dirname, '../public/admin.html'), 'utf-8')
      res.type('html').send(html)
    } catch {
      res.status(500).send('Admin dashboard not found')
    }
  })

  // API: Admin system stats
  app.get('/api/admin/system', (req: Request, res: Response) => {
    if (!checkAdminAuth(req)) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }

    const memUsage = process.memoryUsage()
    const uptime = Date.now() - serverStartTime

    res.json({
      uptime,
      uptimeFormatted: formatUptime(uptime),
      memory: {
        heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024),
        heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024),
        rss: Math.round(memUsage.rss / 1024 / 1024)
      },
      node: {
        version: process.version,
        platform: process.platform,
        arch: process.arch
      },
      config: {
        port: config.port,
        adminEnabled: !!config.adminPassword,
        botSecretSet: !!config.apiSecret
      }
    })
  })

  // API: Admin database stats
  app.get('/api/admin/database', (req: Request, res: Response) => {
    if (!checkAdminAuth(req)) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }

    const stats = db.getStats()
    const allBugs = db.getAllBugs({})
    const scanStates = db.getAllScanStates()

    // Calculate additional metrics
    const channels = new Set(allBugs.map(b => b.channel_id))
    const authors = new Set(allBugs.map(b => b.author_id))
    
    // Recent activity
    const now = Date.now()
    const oneDayAgo = now - 24 * 60 * 60 * 1000
    const oneWeekAgo = now - 7 * 24 * 60 * 60 * 1000
    
    const bugsLast24h = allBugs.filter(b => new Date(b.created_at).getTime() > oneDayAgo).length
    const bugsLastWeek = allBugs.filter(b => new Date(b.created_at).getTime() > oneWeekAgo).length

    // Get total updates efficiently with SQL COUNT
    const totalUpdates = db.getTotalUpdateCount()

    res.json({
      ...stats,
      totalUpdates,
      uniqueChannels: channels.size,
      uniqueAuthors: authors.size,
      bugsLast24h,
      bugsLastWeek,
      monitoredChannels: Array.from(scanStates.keys()).length,
      oldestBug: allBugs.length > 0 ? allBugs[allBugs.length - 1].created_at : null,
      newestBug: allBugs.length > 0 ? allBugs[0].created_at : null
    })
  })

  // API: Admin get all bugs with full data (for table view)
  app.get('/api/admin/bugs/all', (req: Request, res: Response) => {
    if (!checkAdminAuth(req)) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }

    const bugs = db.getAllBugs({})
    
    const bugsWithUpdates = bugs.map(bug => {
      const updates = db.getBugUpdates(bug.id)
      return {
        ...bug,
        updates,
        updateCount: updates.length
      }
    })

    res.json(bugsWithUpdates)
  })

  // Bind to 0.0.0.0 so Railway can reach the server (not just localhost)
  const server = app.listen(config.port, '0.0.0.0', () => {
    console.log(`🌐 Dashboard running at http://0.0.0.0:${config.port}`)
  })

  return server
}
