// models-cache.js — 上游模型列表缓存
// 启动时不主动拉，前端点"同步模型"按钮才从 JB 拉一次写入磁盘。
// /v1/models 优先读缓存，缓存空时返回内置 fallback（保证 Cursor 启动不卡）。
const fs = require('fs');
const path = require('path');

const CACHE_FILE = path.join(__dirname, '..', 'models_cache.json');

// 内置 fallback：当缓存空且首次同步前的兜底列表（手填 Claude + GPT-5）
const FALLBACK_MODELS = [
  { id: 'anthropic-claude-4-7-opus', owned_by: 'Anthropic' },
  { id: 'anthropic-claude-4-6-opus', owned_by: 'Anthropic' },
  { id: 'anthropic-claude-4-6-sonnet', owned_by: 'Anthropic' },
  { id: 'anthropic-claude-4-5-opus', owned_by: 'Anthropic' },
  { id: 'anthropic-claude-4-5-sonnet', owned_by: 'Anthropic' },
  { id: 'anthropic-claude-4-5-haiku', owned_by: 'Anthropic' },
  { id: 'openai-gpt-5', owned_by: 'OpenAI' },
  { id: 'openai-gpt-4o', owned_by: 'OpenAI' },
];

// 模型元信息：记录原生 thinking 支持情况
// 同步时从 JB profiles 提取 chatDefinition.parameters，判断每个模型支持哪种原生 thinking
let _cache = null;

function load() {
  if (_cache) return _cache;
  try {
    const raw = fs.readFileSync(CACHE_FILE, 'utf-8').replace(/^\uFEFF/, '');
    _cache = JSON.parse(raw);
  } catch {
    _cache = null;
  }
  return _cache;
}

function save(data) {
  fs.writeFileSync(CACHE_FILE, JSON.stringify(data, null, 2));
  _cache = data;
}

// 从 JB 拉一次完整 profiles 并解析、写入缓存
//  jbGetProfiles: jb-client 的 getProfiles 函数
//  ensureValidJwt: 拿一个有效 jwt
async function syncFromJB(jwt, jbGetProfiles) {
  const profiles = await jbGetProfiles(jwt);
  const items = (profiles.profiles || []).map(p => {
    const params = (p.chatDefinition?.parameters || []).map(x => x.fqdn);
    const supportsReasoningEffort = params.includes('llm.parameters.reasoning-effort');
    const supportsThinkingBudget = params.includes('llm.parameters.thinking-budget');
    return {
      id: p.id,
      modelName: p.modelName || p.id,
      provider: p.provider || 'jetbrains',
      contextLimit: p.contextLimit || 0,
      maxOutputTokens: p.maxOutputTokens || 0,
      deprecated: !!p.deprecated,
      experimental: !!p.experimental,
      supportsReasoningEffort,
      supportsThinkingBudget,
    };
  });
  // 过滤掉 deprecated/embedding/completion 类（只留聊天可用）
  const usable = items.filter(m =>
    !m.deprecated &&
    !/embedding|moderation|whisper|tts/i.test(m.id)
  );
  const data = {
    synced_at: Date.now(),
    count: usable.length,
    models: usable,
  };
  save(data);
  return data;
}

// 给 /v1/models 用：返回 OpenAI 兼容的模型列表（含 -thinking/-maxthinking/-low/-medium/-high 变体）
function listForOpenAI() {
  const c = load();
  const base = c?.models?.length ? c.models : FALLBACK_MODELS.map(m => ({
    ...m, supportsReasoningEffort: false, supportsThinkingBudget: false, modelName: m.id, provider: m.owned_by,
  }));

  const out = [];
  for (const m of base) {
    out.push({ id: m.id, object: 'model', created: 0, owned_by: m.provider });

    // OpenAI o-系 / GPT-5 系：原生 reasoning-effort，提供 -low/-medium/-high
    if (m.supportsReasoningEffort) {
      for (const lvl of ['low', 'medium', 'high']) {
        out.push({ id: `${m.id}-${lvl}`, object: 'model', created: 0, owned_by: m.provider });
      }
    }
    // Anthropic / 不支持原生 thinking 的模型：用 prompt 注入（-thinking / -maxthinking）
    if (m.provider === 'Anthropic' || (!m.supportsReasoningEffort && !m.supportsThinkingBudget && /claude|sonnet|opus|haiku|grok/i.test(m.id))) {
      // 跳过已经是 thinking 衍生的（防止重复）
      if (!/-(thinking|maxthinking|low|medium|high)$/.test(m.id)) {
        out.push({ id: `${m.id}-thinking`, object: 'model', created: 0, owned_by: m.provider });
        out.push({ id: `${m.id}-maxthinking`, object: 'model', created: 0, owned_by: m.provider });
      }
    }
    // Gemini 系：原生 thinking-budget（用 -thinking 表示开启高 budget）
    if (m.supportsThinkingBudget && !m.supportsReasoningEffort) {
      out.push({ id: `${m.id}-thinking`, object: 'model', created: 0, owned_by: m.provider });
      out.push({ id: `${m.id}-maxthinking`, object: 'model', created: 0, owned_by: m.provider });
    }
  }
  return out;
}

// 给请求处理用：解析模型名，返回真实 profile + thinking 模式
//  返回 { profile, mode, level }
//   mode = 'native_reasoning_effort' | 'native_thinking_budget' | 'prompt_inject' | 'none'
//   level = 'low' | 'medium' | 'high' | 'standard' | 'max'  （根据 mode 取值）
function resolveModel(model) {
  if (!model) return { profile: model, mode: 'none' };

  // 优先匹配 -low/-medium/-high（原生 reasoning-effort）
  const re1 = /^(.+)-(low|medium|high)$/.exec(model);
  if (re1) {
    const base = re1[1];
    const level = re1[2];
    const meta = findMeta(base);
    if (meta?.supportsReasoningEffort) {
      return { profile: base, mode: 'native_reasoning_effort', level };
    }
  }

  // -maxthinking
  if (model.endsWith('-maxthinking')) {
    const base = model.slice(0, -'-maxthinking'.length);
    const meta = findMeta(base);
    if (meta?.supportsThinkingBudget) {
      return { profile: base, mode: 'native_thinking_budget', level: 'max' };
    }
    // fallback: prompt 注入（Anthropic / 兜底）
    return { profile: base, mode: 'prompt_inject', level: 'max' };
  }

  // -thinking
  if (model.endsWith('-thinking')) {
    const base = model.slice(0, -'-thinking'.length);
    const meta = findMeta(base);
    if (meta?.supportsThinkingBudget) {
      return { profile: base, mode: 'native_thinking_budget', level: 'standard' };
    }
    return { profile: base, mode: 'prompt_inject', level: 'standard' };
  }

  return { profile: model, mode: 'none' };
}

function findMeta(modelId) {
  const c = load();
  if (!c?.models) return null;
  return c.models.find(m => m.id === modelId);
}

function info() {
  const c = load();
  return c
    ? { synced: true, synced_at: c.synced_at, count: c.count }
    : { synced: false, synced_at: 0, count: 0 };
}

module.exports = {
  syncFromJB,
  listForOpenAI,
  resolveModel,
  info,
};
