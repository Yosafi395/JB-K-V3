const { anthropicToolsToJB, buildParametersData } = require('./tools');

const THINKING_SYSTEM = `Before answering, think step by step inside <thinking>...</thinking> tags.

In your thinking:
- Restate what the user wants to achieve
- Identify edge cases, constraints, and potential pitfalls
- For coding tasks: outline the structure before writing, note key invariants
- Consider 1-2 approaches and pick the best one with brief justification

After </thinking>, provide your final answer outside the tags.
Keep thinking proportional to task complexity—do not overthink trivial questions.`;

const MAXTHINKING_SYSTEM = `Think very thoroughly before answering, inside <thinking>...</thinking> tags.

In your thinking:
1. Restate the problem in your own words and identify what success looks like.
2. Map out the full solution space — list 2-3 distinct approaches and their trade-offs.
3. For coding tasks specifically:
   - Identify all edge cases, error conditions, concurrency/race issues
   - Consider data structures, algorithmic complexity, memory usage
   - Trace through the logic with a concrete example
   - Check for off-by-one errors, null/empty handling, type coercion
4. Self-critique: pick your best approach, then argue against it. What could go wrong?
5. Verify: walk through the final solution against the original requirements.

After </thinking>, provide a clean, focused answer outside the tags.
Quality matters more than speed; explore branches before committing.`;

/**
 * Convert Anthropic /v1/messages request body to JB Grazie request body.
 * resolved: { profile, mode, level } from models-cache.resolveModel
 */
function convertRequest(anthropicBody, resolved = {}) {
  // prompt 注入：往 system 里追加思考提示
  let systemForJB = anthropicBody.system;
  if (resolved.mode === 'prompt_inject') {
    const sys = resolved.level === 'max' ? MAXTHINKING_SYSTEM : THINKING_SYSTEM;
    if (typeof systemForJB === 'string') systemForJB = systemForJB + '\n\n' + sys;
    else if (Array.isArray(systemForJB)) systemForJB = [...systemForJB, { type: 'text', text: sys }];
    else systemForJB = sys;
  }

  const messages = convertMessages(systemForJB, anthropicBody.messages || []);
  const toolsData = anthropicToolsToJB(anthropicBody.tools);

  const extraParams = [];
  if (resolved.mode === 'native_reasoning_effort' && resolved.level) {
    extraParams.push(
      { type: 'text', fqdn: 'llm.parameters.reasoning-effort' },
      { type: 'text', value: resolved.level },
    );
  } else if (resolved.mode === 'native_thinking_budget') {
    const budget = resolved.level === 'max' ? 24000 : 8000;
    extraParams.push(
      { type: 'int', fqdn: 'llm.parameters.thinking-budget' },
      { type: 'int', value: budget },
    );
  }

  const parametersData = buildParametersData(toolsData);
  const allParams = [...parametersData, ...extraParams];

  return {
    prompt: 'ij.chat.request.new-chat-on-start',
    profile: resolved.profile || anthropicBody.model,
    chat: { messages },
    parameters: allParams.length > 0 ? { data: allParams } : undefined,
  };
}

function convertMessages(system, anthropicMessages) {
  const jbMessages = [];

  // Build tool_use_id -> name map from assistant messages
  const toolNameMap = new Map();
  for (const msg of anthropicMessages) {
    if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === 'tool_use' && block.id && block.name) {
          toolNameMap.set(block.id, block.name);
        }
      }
    }
  }

  if (system) {
    const systemText = typeof system === 'string'
      ? system
      : system.map(s => s.text || '').join('\n');
    jbMessages.push({ type: 'system_message', content: systemText });
  }

  for (const msg of anthropicMessages) {
    switch (msg.role) {
      case 'user':
        if (typeof msg.content === 'string') {
          jbMessages.push({ type: 'user_message', content: msg.content });
        } else if (Array.isArray(msg.content)) {
          const images = msg.content.filter(c => c.type === 'image');
          const texts = msg.content.filter(c => c.type === 'text');
          const toolResults = msg.content.filter(c => c.type === 'tool_result');

          for (const img of images) {
            jbMessages.push({
              type: 'media_message',
              mediaType: img.source.media_type,
              data: img.source.data,
            });
          }

          if (texts.length > 0) {
            jbMessages.push({
              type: 'user_message',
              content: texts.map(t => t.text).join('\n'),
            });
          }

          for (const tr of toolResults) {
            const resultContent = typeof tr.content === 'string'
              ? tr.content
              : (Array.isArray(tr.content)
                ? tr.content.map(c => c.text || '').join('\n')
                : JSON.stringify(tr.content));
            jbMessages.push({
              type: 'tool_message',
              id: tr.tool_use_id,
              toolName: toolNameMap.get(tr.tool_use_id) || '',
              result: resultContent,
            });
          }
        }
        break;

      case 'assistant':
        if (typeof msg.content === 'string') {
          jbMessages.push({ type: 'assistant_message_text', content: msg.content });
        } else if (Array.isArray(msg.content)) {
          const textParts = msg.content.filter(c => c.type === 'text');
          const toolUses = msg.content.filter(c => c.type === 'tool_use');

          if (textParts.length > 0) {
            jbMessages.push({
              type: 'assistant_message_text',
              content: textParts.map(t => t.text).join('\n'),
            });
          }

          for (const tu of toolUses) {
            jbMessages.push({
              type: 'assistant_message_tool',
              id: tu.id,
              toolName: tu.name,
              content: JSON.stringify(tu.input || {}),
            });
          }
        }
        break;
    }
  }

  return jbMessages;
}

module.exports = { convertRequest, convertMessages };
