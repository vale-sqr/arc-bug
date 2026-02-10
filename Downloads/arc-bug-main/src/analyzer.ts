/**
 * AI-powered message analyzer using Claude Haiku
 * Two main functions:
 * 1. shouldAddToBug - determines if a non-reply message should be added to a bug's context
 * 2. matchCompletionToBug - matches a ✅ message to the bug it's completing
 */

import Anthropic from '@anthropic-ai/sdk'

export interface AddToBugResult {
  shouldAdd: boolean
  bugId: number | null
  confidence: 'high' | 'medium' | 'low'
  reasoning?: string
}

export interface MatchResult {
  bugId: number | null
  confidence: 'high' | 'medium' | 'low'
  reasoning?: string
}

export class MessageAnalyzer {
  private client: Anthropic
  private model = 'claude-3-haiku-20240307'

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey })
  }

  /**
   * Determine if a non-reply message should be added to a bug's context.
   * Used for messages without ▶️ or ✅ that aren't direct replies.
   * 
   * @param messageContent - The message to analyze
   * @param messageAuthor - Who wrote it
   * @param recentBugs - Recently active bugs in the channel
   * @param recentMessages - Last few messages for context
   */
  async shouldAddToBug(
    messageContent: string,
    messageAuthor: string,
    recentBugs: Array<{ id: number; content: string; author: string }>,
    recentMessages: Array<{ author: string; content: string; bugId?: number }>
  ): Promise<AddToBugResult> {
    // If no bugs to match against, nothing to add to
    if (recentBugs.length === 0) {
      return { shouldAdd: false, bugId: null, confidence: 'high' }
    }

    // Format bugs for prompt
    const bugsText = recentBugs
      .map(b => `Bug #${b.id} (by ${b.author}): "${b.content.substring(0, 200)}"`)
      .join('\n')

    // Format recent context
    const contextText = recentMessages.length > 0
      ? recentMessages.map(m => {
          const bugRef = m.bugId ? ` [about bug #${m.bugId}]` : ''
          return `- ${m.author}${bugRef}: "${m.content.substring(0, 150)}"`
        }).join('\n')
      : 'No recent messages'

    const prompt = `You are analyzing a Discord channel that tracks bugs. A new message was posted (NOT a reply to anything). Determine if this message is discussing one of the recently active bugs, or if it's unrelated conversation.

RECENTLY ACTIVE BUGS:
${bugsText}

RECENT CHANNEL MESSAGES (for context):
${contextText}

NEW MESSAGE (from ${messageAuthor}):
"${messageContent}"

Should this message be added to one of the bugs' context? Consider:
- Is the message discussing a bug's topic?
- Does it provide additional info, clarification, or discussion about a bug?
- Is the author continuing a conversation about a bug?
- Or is this unrelated chat/different topic entirely?

If it's clearly unrelated conversation (greetings, off-topic chat, different subject), don't add it.
If it seems related to a bug, even loosely, prefer to add it (more context is better).

Respond with ONLY a JSON object:
{"shouldAdd": true/false, "bugId": <number or null>, "confidence": "high|medium|low", "reasoning": "brief explanation"}`

    try {
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: 150,
        messages: [{ role: 'user', content: prompt }]
      })

      const text = response.content[0]?.type === 'text' ? response.content[0].text : ''
      const jsonMatch = text.match(/\{[\s\S]*\}/)
      
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0])
        return {
          shouldAdd: !!parsed.shouldAdd,
          bugId: parsed.bugId ?? null,
          confidence: parsed.confidence || 'medium',
          reasoning: parsed.reasoning
        }
      }

      return { shouldAdd: false, bugId: null, confidence: 'low' }
    } catch (error) {
      console.error('shouldAddToBug analysis failed:', error)
      return { shouldAdd: false, bugId: null, confidence: 'low' }
    }
  }

  /**
   * Match a completion message (with ✅) to the bug it's completing.
   * Used when someone posts "✅ bug: something" without replying to the original.
   * 
   * @param completionText - The text after ✅ (e.g., "bug: models are seeing traces")
   * @param openBugs - List of currently open bugs to match against
   */
  async matchCompletionToBug(
    completionText: string,
    openBugs: Array<{ id: number; content: string; author: string }>
  ): Promise<MatchResult> {
    // If no bugs to match, nothing to do
    if (openBugs.length === 0) {
      return { bugId: null, confidence: 'high', reasoning: 'No open bugs to match' }
    }

    // If only one bug, it's probably that one
    if (openBugs.length === 1) {
      return { 
        bugId: openBugs[0].id, 
        confidence: 'medium', 
        reasoning: 'Only one open bug' 
      }
    }

    // Format bugs for prompt
    const bugsText = openBugs
      .map(b => `Bug #${b.id} (by ${b.author}): "${b.content.substring(0, 300)}"`)
      .join('\n\n')

    const prompt = `Someone marked a bug as complete with this message:
"✅ ${completionText}"

Which of these open bugs does it match?

OPEN BUGS:
${bugsText}

Match based on:
- Similar wording/description
- Same topic/issue being described
- Partial matches (the completion text might be abbreviated)

Respond with ONLY a JSON object:
{"bugId": <number>, "confidence": "high|medium|low", "reasoning": "brief explanation"}

If you cannot determine a match, use bugId: null.`

    try {
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: 150,
        messages: [{ role: 'user', content: prompt }]
      })

      const text = response.content[0]?.type === 'text' ? response.content[0].text : ''
      const jsonMatch = text.match(/\{[\s\S]*\}/)
      
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0])
        return {
          bugId: parsed.bugId ?? null,
          confidence: parsed.confidence || 'medium',
          reasoning: parsed.reasoning
        }
      }

      return { bugId: null, confidence: 'low' }
    } catch (error) {
      console.error('matchCompletionToBug analysis failed:', error)
      return { bugId: null, confidence: 'low' }
    }
  }

  /**
   * Simple text similarity check - used as first pass before AI
   * Returns bug ID if there's a strong text match, null otherwise
   */
  findExactOrCloseMatch(
    text: string, 
    bugs: Array<{ id: number; content: string }>
  ): number | null {
    const normalizedText = text.toLowerCase().trim()
    
    for (const bug of bugs) {
      const normalizedBug = bug.content.toLowerCase()
      
      // Exact match (ignoring case)
      if (normalizedBug.includes(normalizedText) || normalizedText.includes(normalizedBug)) {
        return bug.id
      }
      
      // Check if the completion text matches the bug content after "bug:" or "▶️"
      const bugTextAfterPrefix = normalizedBug
        .replace(/^▶️\s*/, '')
        .replace(/^bug:\s*/i, '')
        .trim()
      
      const completionTextClean = normalizedText
        .replace(/^▶️\s*/, '')
        .replace(/^bug:\s*/i, '')
        .trim()
      
      if (bugTextAfterPrefix === completionTextClean) {
        return bug.id
      }
      
      // Check for high word overlap (>70% of words match)
      const bugWords = new Set(bugTextAfterPrefix.split(/\s+/).filter(w => w.length > 2))
      const textWords = completionTextClean.split(/\s+/).filter(w => w.length > 2)
      
      if (textWords.length > 0 && bugWords.size > 0) {
        const matches = textWords.filter(w => bugWords.has(w)).length
        const overlap = matches / Math.max(textWords.length, bugWords.size)
        if (overlap > 0.7) {
          return bug.id
        }
      }
    }
    
    return null
  }
}
