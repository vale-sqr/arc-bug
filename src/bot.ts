/**
 * Discord bot that monitors channels for bug reports
 * 
 * Detection logic:
 * - ▶️ at start = new bug/feature request
 * - ✅ = completion marker (closes a bug)
 * - Direct replies = added to bug thread
 * - Other messages = AI decides if related to active bug
 * 
 * Slash Commands:
 * - /addchannel - Add a channel to monitor
 * - /removechannel - Remove a channel from monitoring
 * - /listchannels - List all monitored channels
 * - /recentbugs - Show recent bugs with Discord links
 */

import { 
  Client, 
  GatewayIntentBits, 
  Message, 
  TextChannel, 
  MessageReaction, 
  PartialMessageReaction,
  REST,
  Routes,
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  PermissionFlagsBits,
  ChannelType,
  EmbedBuilder
} from 'discord.js'
import { BugDatabase, Bug, Reaction, BugType } from './db.js'
import { MessageAnalyzer } from './analyzer.js'

export interface BotConfig {
  token: string
  channelIds?: string[]  // Optional: fallback channel IDs from env (will be migrated to DB)
  guildId?: string       // Optional: specific guild ID
  clientId?: string      // Required for slash commands
}

// Track recent messages per channel for context
interface RecentMessage {
  id: string
  author: string
  authorId: string
  content: string
  bugId?: number
  timestamp: number
}

// Discord epoch for snowflake conversion (Jan 1, 2015)
const DISCORD_EPOCH = 1420070400000n

/**
 * Convert a Date to a Discord snowflake ID
 * Snowflakes encode timestamps, so we can use this to fetch messages "after" a date
 */
function dateToSnowflake(date: Date): string {
  const timestamp = BigInt(date.getTime())
  const snowflake = (timestamp - DISCORD_EPOCH) << 22n
  return snowflake.toString()
}

// Slash command definitions
const slashCommands = [
  new SlashCommandBuilder()
    .setName('addchannel')
    .setDescription('Add a channel for bug tracking')
    .addChannelOption((option: any) =>
      option.setName('channel')
        .setDescription('The channel to monitor')
        .setRequired(true)
        .addChannelTypes(ChannelType.GuildText)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),
  
  new SlashCommandBuilder()
    .setName('removechannel')
    .setDescription('Remove a channel from bug tracking (preserves existing bugs)')
    .addChannelOption((option: any) =>
      option.setName('channel')
        .setDescription('The channel to stop monitoring')
        .setRequired(true)
        .addChannelTypes(ChannelType.GuildText)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),
  
  new SlashCommandBuilder()
    .setName('deletechannel')
    .setDescription('Remove a channel AND delete all bugs recorded from it')
    .addChannelOption((option: any) =>
      option.setName('channel')
        .setDescription('The channel to remove with all its bugs')
        .setRequired(true)
        .addChannelTypes(ChannelType.GuildText)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),
  
  new SlashCommandBuilder()
    .setName('listchannels')
    .setDescription('List all channels being monitored for bugs'),
  
  new SlashCommandBuilder()
    .setName('recentbugs')
    .setDescription('Show recent bugs with Discord links')
    .addIntegerOption((option: any) =>
      option.setName('count')
        .setDescription('Number of bugs to show (default: 5, max: 10)')
        .setRequired(false)
        .setMinValue(1)
        .setMaxValue(10)
    )
    .addStringOption((option: any) =>
      option.setName('status')
        .setDescription('Filter by status')
        .setRequired(false)
        .addChoices(
          { name: 'All', value: 'all' },
          { name: 'Open', value: 'open' },
          { name: 'Fixed', value: 'fixed' }
        )
    ),
]

export class BugTrackerBot {
  private client: Client
  private db: BugDatabase
  private config: BotConfig
  private ready = false
  private analyzer: MessageAnalyzer | null = null
  
  // Recent messages cache per channel (for context)
  private recentMessages: Map<string, RecentMessage[]> = new Map()
  private readonly MAX_RECENT_MESSAGES = 10

  constructor(config: BotConfig, db: BugDatabase, analyzer?: MessageAnalyzer) {
    this.config = config
    this.db = db
    this.analyzer = analyzer || null
    
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMessageReactions,
      ],
    })

    this.setupEventHandlers()
  }

  /**
   * Get all monitored channel IDs (from database + fallback from config)
   */
  private getMonitoredChannelIds(): string[] {
    const dbChannels = this.db.getAllMonitoredChannelIds()
    // If no channels in DB yet, fall back to config (for migration)
    if (dbChannels.length === 0 && this.config.channelIds) {
      return this.config.channelIds
    }
    return dbChannels
  }

  /**
   * Check if a channel is being monitored
   */
  private isMonitoredChannel(channelId: string): boolean {
    return this.getMonitoredChannelIds().includes(channelId)
  }

  private setupEventHandlers() {
    this.client.on('ready', async () => {
      console.log(`🤖 Bug tracker bot logged in as ${this.client.user?.tag}`)
      const channelIds = this.getMonitoredChannelIds()
      console.log(`📡 Monitoring ${channelIds.length} channel(s)${channelIds.length > 0 ? ': ' + channelIds.join(', ') : ''}`)
      this.ready = true
      
      // Register slash commands
      await this.registerSlashCommands()
    })

    this.client.on('messageCreate', (message) => {
      this.handleMessage(message)
    })

    this.client.on('messageUpdate', (_oldMsg, newMsg) => {
      if (newMsg.partial) return
      this.handleMessage(newMsg as Message)
    })

    // Handle ✅ reaction added to bugs
    this.client.on('messageReactionAdd', async (reaction, _user) => {
      if (!this.isMonitoredChannel(reaction.message.channelId)) return
      await this.handleReactionAdd(reaction)
    })

    this.client.on('messageReactionRemove', async (reaction, _user) => {
      if (!this.isMonitoredChannel(reaction.message.channelId)) return
      await this.updateMessageReactions(reaction.message.id)
    })

    // Handle slash commands
    this.client.on('interactionCreate', async (interaction) => {
      if (!interaction.isChatInputCommand()) return
      await this.handleSlashCommand(interaction as ChatInputCommandInteraction)
    })
  }

  /**
   * Register slash commands with Discord
   */
  private async registerSlashCommands() {
    if (!this.client.user) return

    const rest = new REST({ version: '10' }).setToken(this.config.token)
    
    try {
      console.log('🔧 Registering slash commands...')
      
      // Register globally (or for specific guild if configured)
      if (this.config.guildId) {
        await rest.put(
          Routes.applicationGuildCommands(this.client.user.id, this.config.guildId),
          { body: slashCommands.map(cmd => cmd.toJSON()) }
        )
      } else {
        await rest.put(
          Routes.applicationCommands(this.client.user.id),
          { body: slashCommands.map(cmd => cmd.toJSON()) }
        )
      }
      
      console.log('✅ Slash commands registered: /addchannel, /removechannel, /deletechannel, /listchannels, /recentbugs')
    } catch (error) {
      console.error('❌ Failed to register slash commands:', error)
    }
  }

  /**
   * Handle slash commands
   */
  private async handleSlashCommand(interaction: ChatInputCommandInteraction) {
    const { commandName } = interaction

    try {
      switch (commandName) {
        case 'addchannel':
          await this.handleAddChannel(interaction)
          break
        case 'removechannel':
          await this.handleRemoveChannel(interaction)
          break
        case 'deletechannel':
          await this.handleDeleteChannel(interaction)
          break
        case 'listchannels':
          await this.handleListChannels(interaction)
          break
        case 'recentbugs':
          await this.handleRecentBugs(interaction)
          break
      }
    } catch (error) {
      console.error(`Error handling /${commandName}:`, error)
      const message = interaction.replied || interaction.deferred
        ? { content: '❌ An error occurred while processing the command.' }
        : { content: '❌ An error occurred while processing the command.', ephemeral: true }
      
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp(message)
      } else {
        await interaction.reply(message)
      }
    }
  }

  /**
   * Handle /addchannel command
   */
  private async handleAddChannel(interaction: ChatInputCommandInteraction) {
    const channel = interaction.options.get('channel')?.channel
    
    if (!channel || !interaction.guildId) {
      await interaction.reply({ content: '❌ Invalid channel or not in a server.', ephemeral: true })
      return
    }

    const success = this.db.addMonitoredChannel({
      guildId: interaction.guildId,
      channelId: channel.id,
      channelName: channel.name || 'unknown',
      addedByUserId: interaction.user.id,
      addedByUsername: interaction.user.username
    })

    if (success) {
      await interaction.reply({
        content: `✅ Now monitoring <#${channel.id}> for bug reports!\n\n🔍 Scanning recent messages for existing bugs...`,
        ephemeral: true
      })
      console.log(`📡 Added channel #${channel.name} (${channel.id}) to monitoring`)
      
      // Scan the channel for existing bugs (last ~300 messages)
      try {
        const stats = await this.scanChannelHistory(channel.id, 300)
        await interaction.followUp({
          content: `✅ Scan complete for <#${channel.id}>!\n\n` +
            `📊 Found: **${stats.bugs}** bugs, **${stats.updates}** replies\n` +
            `💡 Messages starting with \`▶️\` will be tracked as bugs.`,
          ephemeral: true
        })
      } catch (error) {
        console.error('Error scanning channel history:', error)
        await interaction.followUp({
          content: `⚠️ Could not scan history, but the channel is now being monitored.`,
          ephemeral: true
        })
      }
    } else {
      await interaction.reply({
        content: `⚠️ <#${channel.id}> is already being monitored.`,
        ephemeral: true
      })
    }
  }

  /**
   * Scan a channel's recent history for bugs
   * Used when a channel is first added
   */
  private async scanChannelHistory(channelId: string, maxMessages: number = 300): Promise<{ bugs: number; updates: number }> {
    let bugsFound = 0
    let updatesFound = 0

    try {
      const channel = await this.client.channels.fetch(channelId) as TextChannel
      if (!channel || !channel.isTextBased()) {
        return { bugs: 0, updates: 0 }
      }

      console.log(`🔍 Scanning #${channel.name} for existing bugs (up to ${maxMessages} messages)...`)

      // Fetch messages in batches
      let lastMessageId: string | undefined
      let totalScanned = 0

      while (totalScanned < maxMessages) {
        const batchSize = Math.min(100, maxMessages - totalScanned)
        const fetchOptions: { limit: number; before?: string } = { limit: batchSize }
        if (lastMessageId) {
          fetchOptions.before = lastMessageId
        }

        const messages = await channel.messages.fetch(fetchOptions)
        if (messages.size === 0) break

        // Process oldest first
        const sortedMessages = Array.from(messages.values()).sort((a, b) => 
          a.createdTimestamp - b.createdTimestamp
        )

        for (const message of sortedMessages) {
          if (message.author.bot) continue

          const discordUrl = `https://discord.com/channels/${message.guildId}/${message.channelId}/${message.id}`

          // Check for ▶️ - new bug
          if (this.isNewBugReport(message.content)) {
            const reactions = await this.extractReactions(message)
            const type = this.detectType(message.content)
            
            const hasCheckReaction = reactions.some(r => 
              r.emoji === '✅' || r.emoji === 'white_check_mark'
            )

            const bug = this.db.addBug({
              discord_message_id: message.id,
              channel_id: message.channelId,
              channel_name: channel.name,
              author_id: message.author.id,
              author_name: message.author.username,
              content: message.content,
              type,
              status: hasCheckReaction ? 'fixed' : 'open',
              created_at: message.createdAt.toISOString(),
              updated_at: message.createdAt.toISOString(),
              discord_url: discordUrl,
              reactions
            })

            if (bug) bugsFound++
            continue
          }

          // Check for replies to bugs
          if (message.reference?.messageId) {
            const refMessageId = message.reference.messageId
            
            let bug = this.db.getBugByMessageId(refMessageId)
            if (!bug) {
              const bugId = this.db.getBugIdFromUpdateMessage(refMessageId)
              if (bugId) bug = this.db.getBugById(bugId)
            }

            if (bug) {
              const reactions = await this.extractReactions(message)
              
              // Check if this is a ✅ completion
              if (this.isCompletionMarker(message.content) && bug.status === 'open') {
                this.db.updateBugStatus(bug.id, 'fixed')
              }

              const update = this.db.addBugUpdate({
                bug_id: bug.id,
                discord_message_id: message.id,
                author_id: message.author.id,
                author_name: message.author.username,
                content: message.content,
                created_at: message.createdAt.toISOString(),
                discord_url: discordUrl,
                reactions
              })

              if (update) updatesFound++
            }
          }
        }

        totalScanned += messages.size
        lastMessageId = sortedMessages[0]?.id // oldest message in batch

        if (messages.size < batchSize) break
      }

      console.log(`✅ Scanned ${totalScanned} messages in #${channel.name}: ${bugsFound} bugs, ${updatesFound} updates`)
      
    } catch (error) {
      console.error(`Error scanning channel ${channelId}:`, error)
    }

    return { bugs: bugsFound, updates: updatesFound }
  }

  /**
   * Handle /removechannel command
   */
  private async handleRemoveChannel(interaction: ChatInputCommandInteraction) {
    const channel = interaction.options.get('channel')?.channel
    
    if (!channel) {
      await interaction.reply({ content: '❌ Invalid channel.', ephemeral: true })
      return
    }

    const success = this.db.removeMonitoredChannel(channel.id)

    if (success) {
      await interaction.reply({
        content: `✅ Stopped monitoring <#${channel.id}>. Existing bugs from this channel are preserved.`,
        ephemeral: true
      })
      console.log(`📡 Removed channel #${channel.name} (${channel.id}) from monitoring`)
    } else {
      await interaction.reply({
        content: `⚠️ <#${channel.id}> was not being monitored.`,
        ephemeral: true
      })
    }
  }

  /**
   * Handle /deletechannel command - removes channel AND deletes all bugs from it
   */
  private async handleDeleteChannel(interaction: ChatInputCommandInteraction) {
    const channel = interaction.options.get('channel')?.channel
    
    if (!channel) {
      await interaction.reply({ content: '❌ Invalid channel.', ephemeral: true })
      return
    }

    // Remove from monitored channels
    const wasMonitored = this.db.removeMonitoredChannel(channel.id)
    
    // Delete all bugs from this channel
    const bugsDeleted = this.db.deleteBugsByChannel(channel.id)

    if (wasMonitored || bugsDeleted > 0) {
      await interaction.reply({
        content: `🗑️ Removed <#${channel.id}> and deleted **${bugsDeleted}** bug${bugsDeleted !== 1 ? 's' : ''} from it.`,
        ephemeral: true
      })
      console.log(`🗑️ Deleted channel #${channel.name} (${channel.id}) with ${bugsDeleted} bugs`)
    } else {
      await interaction.reply({
        content: `⚠️ <#${channel.id}> was not being monitored and had no bugs recorded.`,
        ephemeral: true
      })
    }
  }

  /**
   * Handle /listchannels command
   */
  private async handleListChannels(interaction: ChatInputCommandInteraction) {
    const guildId = interaction.guildId
    if (!guildId) {
      await interaction.reply({ content: '❌ This command must be used in a server.', ephemeral: true })
      return
    }

    const channels = this.db.getMonitoredChannels(guildId)
    
    if (channels.length === 0) {
      // Check for fallback env channels
      const envChannels = this.config.channelIds || []
      if (envChannels.length > 0) {
        await interaction.reply({
          content: `📡 **Monitored Channels (from environment)**\n\nChannels: ${envChannels.map(id => `<#${id}>`).join(', ')}\n\n*Use \`/addchannel\` to switch to dynamic channel management.*`,
          ephemeral: true
        })
      } else {
        await interaction.reply({
          content: `📡 **No channels are being monitored**\n\nUse \`/addchannel\` to start tracking bugs in a channel.`,
          ephemeral: true
        })
      }
      return
    }

    const channelList = channels.map(ch => 
      `• <#${ch.channel_id}> - added by ${ch.added_by_username} (<t:${Math.floor(new Date(ch.added_at).getTime() / 1000)}:R>)`
    ).join('\n')

    await interaction.reply({
      content: `📡 **Monitored Channels (${channels.length})**\n\n${channelList}`,
      ephemeral: true
    })
  }

  /**
   * Handle /recentbugs command
   */
  private async handleRecentBugs(interaction: ChatInputCommandInteraction) {
    const count = (interaction.options.get('count')?.value as number) || 5
    const statusFilter = (interaction.options.get('status')?.value as string) || 'all'

    const status = statusFilter === 'all' ? undefined : statusFilter as 'open' | 'fixed'
    const bugs = this.db.getAllBugs({ status, limit: count })

    if (bugs.length === 0) {
      await interaction.reply({
        content: `🐛 **No bugs found**${status ? ` with status: ${status}` : ''}`,
        ephemeral: true
      })
      return
    }

    // Create an embed for each bug (max 5 embeds per message)
    const embeds: EmbedBuilder[] = bugs.slice(0, 5).map(bug => {
      const statusEmoji = bug.status === 'fixed' ? '✅' : '🔴'
      const typeEmoji = bug.type === 'bug' ? '🐛' : '✨'
      
      // Truncate content if too long
      const content = bug.content.length > 200 
        ? bug.content.substring(0, 200) + '...' 
        : bug.content

      const embed = new EmbedBuilder()
        .setColor(bug.status === 'fixed' ? 0x6bcb77 : 0xff6b6b)
        .setTitle(`${typeEmoji} Bug #${bug.id} ${statusEmoji}`)
        .setDescription(content)
        .addFields(
          { name: 'Status', value: bug.status, inline: true },
          { name: 'Type', value: bug.type, inline: true },
          { name: 'Author', value: bug.author_name, inline: true },
          { name: 'Channel', value: `#${bug.channel_name}`, inline: true },
        )
        .setURL(bug.discord_url)
        .setTimestamp(new Date(bug.created_at))
        .setFooter({ text: 'Click title to view in Discord' })

      return embed
    })

    // If there are more bugs than shown, mention it
    const moreText = bugs.length > 5 ? `\n\n*Showing 5 of ${bugs.length} bugs. Use the web dashboard for full list.*` : ''

    await interaction.reply({
      content: `🐛 **Recent Bugs**${status ? ` (${status})` : ''}${moreText}`,
      embeds,
      ephemeral: true
    })
  }

  /**
   * Handle a ✅ reaction being added - might close a bug
   */
  private async handleReactionAdd(reaction: MessageReaction | PartialMessageReaction) {
    const emojiName = reaction.emoji.name || ''
    
    // Check if it's a ✅ reaction
    if (emojiName === '✅' || emojiName === 'white_check_mark') {
      const messageId = reaction.message.id
      
      // Check if this message is a bug
      const bug = this.db.getBugByMessageId(messageId)
      if (bug && bug.status === 'open') {
        this.db.updateBugStatus(bug.id, 'fixed')
        console.log(`✅ Bug #${bug.id} marked as FIXED (✅ reaction)`)
        return
      }
      
      // Check if it's a bug update
      const bugId = this.db.getBugIdFromUpdateMessage(messageId)
      if (bugId) {
        const relatedBug = this.db.getBugById(bugId)
        if (relatedBug && relatedBug.status === 'open') {
          this.db.updateBugStatus(bugId, 'fixed')
          console.log(`✅ Bug #${bugId} marked as FIXED (✅ reaction on update)`)
          return
        }
      }
    }
    
    // Update stored reactions for tracking
    await this.updateMessageReactions(reaction.message.id)
  }

  /**
   * Update reactions for a tracked message
   */
  private async updateMessageReactions(messageId: string) {
    try {
      for (const channelId of this.getMonitoredChannelIds()) {
        try {
          const channel = await this.client.channels.fetch(channelId) as TextChannel
          const message = await channel.messages.fetch(messageId)
          
          const reactions = await this.extractReactions(message)
          
          const bug = this.db.getBugByMessageId(messageId)
          if (bug) {
            this.db.updateBugReactions(messageId, reactions)
          } else {
            this.db.updateUpdateReactions(messageId, reactions)
          }
          return
        } catch {
          // Message not in this channel
        }
      }
    } catch (error) {
      console.error(`Failed to update reactions for ${messageId}:`, error)
    }
  }

  /**
   * Main message handler - routes based on markers
   */
  private async handleMessage(message: Message) {
    if (message.author.bot) return
    if (!this.isMonitoredChannel(message.channelId)) return

    const content = message.content

    // 1. Check for ▶️ - new bug report
    if (this.isNewBugReport(content)) {
      await this.createBug(message)
      this.addToRecentMessages(message.channelId, message, undefined)
      return
    }

    // 2. Check for ✅ - completion marker
    if (this.isCompletionMarker(content)) {
      await this.handleCompletion(message)
      return
    }

    // 3. Check if direct reply to bug or update
    if (message.reference?.messageId) {
      const handled = await this.handleReply(message)
      if (handled) return
    }

    // 4. Not a reply - use AI to determine if it should be added to a bug
    await this.handleContextMessage(message)
  }

  /**
   * Check if message starts with ▶️
   */
  private isNewBugReport(content: string): boolean {
    return content.trim().startsWith('▶️')
  }

  /**
   * Check if message contains ✅ completion marker
   */
  private isCompletionMarker(content: string): boolean {
    const trimmed = content.trim()
    return trimmed.includes('✅')
  }

  /**
   * Detect if a ▶️ message is a bug or a feature request
   * Bug keywords: bug, issue, broken, error, crash, fail, problem
   * Otherwise: request
   */
  private detectType(content: string): BugType {
    const lower = content.toLowerCase()
    const bugKeywords = ['bug', 'issue', 'broken', 'error', 'crash', 'fail', 'problem', 'not working', 'doesn\'t work', 'doesnt work']
    
    for (const keyword of bugKeywords) {
      if (lower.includes(keyword)) {
        return 'bug'
      }
    }
    
    return 'request'
  }

  /**
   * Create a new bug/request from a ▶️ message
   */
  private async createBug(message: Message) {
    let channelName = 'unknown'
    try {
      const channel = await this.client.channels.fetch(message.channelId) as TextChannel
      channelName = channel?.name || 'unknown'
    } catch { /* ignore */ }

    const discordUrl = `https://discord.com/channels/${message.guildId}/${message.channelId}/${message.id}`
    const reactions = await this.extractReactions(message)
    const type = this.detectType(message.content)

    const bug = this.db.addBug({
      discord_message_id: message.id,
      channel_id: message.channelId,
      channel_name: channelName,
      author_id: message.author.id,
      author_name: message.author.username,
      content: message.content,
      type,
      status: 'open',
      created_at: message.createdAt.toISOString(),
      updated_at: message.createdAt.toISOString(),
      discord_url: discordUrl,
      reactions
    })

    if (bug) {
      const typeIcon = type === 'bug' ? '🐛' : '✨'
      const typeLabel = type === 'bug' ? 'bug' : 'request'
      console.log(`${typeIcon} New ${typeLabel} #${bug.id} from ${message.author.username}`)
      console.log(`   "${message.content.substring(0, 100)}..."`)
    }
  }

  /**
   * Handle a ✅ completion message
   */
  private async handleCompletion(message: Message) {
    const content = message.content

    // If it's a reply, close that bug
    if (message.reference?.messageId) {
      const refMessageId = message.reference.messageId
      
      // Direct reply to bug
      let bug = this.db.getBugByMessageId(refMessageId)
      if (bug && bug.status === 'open') {
        this.db.updateBugStatus(bug.id, 'fixed')
        console.log(`✅ Bug #${bug.id} marked as FIXED (reply with ✅)`)
        return
      }
      
      // Reply to an update
      const bugId = this.db.getBugIdFromUpdateMessage(refMessageId)
      if (bugId) {
        const relatedBug = this.db.getBugById(bugId)
        if (relatedBug && relatedBug.status === 'open') {
          this.db.updateBugStatus(bugId, 'fixed')
          console.log(`✅ Bug #${bugId} marked as FIXED (reply to update with ✅)`)
          return
        }
      }
    }

    // Standalone ✅ message - need to match to a bug
    const completionText = content.replace(/✅\s*/, '').trim()
    const openBugs = this.db.getOpenBugs()
    
    if (openBugs.length === 0) {
      console.log(`✅ Completion marker but no open bugs to match`)
      return
    }

    // Try exact/close text match first
    if (this.analyzer) {
      const exactMatch = this.analyzer.findExactOrCloseMatch(
        completionText,
        openBugs.map(b => ({ id: b.id, content: b.content }))
      )
      
      if (exactMatch) {
        this.db.updateBugStatus(exactMatch, 'fixed')
        console.log(`✅ Bug #${exactMatch} marked as FIXED (text match)`)
        return
      }

      // Use AI to match
      console.log(`   🤖 Using AI to match completion...`)
      const result = await this.analyzer.matchCompletionToBug(
        completionText,
        openBugs.map(b => ({ id: b.id, content: b.content, author: b.author_name }))
      )

      if (result.bugId && result.confidence !== 'low') {
        this.db.updateBugStatus(result.bugId, 'fixed')
        console.log(`✅ Bug #${result.bugId} marked as FIXED (AI: ${result.reasoning})`)
        return
      }
    }

    // If only one open bug, assume it's that one
    if (openBugs.length === 1) {
      this.db.updateBugStatus(openBugs[0].id, 'fixed')
      console.log(`✅ Bug #${openBugs[0].id} marked as FIXED (only open bug)`)
      return
    }

    console.log(`⚠️ Could not match completion: "${completionText.substring(0, 50)}..."`)
  }

  /**
   * Handle a direct reply to a bug or update
   */
  private async handleReply(message: Message): Promise<boolean> {
    if (!message.reference?.messageId) return false

    const refMessageId = message.reference.messageId

    // Check if reply to bug
    let bug = this.db.getBugByMessageId(refMessageId)
    let isReplyToReply = false

    // Check if reply to an update
    if (!bug) {
      const bugId = this.db.getBugIdFromUpdateMessage(refMessageId)
      if (bugId) {
        bug = this.db.getBugById(bugId)
        isReplyToReply = true
      }
    }

    if (!bug) return false

    // Add as update
    const discordUrl = `https://discord.com/channels/${message.guildId}/${message.channelId}/${message.id}`
    const reactions = await this.extractReactions(message)

    const update = this.db.addBugUpdate({
      bug_id: bug.id,
      discord_message_id: message.id,
      author_id: message.author.id,
      author_name: message.author.username,
      content: message.content,
      created_at: message.createdAt.toISOString(),
      discord_url: discordUrl,
      reactions
    })

    if (update) {
      const chainIndicator = isReplyToReply ? ' (reply chain)' : ''
      console.log(`💬 Update on bug #${bug.id} from ${message.author.username}${chainIndicator}`)
      this.addToRecentMessages(message.channelId, message, bug.id)
    }

    return true
  }

  /**
   * Handle a non-reply, non-marker message - use AI to decide if it's bug-related
   */
  private async handleContextMessage(message: Message) {
    if (!this.analyzer) {
      // No AI, just track the message for context
      this.addToRecentMessages(message.channelId, message, undefined)
      return
    }

    // Get recently active bugs in this channel
    const recentBugs = this.db.getRecentlyActiveBugs(message.channelId, 5)
    
    if (recentBugs.length === 0) {
      // No active bugs, nothing to potentially add to
      this.addToRecentMessages(message.channelId, message, undefined)
      return
    }

    // Get recent messages for context
    const channelRecent = this.recentMessages.get(message.channelId) || []

    // Ask AI if this message should be added to a bug
    const result = await this.analyzer.shouldAddToBug(
      message.content,
      message.author.username,
      recentBugs.map(b => ({ id: b.id, content: b.content, author: b.author_name })),
      channelRecent.map(m => ({ author: m.author, content: m.content, bugId: m.bugId }))
    )

    if (result.shouldAdd && result.bugId) {
      // Verify the bug exists and is in our recent list
      const targetBug = recentBugs.find(b => b.id === result.bugId)
      if (targetBug) {
        const discordUrl = `https://discord.com/channels/${message.guildId}/${message.channelId}/${message.id}`
        const reactions = await this.extractReactions(message)

        const update = this.db.addBugUpdate({
          bug_id: result.bugId,
          discord_message_id: message.id,
          author_id: message.author.id,
          author_name: message.author.username,
          content: message.content,
          created_at: message.createdAt.toISOString(),
          discord_url: discordUrl,
          reactions
        })

        if (update) {
          console.log(`💬 Context added to bug #${result.bugId} from ${message.author.username}`)
          console.log(`   (AI: ${result.reasoning || 'related to bug'})`)
          this.addToRecentMessages(message.channelId, message, result.bugId)
          return
        }
      }
    }

    // Not added to any bug
    this.addToRecentMessages(message.channelId, message, undefined)
  }

  /**
   * Track recent messages for context
   */
  private addToRecentMessages(channelId: string, message: Message, bugId?: number) {
    const recent = this.recentMessages.get(channelId) || []
    
    recent.push({
      id: message.id,
      author: message.author.username,
      authorId: message.author.id,
      content: message.content,
      bugId,
      timestamp: message.createdTimestamp
    })

    // Keep only last N messages
    if (recent.length > this.MAX_RECENT_MESSAGES) {
      recent.shift()
    }

    this.recentMessages.set(channelId, recent)
  }

  /**
   * Extract reactions from a message
   */
  private async extractReactions(message: Message): Promise<Reaction[]> {
    const reactions: Reaction[] = []
    
    for (const [, reaction] of message.reactions.cache) {
      try {
        const users = await reaction.users.fetch({ limit: 100 })
        const usernames = users.map(u => u.username)
        
        reactions.push({
          emoji: reaction.emoji.name || reaction.emoji.toString(),
          count: reaction.count,
          users: usernames
        })
      } catch {
        reactions.push({
          emoji: reaction.emoji.name || reaction.emoji.toString(),
          count: reaction.count,
          users: []
        })
      }
    }
    
    return reactions
  }

  /**
   * Sync reactions on open bugs - checks for ✅ reactions added while bot was offline
   * Checks both the bug message and all its replies/updates
   */
  async syncReactionsOnOpenBugs() {
    if (!this.ready) {
      console.log('⏳ Waiting for bot to be ready...')
      await new Promise<void>(resolve => {
        const check = () => {
          if (this.ready) resolve()
          else setTimeout(check, 100)
        }
        check()
      })
    }

    console.log('🔄 Syncing reactions on open bugs...')
    
    const openBugs = this.db.getOpenBugs()
    
    if (openBugs.length === 0) {
      console.log('   No open bugs to check')
      return
    }

    console.log(`   Checking ${openBugs.length} open bugs for new ✅ reactions...`)
    
    let bugsFixed = 0

    for (const bug of openBugs) {
      try {
        // Try to fetch the channel
        const channel = await this.client.channels.fetch(bug.channel_id) as TextChannel
        if (!channel || !channel.isTextBased()) continue

        // Check the original bug message for ✅ reaction
        try {
          const bugMessage = await channel.messages.fetch(bug.discord_message_id)
          const reactions = await this.extractReactions(bugMessage)
          
          const hasCheckReaction = reactions.some(r => 
            r.emoji === '✅' || r.emoji === 'white_check_mark'
          )

          if (hasCheckReaction) {
            this.db.updateBugStatus(bug.id, 'fixed')
            this.db.updateBugReactions(bug.discord_message_id, reactions)
            console.log(`   ✅ Bug #${bug.id} marked fixed (✅ reaction on bug)`)
            bugsFixed++
            continue
          }

          // Also update reactions on the bug message (even if not fixed)
          this.db.updateBugReactions(bug.discord_message_id, reactions)
        } catch {
          // Message might have been deleted
        }

        // Check all updates/replies for ✅ reaction
        const updates = this.db.getBugUpdates(bug.id)
        
        for (const update of updates) {
          try {
            const updateMessage = await channel.messages.fetch(update.discord_message_id)
            const reactions = await this.extractReactions(updateMessage)
            
            const hasCheckReaction = reactions.some(r => 
              r.emoji === '✅' || r.emoji === 'white_check_mark'
            )

            if (hasCheckReaction) {
              this.db.updateBugStatus(bug.id, 'fixed')
              this.db.updateUpdateReactions(update.discord_message_id, reactions)
              console.log(`   ✅ Bug #${bug.id} marked fixed (✅ reaction on reply)`)
              bugsFixed++
              break // Bug is fixed, no need to check more updates
            }

            // Also update reactions on the update message
            this.db.updateUpdateReactions(update.discord_message_id, reactions)
          } catch {
            // Message might have been deleted
          }
        }
      } catch (error) {
        // Channel access error, skip this bug
      }
    }

    if (bugsFixed > 0) {
      console.log(`🔄 Reaction sync complete: ${bugsFixed} bugs marked as fixed`)
    } else {
      console.log('🔄 Reaction sync complete: no new completions found')
    }
  }

  /**
   * Scan existing messages in monitored channels
   * @param options.sinceDate - Only scan messages after this date (for initial setup)
   * @param options.resumeFromSaved - If true, resume from last saved scan position
   */
  async scanExistingMessages(options: { sinceDate?: Date; resumeFromSaved?: boolean } = {}) {
    if (!this.ready) {
      console.log('⏳ Waiting for bot to be ready...')
      await new Promise<void>(resolve => {
        const check = () => {
          if (this.ready) resolve()
          else setTimeout(check, 100)
        }
        check()
      })
    }

    const { sinceDate, resumeFromSaved = true } = options

    if (sinceDate) {
      console.log(`🔍 Scanning messages since ${sinceDate.toISOString()}...`)
    } else if (resumeFromSaved) {
      console.log(`🔍 Scanning new messages since last shutdown...`)
    } else {
      console.log(`🔍 Scanning all messages...`)
    }

    const channelIds = this.getMonitoredChannelIds()
    if (channelIds.length === 0) {
      console.log('   ⚠️ No channels configured. Use /addchannel to add channels.')
      return
    }

    for (const channelId of channelIds) {
      try {
        const channel = await this.client.channels.fetch(channelId) as TextChannel
        if (!channel || !channel.isTextBased()) {
          console.log(`   ⚠️ Channel ${channelId} not found or not text-based`)
          continue
        }

        console.log(`   📂 Scanning #${channel.name}...`)
        
        // Determine starting point
        let afterId: string | undefined
        
        if (resumeFromSaved) {
          // Check for saved scan state first
          const savedState = this.db.getScanState(channelId)
          if (savedState) {
            afterId = savedState.lastMessageId
            console.log(`      Resuming from message ${afterId} (last scanned: ${savedState.lastScanAt})`)
          }
        }
        
        // If no saved state (or not resuming) and sinceDate provided, use that
        if (!afterId && sinceDate) {
          afterId = dateToSnowflake(sinceDate)
          console.log(`      Starting from date: ${sinceDate.toISOString()}`)
        }

        // Paginate through all messages
        let bugsFound = 0
        let updatesFound = 0
        let bugsFixed = 0
        let totalScanned = 0
        let newestMessageId: string | undefined
        let hasMore = true

        while (hasMore) {
          // Fetch batch of messages
          const fetchOptions: { limit: number; after?: string } = { limit: 100 }
          if (afterId) {
            fetchOptions.after = afterId
          }

          const messages = await channel.messages.fetch(fetchOptions)
          
          if (messages.size === 0) {
            hasMore = false
            break
          }

          // Process oldest first (messages come newest-first from Discord)
          const sortedMessages = Array.from(messages.values()).sort((a, b) => 
            a.createdTimestamp - b.createdTimestamp
          )

          for (const message of sortedMessages) {
            totalScanned++
            
            // Track newest message for scan state
            if (!newestMessageId || BigInt(message.id) > BigInt(newestMessageId)) {
              newestMessageId = message.id
            }

            if (message.author.bot) continue

            const channelName = channel.name
            const discordUrl = `https://discord.com/channels/${message.guildId}/${message.channelId}/${message.id}`
            
            // 1. Check for ▶️ - new bug report
            if (this.isNewBugReport(message.content)) {
              const reactions = await this.extractReactions(message)
              const type = this.detectType(message.content)
              
              // Check if this bug has a ✅ reaction (already fixed)
              const hasCheckReaction = reactions.some(r => 
                r.emoji === '✅' || r.emoji === 'white_check_mark'
              )

              const bug = this.db.addBug({
                discord_message_id: message.id,
                channel_id: message.channelId,
                channel_name: channelName,
                author_id: message.author.id,
                author_name: message.author.username,
                content: message.content,
                type,
                status: hasCheckReaction ? 'fixed' : 'open',
                created_at: message.createdAt.toISOString(),
                updated_at: message.createdAt.toISOString(),
                discord_url: discordUrl,
                reactions
              })

              if (bug) {
                bugsFound++
                if (hasCheckReaction) bugsFixed++
              }
              continue
            }

            // 2. Check for ✅ - completion marker (marks a bug as fixed)
            if (this.isCompletionMarker(message.content)) {
              // If it's a reply, find the bug it refers to
              if (message.reference?.messageId) {
                const refMessageId = message.reference.messageId
                
                // Check if it's a reply to a bug
                let bug = this.db.getBugByMessageId(refMessageId)
                if (bug && bug.status === 'open') {
                  this.db.updateBugStatus(bug.id, 'fixed')
                  bugsFixed++
                  continue
                }
                
                // Check if it's a reply to an update
                const bugId = this.db.getBugIdFromUpdateMessage(refMessageId)
                if (bugId) {
                  const relatedBug = this.db.getBugById(bugId)
                  if (relatedBug && relatedBug.status === 'open') {
                    this.db.updateBugStatus(bugId, 'fixed')
                    bugsFixed++
                  }
                }
              }
              // Standalone ✅ without reply - skip during scan (too ambiguous)
              continue
            }

            // 3. Check for replies to bugs (add as updates)
            if (message.reference?.messageId) {
              const refMessageId = message.reference.messageId
              
              // Check if it's a reply to a bug
              let bug = this.db.getBugByMessageId(refMessageId)

              // Check if it's a reply to an existing update (reply chain)
              if (!bug) {
                const bugId = this.db.getBugIdFromUpdateMessage(refMessageId)
                if (bugId) {
                  bug = this.db.getBugById(bugId)
                }
              }

              if (bug) {
                const reactions = await this.extractReactions(message)
                
                const update = this.db.addBugUpdate({
                  bug_id: bug.id,
                  discord_message_id: message.id,
                  author_id: message.author.id,
                  author_name: message.author.username,
                  content: message.content,
                  created_at: message.createdAt.toISOString(),
                  discord_url: discordUrl,
                  reactions
                })

                if (update) updatesFound++
              }
            }
          }

          // Continue from newest message in this batch
          afterId = sortedMessages[sortedMessages.length - 1].id
          
          // If we got fewer than 100, we've reached the end
          if (messages.size < 100) {
            hasMore = false
          }

          // Progress indicator for large scans
          if (totalScanned % 500 === 0) {
            console.log(`      ... scanned ${totalScanned} messages, found ${bugsFound} bugs, ${updatesFound} updates so far`)
          }
        }

        // Save scan state (newest message we've seen)
        if (newestMessageId) {
          this.db.saveScanState(channelId, newestMessageId)
        }

        console.log(`   ✅ Scanned ${totalScanned} messages in #${channel.name}`)
        console.log(`      Found: ${bugsFound} bugs, ${updatesFound} updates, ${bugsFixed} already fixed`)
      } catch (error) {
        console.error(`   ❌ Error scanning channel ${channelId}:`, error)
      }
    }

    console.log('🔍 Scan complete!')
  }

  /**
   * Save current scan position for all channels
   * Call this before shutdown to enable resuming
   */
  async saveCurrentPosition() {
    console.log('💾 Saving scan position...')
    
    for (const channelId of this.getMonitoredChannelIds()) {
      try {
        const channel = await this.client.channels.fetch(channelId) as TextChannel
        if (!channel || !channel.isTextBased()) continue

        // Fetch the most recent message
        const messages = await channel.messages.fetch({ limit: 1 })
        const lastMessage = messages.first()
        
        if (lastMessage) {
          this.db.saveScanState(channelId, lastMessage.id)
          console.log(`   📍 Saved position for #${channel.name}: ${lastMessage.id}`)
        }
      } catch (error) {
        console.error(`   ⚠️ Could not save position for ${channelId}:`, error)
      }
    }
  }

  async start() {
    console.log('🚀 Starting bug tracker bot...')
    await this.client.login(this.config.token)
  }

  async stop() {
    console.log('👋 Stopping bug tracker bot...')
    await this.client.destroy()
  }
}
