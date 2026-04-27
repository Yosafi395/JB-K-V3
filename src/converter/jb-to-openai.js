const { v4: uuidv4 } = require('uuid');

/**
 * Parse JB SSE stream and convert to OpenAI SSE format or buffered JSON.
 * options:
 *   promptInject: true 时启用 <thinking>...</thinking> 标签解析，把标签内文本输出到 delta.reasoning_content
 */
async function convertStreamToOpenAI(jbStream, res, model, stream = true, options = {}) {
  const id = `chatcmpl-${uuidv4().replace(/-/g, '').slice(0, 24)}`;
  const created = Math.floor(Date.now() / 1000);
  const promptInject = !!options.promptInject;

  if (stream) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    // X-Accel-Buffering 关闭 nginx/反向代理的 buffer，让 SSE 实时下发
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
  }

  // ── 客户端断开检测 ──
  // Cursor 等客户端在等不及时会断开连接；继续 res.write 会抛 ERR_STREAM_WRITE_AFTER_END
  // 用 clientAborted 标志位 + close/error 监听一次，主循环每轮检查
  let clientAborted = false;
  const onClose = () => { clientAborted = true; };
  if (stream) {
    res.once('close', onClose);
    res.once('error', onClose);
  }

  // 安全 write：socket 已关闭就不写，避免崩溃
  const safeWrite = (chunk) => {
    if (clientAborted || res.writableEnded || res.destroyed) return false;
    try { res.write(chunk); return true; }
    catch { clientAborted = true; return false; }
  };

  const buffer = { content: '', reasoning: '', tool_calls: [], finish_reason: null };
  const activeToolCalls = new Map();

  // <thinking> 流式状态机：
  //   inThinking = false → 默认全部 content
  //   inThinking = true  → 文本进 reasoning_content
  //   pending: 累积可能跨 chunk 的部分标签字符（如 "<th"）
  const thinkingState = { inThinking: false, pending: '' };

  const decoder = new TextDecoder();
  let leftover = '';

  try {
    for await (const chunk of jbStream) {
      // 客户端早断：尽快终止 JB 流读取，避免空跑浪费 token
      if (clientAborted) {
        try { jbStream.destroy?.(); } catch {}
        break;
      }

      const text = leftover + decoder.decode(chunk, { stream: true });
      const lines = text.split('\n');
      leftover = lines.pop() || '';

      for (const line of lines) {
        if (clientAborted) break;
        if (!line.startsWith('data: ')) continue;
        const dataStr = line.slice(6).trim();
        if (dataStr === 'end' || dataStr === '') continue;

        let event;
        try { event = JSON.parse(dataStr); } catch { continue; }

        if (event.type === 'Content') {
          const raw = event.content || '';
          if (promptInject) {
            // 流式拆分
            const parts = splitThinking(raw, thinkingState);
            for (const part of parts) {
              if (part.kind === 'thinking' && part.text) {
                if (stream) {
                  safeWrite(`data: ${JSON.stringify(makeChunk(id, created, model, { reasoning_content: part.text }))}\n\n`);
                } else {
                  buffer.reasoning += part.text;
                }
              } else if (part.kind === 'content' && part.text) {
                if (stream) {
                  safeWrite(`data: ${JSON.stringify(makeChunk(id, created, model, { content: part.text }))}\n\n`);
                } else {
                  buffer.content += part.text;
                }
              }
            }
          } else {
            if (stream) {
              safeWrite(`data: ${JSON.stringify(makeChunk(id, created, model, { content: raw }))}\n\n`);
            } else {
              buffer.content += raw;
            }
          }
        } else if (event.type === 'ToolCall') {
          const idx = event.parallelToolIndex || 0;
          if (event.id && event.name) {
            activeToolCalls.set(idx, { id: event.id, name: event.name, arguments: '' });
            if (stream) {
              safeWrite(`data: ${JSON.stringify(makeChunk(id, created, model, {
                tool_calls: [{ index: idx, id: event.id, type: 'function', function: { name: event.name, arguments: '' } }],
              }))}\n\n`);
            }
          } else if (event.content) {
            const tc = activeToolCalls.get(idx);
            if (tc) tc.arguments += event.content;
            if (stream) {
              safeWrite(`data: ${JSON.stringify(makeChunk(id, created, model, {
                tool_calls: [{ index: idx, function: { arguments: event.content } }],
              }))}\n\n`);
            }
          }
        } else if (event.type === 'FinishMetadata') {
          const finishReason = event.reason === 'tool_call' ? 'tool_calls' : 'stop';
          if (promptInject && thinkingState.pending) {
            const tail = thinkingState.pending;
            thinkingState.pending = '';
            if (tail) {
              if (stream) {
                const key = thinkingState.inThinking ? 'reasoning_content' : 'content';
                safeWrite(`data: ${JSON.stringify(makeChunk(id, created, model, { [key]: tail }))}\n\n`);
              } else {
                if (thinkingState.inThinking) buffer.reasoning += tail;
                else buffer.content += tail;
              }
            }
          }
          if (stream) {
            safeWrite(`data: ${JSON.stringify(makeChunk(id, created, model, {}, finishReason))}\n\n`);
          } else {
            buffer.finish_reason = finishReason;
            for (const [, tc] of activeToolCalls) {
              buffer.tool_calls.push({
                id: tc.id, type: 'function',
                function: { name: tc.name, arguments: tc.arguments },
              });
            }
          }
        }
      }
    }
  } catch (err) {
    // 客户端断开类错误：静默吞
    const isClientErr = clientAborted || /ECONNRESET|write after end|aborted|EPIPE/i.test(err.message);
    if (isClientErr) {
      // do nothing
    } else if (stream && res.headersSent) {
      // 流已经开始 → 不能重试（已写部分 content 到 Cursor）→ 发错误事件后正常结束
      console.error('[stream] mid-stream error:', err.message);
      try {
        safeWrite(`data: ${JSON.stringify({ error: { message: err.message, type: 'upstream_stream_error' } })}\n\n`);
      } catch {}
    } else {
      // 非流式 / headers 还没发 → 让外层捕获重试
      throw err;
    }
  } finally {
    if (stream) {
      res.removeListener('close', onClose);
      res.removeListener('error', onClose);
    }
  }

  if (stream) {
    safeWrite('data: [DONE]\n\n');
    if (!res.writableEnded && !clientAborted) {
      try { res.end(); } catch {}
    }
  } else {
    const message = { role: 'assistant', content: buffer.content || null };
    if (buffer.reasoning) message.reasoning_content = buffer.reasoning;
    const response = {
      id, object: 'chat.completion', created, model,
      choices: [{ index: 0, message, finish_reason: buffer.finish_reason || 'stop' }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    };
    if (buffer.tool_calls.length > 0) {
      response.choices[0].message.tool_calls = buffer.tool_calls;
      if (!buffer.content) response.choices[0].message.content = null;
    }
    res.json(response);
  }
}

// 流式拆分 raw 文本为 [{kind:'thinking'|'content', text}] 数组
// 状态机维护 inThinking + pending（跨 chunk 标签）
function splitThinking(raw, state) {
  const parts = [];
  // 先把 pending 加到本 chunk 前（pending 是上一 chunk 末尾可能未闭合的标签前缀）
  let buf = state.pending + raw;
  state.pending = '';

  while (buf.length > 0) {
    if (state.inThinking) {
      const closeIdx = buf.indexOf('</thinking>');
      if (closeIdx === -1) {
        // 没找到关闭标签：末尾最多 11 个字符（"</thinking>"长度 11）可能是部分标签，留到 pending
        const safeLen = Math.max(0, buf.length - 11);
        if (safeLen > 0) parts.push({ kind: 'thinking', text: buf.slice(0, safeLen) });
        state.pending = buf.slice(safeLen);
        return parts;
      }
      // 找到关闭：thinking 部分输出
      if (closeIdx > 0) parts.push({ kind: 'thinking', text: buf.slice(0, closeIdx) });
      buf = buf.slice(closeIdx + '</thinking>'.length);
      state.inThinking = false;
    } else {
      const openIdx = buf.indexOf('<thinking>');
      if (openIdx === -1) {
        // 末尾最多 10 个字符（"<thinking>"长度 10）可能是部分 "<thinking>" 前缀，留到 pending
        const safeLen = Math.max(0, buf.length - 10);
        if (safeLen > 0) parts.push({ kind: 'content', text: buf.slice(0, safeLen) });
        state.pending = buf.slice(safeLen);
        return parts;
      }
      if (openIdx > 0) parts.push({ kind: 'content', text: buf.slice(0, openIdx) });
      buf = buf.slice(openIdx + '<thinking>'.length);
      state.inThinking = true;
    }
  }
  return parts;
}

function makeChunk(id, created, model, delta, finishReason = null) {
  return {
    id, object: 'chat.completion.chunk', created, model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

module.exports = { convertStreamToOpenAI, splitThinking };
