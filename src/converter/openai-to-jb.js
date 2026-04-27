const { openaiToolsToJB, buildParametersData } = require('./tools');

// ── prompt 注入：写代码场景优化的 thinking 提示 ──
// 设计依据：Anthropic 官方 prompt-engineering 指南 + rokwuky 实测验证
// 关键点：用 <thinking> XML 标签（Anthropic 推荐）、显式 self-check、避免 over-thinking 简单任务
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
 * Convert OpenAI /v1/chat/completions request body to JB Grazie request body.
 * resolved: { profile, mode, level } from models-cache.resolveModel
 *   mode = 'native_reasoning_effort' | 'native_thinking_budget' | 'prompt_inject' | 'none'
 */
function convertRequest(openaiBody, resolved = {}) {
  // 1) prompt 注入：往 messages 头插 system 提示
  let messages = openaiBody.messages || [];
  if (resolved.mode === 'prompt_inject') {
    const sys = resolved.level === 'max' ? MAXTHINKING_SYSTEM : THINKING_SYSTEM;
    // 已有 system → 合并到第一个 system 后面；否则插到最前
    const idx = messages.findIndex(m => m.role === 'system' || m.role === 'developer');
    if (idx >= 0) {
      const orig = messages[idx];
      const origText = typeof orig.content === 'string' ? orig.content : (Array.isArray(orig.content) ? orig.content.filter(c => c.type === 'text').map(c => c.text).join('\n') : '');
      messages = [
        ...messages.slice(0, idx),
        { role: 'system', content: origText + '\n\n' + sys },
        ...messages.slice(idx + 1),
      ];
    } else {
      messages = [{ role: 'system', content: sys }, ...messages];
    }
  }

  const jbMessages = convertMessages(messages);
  const toolsData = openaiToolsToJB(openaiBody.tools);

  // 2) 原生参数：reasoning-effort / thinking-budget
  const extraParams = [];
  if (resolved.mode === 'native_reasoning_effort' && resolved.level) {
    extraParams.push(
      { type: 'text', fqdn: 'llm.parameters.reasoning-effort' },
      { type: 'text', value: resolved.level },
    );
  } else if (resolved.mode === 'native_thinking_budget') {
    // standard ≈ 8000, max ≈ 24000（Gemini 系上限通常 24K）
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
    profile: resolved.profile || openaiBody.model,
    chat: { messages: jbMessages },
    parameters: allParams.length > 0 ? { data: allParams } : undefined,
  };
}

function convertMessages(openaiMessages) {
  const jbMessages = [];
  const toolNameMap = new Map();
  for (const msg of openaiMessages) {
    if (msg.role === 'assistant' && msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        if (tc.id && tc.function?.name) toolNameMap.set(tc.id, tc.function.name);
      }
    }
  }

  for (const msg of openaiMessages) {
    switch (msg.role) {
      case 'system':
      case 'developer':
        jbMessages.push({ type: 'system_message', content: extractTextContent(msg.content) });
        break;
      case 'user':
        if (Array.isArray(msg.content)) {
          const images = msg.content.filter(c => c.type === 'image_url');
          const texts = msg.content.filter(c => c.type === 'text');
          for (const img of images) {
            const { mediaType, data } = parseImageUrl(img.image_url.url);
            jbMessages.push({ type: 'media_message', mediaType, data });
          }
          jbMessages.push({ type: 'user_message', content: texts.map(t => t.text).join('\n') });
        } else {
          jbMessages.push({ type: 'user_message', content: msg.content || '' });
        }
        break;
      case 'assistant':
        if (msg.tool_calls && msg.tool_calls.length > 0) {
          if (msg.content) jbMessages.push({ type: 'assistant_message_text', content: msg.content });
          for (const tc of msg.tool_calls) {
            jbMessages.push({
              type: 'assistant_message_tool',
              id: tc.id, toolName: tc.function.name,
              content: tc.function.arguments || '{}',
            });
          }
        } else {
          jbMessages.push({ type: 'assistant_message_text', content: extractTextContent(msg.content) });
        }
        break;
      case 'tool':
        jbMessages.push({
          type: 'tool_message',
          id: msg.tool_call_id,
          toolName: msg.name || toolNameMap.get(msg.tool_call_id) || '',
          result: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
        });
        break;
    }
  }
  return jbMessages;
}

function extractTextContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.filter(c => c.type === 'text').map(c => c.text).join('\n');
  }
  return '';
}

function parseImageUrl(url) {
  const dataUrlMatch = url.match(/^data:(image\/[^;]+);base64,(.+)$/);
  if (dataUrlMatch) return { mediaType: dataUrlMatch[1], data: dataUrlMatch[2] };
  return { mediaType: 'image/png', data: url };
}

module.exports = { convertRequest, convertMessages };
