/**
 * Simple SQLite database for bug tracking
 */

import Database from 'better-sqlite3'
import { existsSync, mkdirSync } from 'fs'
import { dirname } from 'path'

export type BugType = 'bug' | 'request'

export interface Bug {
  id: number
  discord_message_id: string
  channel_id: string
  channel_name: string
  author_id: string
  author_name: string
  content: string
  type: BugType
  status: 'open' | 'fixed'
  created_at: string
  updated_at: string
  discord_url: string
  reactions: Reaction[]  // stored as JSON
}

export interface Reaction {
  emoji: string
  count: number
  users: string[]  // usernames who reacted
}

export interface BugUpdate {
  id: number
  bug_id: number
  discord_message_id: string
  author_id: string
  author_name: string
  content: string
  created_at: string
  discord_url: string
  reactions: Reaction[]  // stored as JSON
  attachment_type?: 'screenshot' | 'link' | 'conversation' | null
  attachment_url?: string | null
  attachment_data?: string | null  // For storing base64 images or conversation text
}

export class BugDatabase {
  private db: Database.Database

  constructor(dbPath: string = './data/bugs.db') {
    // Ensure directory exists
    const dir = dirname(dbPath)
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }

    this.db = new Database(dbPath)
    this.init()
  }

  private init() {
    // Create bugs table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS bugs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        discord_message_id TEXT UNIQUE NOT NULL,
        channel_id TEXT NOT NULL,
        channel_name TEXT NOT NULL,
        author_id TEXT NOT NULL,
        author_name TEXT NOT NULL,
        content TEXT NOT NULL,
        status TEXT DEFAULT 'open',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        discord_url TEXT NOT NULL,
        reactions TEXT DEFAULT '[]'
      )
    `)

    // Migration: add reactions column to bugs if missing
    try {
      this.db.exec(`ALTER TABLE bugs ADD COLUMN reactions TEXT DEFAULT '[]'`)
    } catch { /* Column exists */ }

    // Migration: add type column (bug vs request)
    try {
      this.db.exec(`ALTER TABLE bugs ADD COLUMN type TEXT DEFAULT 'bug'`)
    } catch { /* Column exists */ }

    // Create updates table (replies/status changes)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS bug_updates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        bug_id INTEGER NOT NULL,
        discord_message_id TEXT UNIQUE NOT NULL,
        author_id TEXT NOT NULL,
        author_name TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL,
        discord_url TEXT DEFAULT '',
        reactions TEXT DEFAULT '[]',
        FOREIGN KEY (bug_id) REFERENCES bugs(id)
      )
    `)

    // Migration: add new columns if missing
    try {
      this.db.exec(`ALTER TABLE bug_updates ADD COLUMN discord_url TEXT DEFAULT ''`)
    } catch { /* Column exists */ }
    try {
      this.db.exec(`ALTER TABLE bug_updates ADD COLUMN reactions TEXT DEFAULT '[]'`)
    } catch { /* Column exists */ }
    try {
      this.db.exec(`ALTER TABLE bug_updates ADD COLUMN attachment_type TEXT`)
    } catch { /* Column exists */ }
    try {
      this.db.exec(`ALTER TABLE bug_updates ADD COLUMN attachment_url TEXT`)
    } catch { /* Column exists */ }
    try {
      this.db.exec(`ALTER TABLE bug_updates ADD COLUMN attachment_data TEXT`)
    } catch { /* Column exists */ }

    // Create indexes
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_bugs_status ON bugs(status);
      CREATE INDEX IF NOT EXISTS idx_bugs_channel ON bugs(channel_id);
      CREATE INDEX IF NOT EXISTS idx_updates_bug ON bug_updates(bug_id);
    `)

    // Create scan state table (tracks last scanned timestamp per channel)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS scan_state (
        channel_id TEXT PRIMARY KEY,
        last_message_id TEXT NOT NULL,
        last_scan_at TEXT NOT NULL
      )
    `)

    // Create monitored channels table (for slash command management)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS monitored_channels (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id TEXT NOT NULL,
        channel_id TEXT NOT NULL UNIQUE,
        channel_name TEXT NOT NULL,
        added_by_user_id TEXT NOT NULL,
        added_by_username TEXT NOT NULL,
        added_at TEXT NOT NULL
      )
    `)

    // Create index for efficient guild-based lookups
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_monitored_channels_guild ON monitored_channels(guild_id)
    `)
  }

  /**
   * Add a new bug or request
   */
  addBug(bug: Omit<Bug, 'id'>): Bug | null {
    try {
      const stmt = this.db.prepare(`
        INSERT INTO bugs (discord_message_id, channel_id, channel_name, author_id, author_name, content, type, status, created_at, updated_at, discord_url, reactions)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      
      const result = stmt.run(
        bug.discord_message_id,
        bug.channel_id,
        bug.channel_name,
        bug.author_id,
        bug.author_name,
        bug.content,
        bug.type || 'bug',
        bug.status,
        bug.created_at,
        bug.updated_at,
        bug.discord_url,
        JSON.stringify(bug.reactions || [])
      )

      return this.getBugById(result.lastInsertRowid as number)
    } catch (error: any) {
      // Duplicate message ID - already tracked
      if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
        return null
      }
      throw error
    }
  }

  /**
   * Add an update to a bug (reply, status change)
   */
  addBugUpdate(update: Omit<BugUpdate, 'id'>): BugUpdate | null {
    try {
      const stmt = this.db.prepare(`
        INSERT INTO bug_updates (bug_id, discord_message_id, author_id, author_name, content, created_at, discord_url, reactions, attachment_type, attachment_url, attachment_data)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      
      const result = stmt.run(
        update.bug_id,
        update.discord_message_id,
        update.author_id,
        update.author_name,
        update.content,
        update.created_at,
        update.discord_url,
        JSON.stringify(update.reactions),
        update.attachment_type || null,
        update.attachment_url || null,
        update.attachment_data || null
      )

      // Update the bug's updated_at timestamp
      this.db.prepare(`UPDATE bugs SET updated_at = ? WHERE id = ?`).run(update.created_at, update.bug_id)

      return {
        id: result.lastInsertRowid as number,
        ...update
      }
    } catch (error: any) {
      if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
        return null
      }
      throw error
    }
  }

  /**
   * Update reactions on an existing update
   */
  updateUpdateReactions(discordMessageId: string, reactions: Reaction[]): void {
    const stmt = this.db.prepare(`UPDATE bug_updates SET reactions = ? WHERE discord_message_id = ?`)
    stmt.run(JSON.stringify(reactions), discordMessageId)
  }

  /**
   * Get bug ID from an update's message ID (for reply chain tracking)
   */
  getBugIdFromUpdateMessage(discordMessageId: string): number | null {
    const stmt = this.db.prepare(`SELECT bug_id FROM bug_updates WHERE discord_message_id = ?`)
    const result = stmt.get(discordMessageId) as { bug_id: number } | undefined
    return result?.bug_id || null
  }

  /**
   * Update reactions on a bug
   */
  updateBugReactions(discordMessageId: string, reactions: Reaction[]): void {
    const stmt = this.db.prepare(`UPDATE bugs SET reactions = ? WHERE discord_message_id = ?`)
    stmt.run(JSON.stringify(reactions), discordMessageId)
  }

  /**
   * Update bug status
   */
  updateBugStatus(bugId: number, status: Bug['status']): void {
    const stmt = this.db.prepare(`UPDATE bugs SET status = ?, updated_at = ? WHERE id = ?`)
    stmt.run(status, new Date().toISOString(), bugId)
  }

  /**
   * Update bug content and/or type (admin edit)
   */
  updateBug(bugId: number, updates: { content?: string; type?: BugType; status?: Bug['status'] }): Bug | null {
    const fields: string[] = []
    const params: any[] = []

    if (updates.content !== undefined) {
      fields.push('content = ?')
      params.push(updates.content)
    }
    if (updates.type !== undefined) {
      fields.push('type = ?')
      params.push(updates.type)
    }
    if (updates.status !== undefined) {
      fields.push('status = ?')
      params.push(updates.status)
    }

    if (fields.length === 0) return this.getBugById(bugId)

    fields.push('updated_at = ?')
    params.push(new Date().toISOString())
    params.push(bugId)

    const stmt = this.db.prepare(`UPDATE bugs SET ${fields.join(', ')} WHERE id = ?`)
    stmt.run(...params)

    return this.getBugById(bugId)
  }

  /**
   * Delete a bug and its updates
   */
  deleteBug(bugId: number): boolean {
    const bug = this.getBugById(bugId)
    if (!bug) return false

    // Delete associated updates first
    this.db.prepare(`DELETE FROM bug_updates WHERE bug_id = ?`).run(bugId)
    // Delete the bug
    this.db.prepare(`DELETE FROM bugs WHERE id = ?`).run(bugId)
    
    return true
  }

  /**
   * Delete all bugs from a specific channel (and their updates)
   * Returns the number of bugs deleted
   */
  deleteBugsByChannel(channelId: string): number {
    // First, get all bug IDs for this channel
    const bugs = this.db.prepare(`SELECT id FROM bugs WHERE channel_id = ?`).all(channelId) as { id: number }[]
    
    if (bugs.length === 0) return 0

    // Delete all updates for these bugs
    const bugIds = bugs.map(b => b.id)
    const placeholders = bugIds.map(() => '?').join(',')
    this.db.prepare(`DELETE FROM bug_updates WHERE bug_id IN (${placeholders})`).run(...bugIds)
    
    // Delete all bugs from this channel
    const result = this.db.prepare(`DELETE FROM bugs WHERE channel_id = ?`).run(channelId)
    
    return result.changes
  }

  /**
   * Parse bug row and convert reactions JSON
   */
  private parseBugRow(row: any): Bug | null {
    if (!row) return null
    return {
      ...row,
      type: row.type || 'bug',  // Default to 'bug' for old records
      reactions: JSON.parse(row.reactions || '[]')
    }
  }

  /**
   * Get bug by ID
   */
  getBugById(id: number): Bug | null {
    const stmt = this.db.prepare(`SELECT * FROM bugs WHERE id = ?`)
    return this.parseBugRow(stmt.get(id))
  }

  /**
   * Get bug by Discord message ID
   */
  getBugByMessageId(messageId: string): Bug | null {
    const stmt = this.db.prepare(`SELECT * FROM bugs WHERE discord_message_id = ?`)
    return this.parseBugRow(stmt.get(messageId))
  }

  /**
   * Get all bugs (with optional filters)
   */
  getAllBugs(options: { status?: Bug['status']; type?: BugType; channelId?: string; limit?: number } = {}): Bug[] {
    let query = `SELECT * FROM bugs WHERE 1=1`
    const params: any[] = []

    if (options.status) {
      query += ` AND status = ?`
      params.push(options.status)
    }

    if (options.type) {
      query += ` AND type = ?`
      params.push(options.type)
    }

    if (options.channelId) {
      query += ` AND channel_id = ?`
      params.push(options.channelId)
    }

    query += ` ORDER BY created_at DESC`

    if (options.limit) {
      query += ` LIMIT ?`
      params.push(options.limit)
    }

    const stmt = this.db.prepare(query)
    const rows = stmt.all(...params) as any[]
    return rows.map(row => this.parseBugRow(row)!)
  }

  /**
   * Get updates for a bug
   */
  getBugUpdates(bugId: number): BugUpdate[] {
    const stmt = this.db.prepare(`SELECT * FROM bug_updates WHERE bug_id = ? ORDER BY created_at ASC`)
    const rows = stmt.all(bugId) as any[]
    
    // Parse reactions JSON
    return rows.map(row => ({
      ...row,
      reactions: JSON.parse(row.reactions || '[]')
    }))
  }

  /**
   * Get total count of all updates (efficient for stats)
   */
  getTotalUpdateCount(): number {
    const stmt = this.db.prepare(`SELECT COUNT(*) as count FROM bug_updates`)
    const result = stmt.get() as { count: number }
    return result.count
  }

  /**
   * Get open bugs (for matching completions)
   */
  getOpenBugs(): Bug[] {
    const stmt = this.db.prepare(`SELECT * FROM bugs WHERE status = 'open' ORDER BY updated_at DESC`)
    const rows = stmt.all() as any[]
    return rows.map(row => this.parseBugRow(row)!)
  }

  /**
   * Get recently active bugs (for context matching)
   */
  getRecentlyActiveBugs(channelId: string, limit: number = 5): Bug[] {
    const stmt = this.db.prepare(`
      SELECT * FROM bugs 
      WHERE channel_id = ? AND status = 'open'
      ORDER BY updated_at DESC 
      LIMIT ?
    `)
    const rows = stmt.all(channelId, limit) as any[]
    return rows.map(row => this.parseBugRow(row)!)
  }

  /**
   * Get stats
   */
  getStats(): { 
    total: number
    open: number
    fixed: number
    bugs: { total: number; open: number; fixed: number }
    requests: { total: number; open: number; fixed: number }
  } {
    const stats = this.db.prepare(`
      SELECT 
        COUNT(*) as total,
        SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) as open,
        SUM(CASE WHEN status = 'fixed' THEN 1 ELSE 0 END) as fixed,
        SUM(CASE WHEN type = 'bug' THEN 1 ELSE 0 END) as bugs_total,
        SUM(CASE WHEN type = 'bug' AND status = 'open' THEN 1 ELSE 0 END) as bugs_open,
        SUM(CASE WHEN type = 'bug' AND status = 'fixed' THEN 1 ELSE 0 END) as bugs_fixed,
        SUM(CASE WHEN type = 'request' THEN 1 ELSE 0 END) as requests_total,
        SUM(CASE WHEN type = 'request' AND status = 'open' THEN 1 ELSE 0 END) as requests_open,
        SUM(CASE WHEN type = 'request' AND status = 'fixed' THEN 1 ELSE 0 END) as requests_fixed
      FROM bugs
    `).get() as any

    return {
      total: stats.total || 0,
      open: stats.open || 0,
      fixed: stats.fixed || 0,
      bugs: {
        total: stats.bugs_total || 0,
        open: stats.bugs_open || 0,
        fixed: stats.bugs_fixed || 0
      },
      requests: {
        total: stats.requests_total || 0,
        open: stats.requests_open || 0,
        fixed: stats.requests_fixed || 0
      }
    }
  }

  /**
   * Save the last scanned message ID for a channel
   */
  saveScanState(channelId: string, lastMessageId: string): void {
    const stmt = this.db.prepare(`
      INSERT INTO scan_state (channel_id, last_message_id, last_scan_at)
      VALUES (?, ?, ?)
      ON CONFLICT(channel_id) DO UPDATE SET
        last_message_id = excluded.last_message_id,
        last_scan_at = excluded.last_scan_at
    `)
    stmt.run(channelId, lastMessageId, new Date().toISOString())
  }

  /**
   * Get the last scanned message ID for a channel
   */
  getScanState(channelId: string): { lastMessageId: string; lastScanAt: string } | null {
    const stmt = this.db.prepare(`SELECT last_message_id, last_scan_at FROM scan_state WHERE channel_id = ?`)
    const result = stmt.get(channelId) as { last_message_id: string; last_scan_at: string } | undefined
    if (!result) return null
    return {
      lastMessageId: result.last_message_id,
      lastScanAt: result.last_scan_at
    }
  }

  /**
   * Get all scan states (for shutdown save)
   */
  getAllScanStates(): Map<string, string> {
    const stmt = this.db.prepare(`SELECT channel_id, last_message_id FROM scan_state`)
    const rows = stmt.all() as { channel_id: string; last_message_id: string }[]
    const map = new Map<string, string>()
    for (const row of rows) {
      map.set(row.channel_id, row.last_message_id)
    }
    return map
  }

  // =========================================
  // Monitored Channels Management
  // =========================================

  /**
   * Add a channel to monitor for a guild
   */
  addMonitoredChannel(data: {
    guildId: string
    channelId: string
    channelName: string
    addedByUserId: string
    addedByUsername: string
  }): boolean {
    try {
      const stmt = this.db.prepare(`
        INSERT INTO monitored_channels (guild_id, channel_id, channel_name, added_by_user_id, added_by_username, added_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `)
      stmt.run(
        data.guildId,
        data.channelId,
        data.channelName,
        data.addedByUserId,
        data.addedByUsername,
        new Date().toISOString()
      )
      return true
    } catch (error: any) {
      if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
        return false // Channel already monitored
      }
      throw error
    }
  }

  /**
   * Remove a channel from monitoring
   */
  removeMonitoredChannel(channelId: string): boolean {
    const stmt = this.db.prepare(`DELETE FROM monitored_channels WHERE channel_id = ?`)
    const result = stmt.run(channelId)
    return result.changes > 0
  }

  /**
   * Get all monitored channels for a guild
   */
  getMonitoredChannels(guildId?: string): Array<{
    id: number
    guild_id: string
    channel_id: string
    channel_name: string
    added_by_user_id: string
    added_by_username: string
    added_at: string
  }> {
    if (guildId) {
      const stmt = this.db.prepare(`SELECT * FROM monitored_channels WHERE guild_id = ? ORDER BY added_at DESC`)
      return stmt.all(guildId) as any[]
    }
    const stmt = this.db.prepare(`SELECT * FROM monitored_channels ORDER BY added_at DESC`)
    return stmt.all() as any[]
  }

  /**
   * Get all monitored channel IDs (for bot startup)
   */
  getAllMonitoredChannelIds(): string[] {
    const stmt = this.db.prepare(`SELECT channel_id FROM monitored_channels`)
    const rows = stmt.all() as { channel_id: string }[]
    return rows.map(r => r.channel_id)
  }

  /**
   * Check if a channel is monitored
   */
  isChannelMonitored(channelId: string): boolean {
    const stmt = this.db.prepare(`SELECT 1 FROM monitored_channels WHERE channel_id = ?`)
    return !!stmt.get(channelId)
  }

  close() {
    this.db.close()
  }
}
