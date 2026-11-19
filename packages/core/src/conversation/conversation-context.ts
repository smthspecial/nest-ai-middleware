import type { AiConversationTurn, AiConversationTurnQuery, AiConversationTurnRecord } from '../contracts/ai-conversation.js';
import { AI_REQUEST_LIMITS } from '../orchestrator/ai-request-limits.js';

const contextPageSize = 16;

function clip(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text);
  let end = maxBytes;
  if (bytes.length <= end) return text;
  while ((bytes[end] & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString('utf8');
}

function clipTurn(turn: AiConversationTurn, maxBytes = AI_REQUEST_LIMITS.historyMessageBytes): AiConversationTurn {
  return { user: clip(turn.user, maxBytes), assistant: clip(turn.assistant, maxBytes) };
}

export async function selectConversationContext(
  read: (query: AiConversationTurnQuery) => Promise<readonly AiConversationTurnRecord[]>,
): Promise<AiConversationTurn[]> {
  const [first] = await read({ order: 'ascending', after: 0, limit: 1 });
  if (!first) return [];
  let opening = clipTurn(first);
  if (Buffer.byteLength(JSON.stringify([opening])) > AI_REQUEST_LIMITS.historyBytes) {
    // JSON can expand an ASCII control byte to a six-byte escape sequence.
    opening = clipTurn(opening, Math.floor((AI_REQUEST_LIMITS.historyBytes - 32) / 12));
  }

  const recent: AiConversationTurn[] = [];
  let bytes = Buffer.byteLength(JSON.stringify([opening]));
  let before: number | undefined;
  for (;;) {
    const page = await read({
      order: 'descending', after: first.position, limit: contextPageSize, ...(before !== undefined ? { before } : {}),
    });
    for (const row of page) {
      const turn = clipTurn(row);
      bytes += 1 + Buffer.byteLength(JSON.stringify(turn));
      if (bytes > AI_REQUEST_LIMITS.historyBytes) return [opening, ...recent.reverse()];
      recent.push(turn);
    }
    if (page.length < contextPageSize) return [opening, ...recent.reverse()];
    before = page[page.length - 1].position;
  }
}
