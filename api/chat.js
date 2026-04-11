import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_BASE_URL = 'https://api.minimaxi.com/v1';
const DEFAULT_MODEL = 'MiniMax-M2.5';

let kbCache = null;

function readContentText(content) {
  if (typeof content === 'string') {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') {
          return part;
        }
        if (part && typeof part === 'object' && typeof part.text === 'string') {
          return part.text;
        }
        return '';
      })
      .join('');
  }

  return '';
}

function stripReasoningTags(text) {
  return text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

function parseAnswerPayload(text, allowedProductIds) {
  const cleaned = stripReasoningTags(text);
  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);

  if (!jsonMatch) {
    return {
      answer: cleaned || '我已收到你的问题，你可以继续补充预算、用途或偏好。',
      picks: []
    };
  }

  try {
    const parsed = JSON.parse(jsonMatch[0]);
    const answer = typeof parsed.answer === 'string' && parsed.answer.trim() ? parsed.answer.trim() : '我已收到你的问题，你可以继续补充预算、用途或偏好。';

    const picks = Array.isArray(parsed.picks)
      ? parsed.picks
          .filter((item) => typeof item === 'string' && allowedProductIds.includes(item))
          .slice(0, 4)
      : [];

    return { answer, picks };
  } catch (_error) {
    return {
      answer: cleaned || '我已收到你的问题，你可以继续补充预算、用途或偏好。',
      picks: []
    };
  }
}

function loadKbDevices() {
  if (kbCache) {
    return kbCache;
  }

  const kbPath = path.join(process.cwd(), 'data', 'apple_kb.json');
  const raw = fs.readFileSync(kbPath, 'utf-8');
  const parsed = JSON.parse(raw);
  kbCache = Array.isArray(parsed?.devices) ? parsed.devices : [];
  return kbCache;
}

function normalizeText(text) {
  return String(text || '').toLowerCase().trim();
}

function tokenize(query) {
  const normalized = normalizeText(query);
  const hits = normalized.match(/[a-z0-9+.#\-]{2,}|[\u4e00-\u9fff]{1,}/g);
  return hits ? Array.from(new Set(hits)) : [];
}

function categoryHints() {
  return {
    iphone: ['iphone', '手机', '拍照', '影像'],
    ipad: ['ipad', '平板', '绘画', '学习'],
    mac: ['mac', 'macbook', '笔记本', '电脑', '剪辑', '开发'],
    watch: ['watch', '手表', '运动', '健康'],
    airpods: ['airpods', '耳机', '降噪', '通话'],
    homepod: ['homepod', '音箱', '智能家居'],
    vision: ['vision', '空间计算', '头显']
  };
}

function scoreDevice(device, query, tokens) {
  const q = normalizeText(query);
  const name = normalizeText(device.name);
  const desc = normalizeText(device.description || '');
  const category = normalizeText(device.category || '');
  const params = Array.isArray(device.parameters) ? device.parameters : [];

  let score = 0;

  if (q && name.includes(q)) {
    score += 10;
  }

  for (const token of tokens) {
    if (name.includes(token)) {
      score += 4;
    }
    if (desc.includes(token)) {
      score += 2;
    }
    for (const param of params.slice(0, 10)) {
      const key = normalizeText(param?.name || '');
      const value = normalizeText(param?.value || '');
      if (key.includes(token) || value.includes(token)) {
        score += 1;
        break;
      }
    }
  }

  const hints = categoryHints()[category] || [];
  for (const hint of hints) {
    if (q.includes(normalizeText(hint))) {
      score += 2;
    }
  }

  return score;
}

function selectCandidates(devices, query, options) {
  const { detailOpen, currentProductId, allowedProductIds } = options;
  const allowedSet = new Set(allowedProductIds);
  const pool = devices.filter((item) => allowedSet.has(item.id));
  const tokens = tokenize(query);

  const scored = pool
    .map((item) => ({ item, score: scoreDevice(item, query, tokens) }))
    .sort((a, b) => b.score - a.score);

  let candidates = scored.filter((entry) => entry.score > 0).map((entry) => entry.item);
  if (!candidates.length) {
    candidates = scored.map((entry) => entry.item);
  }

  if (detailOpen && currentProductId) {
    const current = pool.find((item) => item.id === currentProductId);
    if (current) {
      candidates = [current, ...candidates.filter((item) => item.id !== currentProductId)];
    }
  }

  return candidates.slice(0, 8);
}

function digestCandidates(candidates) {
  return candidates
    .map((item) => {
      const paramLines = (Array.isArray(item.parameters) ? item.parameters : [])
        .slice(0, 4)
        .map((param) => `${param.name}: ${param.value}`)
        .join(' | ');

      return [
        `id: ${item.id}`,
        `name: ${item.name}`,
        `category: ${item.category}`,
        `price: ${item.price_text || '官网可选配置'}`,
        `description: ${item.description || ''}`,
        `params: ${paramLines}`
      ].join('\n');
    })
    .join('\n\n');
}

function fallbackAnswer(query, candidates, detailOpen) {
  const picks = candidates.slice(0, 4).map((item) => item.id);

  if (!candidates.length) {
    return {
      answer: '我暂时没匹配到合适设备，你可以告诉我预算、用途或偏好，我再帮你缩小范围。',
      picks: []
    };
  }

  const top = candidates[0];

  if (detailOpen) {
    const params = (top.parameters || []).slice(0, 3).map((item) => `${item.name}：${item.value}`).join('；');
    return {
      answer: `${top.name} 的核心信息：${params || '可在技术规格页查看详细参数'}。`,
      picks
    };
  }

  return {
    answer: `我先给你推荐 ${top.name} 等 ${Math.min(4, candidates.length)} 款设备，继续告诉我预算和使用场景，我可以进一步精确推荐。`,
    picks
  };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const apiKey = process.env.MINIMAX_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: 'Missing MINIMAX_API_KEY environment variable' });
    return;
  }

  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
  const query = typeof body.query === 'string' ? body.query.trim() : '';

  if (!query) {
    res.status(400).json({ error: 'query is required' });
    return;
  }

  const context = body.context && typeof body.context === 'object' ? body.context : {};
  const detailOpen = Boolean(context.detailOpen);
  const currentProductId = typeof context.currentProductId === 'string' ? context.currentProductId : null;
  const viewedProductIds = Array.isArray(context.viewedProductIds)
    ? context.viewedProductIds.filter((item) => typeof item === 'string').slice(0, 20)
    : [];
  const allowedProductIds = Array.isArray(context.allowedProductIds)
    ? context.allowedProductIds.filter((item) => typeof item === 'string').slice(0, 80)
    : [];

  let devices = [];
  try {
    devices = loadKbDevices();
  } catch (error) {
    res.status(500).json({ error: 'Failed to load apple_kb.json', detail: String(error?.message || error) });
    return;
  }

  const candidates = selectCandidates(devices, query, {
    detailOpen,
    currentProductId,
    allowedProductIds
  });

  const candidateDigest = digestCandidates(candidates);

  const systemPrompt = [
    '你是 Apple 中国官网设备导购 anna。',
    '你只能基于提供的「候选设备知识摘要」回答。',
    '如果摘要不足以回答，要明确说明并建议用户进一步限定需求。',
    '回答要中文、简洁、可执行。',
    '必须输出严格 JSON，且只能包含两个字段：',
    '{"answer":"...","picks":["id1","id2"]}',
    '规则：',
    '1) answer 不超过 140 字。',
    '2) picks 只能从 allowedProductIds 里选，最多 4 个。',
    '3) detailOpen=true 时优先围绕 currentProductId 回答。',
    '4) 严禁输出 markdown、代码块或额外字段。'
  ].join('\n');

  const userPrompt = JSON.stringify(
    {
      query,
      detailOpen,
      currentProductId,
      viewedProductIds,
      allowedProductIds,
      candidateDeviceIds: candidates.map((item) => item.id),
      candidateDigest
    },
    null,
    2
  );

  const baseUrl = (process.env.MINIMAX_BASE_URL || DEFAULT_BASE_URL).replace(/\/$/, '');
  const model = process.env.MINIMAX_MODEL || DEFAULT_MODEL;

  try {
    const upstream = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        temperature: 0.3,
        max_tokens: 360
      })
    });

    if (!upstream.ok) {
      const local = fallbackAnswer(query, candidates, detailOpen);
      res.status(200).json(local);
      return;
    }

    const data = await upstream.json();
    const content = readContentText(data?.choices?.[0]?.message?.content || '');
    const result = parseAnswerPayload(content, allowedProductIds);

    if (!result.picks.length) {
      result.picks = candidates.slice(0, 4).map((item) => item.id);
    }

    res.status(200).json(result);
  } catch (_error) {
    const local = fallbackAnswer(query, candidates, detailOpen);
    res.status(200).json(local);
  }
}
