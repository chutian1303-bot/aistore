import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_BASE_URL = 'https://api.minimaxi.com/v1';
const DEFAULT_MODEL = 'MiniMax-M2.5';
const RECOMMENDATION_COUNT = 20;
const CANDIDATE_POOL_SIZE = 32;

let catalogCache = null;

function cleanEnvValue(raw, fallback = '') {
  const value = typeof raw === 'string' ? raw : '';
  const cleaned = value.replace(/\\n/g, '').trim();
  if (cleaned) {
    return cleaned;
  }
  return fallback;
}

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

function safeParseJson(raw) {
  if (!raw || typeof raw !== 'string') {
    return {};
  }
  try {
    return JSON.parse(raw);
  } catch (_error) {
    return {};
  }
}

function stripReasoningTags(text) {
  return String(text || '')
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    .replace(/```json/gi, '')
    .replace(/```/g, '')
    .trim();
}

function uniqueStrings(list) {
  return Array.from(new Set(list.filter((item) => typeof item === 'string' && item.trim()).map((item) => item.trim())));
}

function tryParseJsonObject(raw) {
  const text = String(raw || '').trim();
  if (!text) {
    return null;
  }

  const attempts = [text];
  const objectSlice = text.match(/\{[\s\S]*\}/);
  if (objectSlice && objectSlice[0] !== text) {
    attempts.push(objectSlice[0]);
  }

  for (const candidate of attempts) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed;
      }
      if (typeof parsed === 'string') {
        try {
          const nested = JSON.parse(parsed);
          if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
            return nested;
          }
        } catch (_nestedError) {
          // ignore nested parse errors
        }
      }
    } catch (_error) {
      // ignore parse errors
    }
  }

  return null;
}

function normalizeAnswerText(answer) {
  return String(answer || '')
    .replace(/\s+/g, ' ')
    .replace(/^\s*[{[]\s*"answer"\s*:/i, '')
    .trim();
}

function isReasoningLeak(text) {
  const value = normalizeText(text);
  const leakPhrases = [
    '用户问的是',
    '让我分析',
    '我需要',
    '候选商品',
    '思考过程',
    'let me',
    'analysis'
  ];
  return leakPhrases.some((phrase) => value.includes(normalizeText(phrase)));
}

function isAnswerUsable(answer) {
  const text = normalizeAnswerText(answer);
  if (!text) {
    return false;
  }
  if (text.length < 28 || text.length > 180) {
    return false;
  }
  if (isReasoningLeak(text)) {
    return false;
  }
  if (text.startsWith('{') || text.startsWith('["') || text.includes('"answer":')) {
    return false;
  }
  return true;
}

function parseAnswerPayload(text, pickWhitelist) {
  const cleaned = stripReasoningTags(text);
  const parsed = tryParseJsonObject(cleaned);
  const allowSet = new Set(pickWhitelist);

  if (!parsed) {
    const fallback = normalizeAnswerText(cleaned);
    return {
      answer: isAnswerUsable(fallback) ? fallback : '',
      picks: []
    };
  }

  const answer = normalizeAnswerText(parsed.answer);
  const picks = Array.isArray(parsed.picks)
    ? parsed.picks
        .filter((item) => typeof item === 'string' && allowSet.has(item))
        .slice(0, RECOMMENDATION_COUNT)
    : [];

  return {
    answer: isAnswerUsable(answer) ? answer : '',
    picks
  };
}

function normalizeText(text) {
  return String(text || '').toLowerCase().trim();
}

function formatMoney(value) {
  return `¥${Math.round(value).toLocaleString('zh-CN')}`;
}

function normalizePriceText(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return formatMoney(value);
  }

  if (typeof value === 'string') {
    const cleaned = value
      .replace(/\{[^}]+\}/g, '')
      .replace(/\$price\.display\.monthlyFrom\*/g, '官网价')
      .replace(/\s+/g, ' ')
      .trim();
    return cleaned || '官网可选配置';
  }

  return '官网可选配置';
}

function toNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return null;
}

function normalizeParameters(raw) {
  if (!Array.isArray(raw)) {
    return [];
  }

  return raw
    .map((item) => {
      if (!item || typeof item !== 'object') {
        return null;
      }
      const name = typeof item.name === 'string' ? item.name.trim() : '';
      const value = typeof item.value === 'string' ? item.value.trim() : '';
      if (!name || !value) {
        return null;
      }
      return { name: name.slice(0, 64), value: value.slice(0, 260) };
    })
    .filter(Boolean);
}

function normalizeCatalogProduct(raw, index) {
  const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : `apple-${index + 1}`;
  const category = typeof raw.category === 'string' && raw.category.trim() ? raw.category.trim() : 'apple';
  const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : `Apple 商品 ${index + 1}`;
  const description =
    typeof raw.desc === 'string' && raw.desc.trim()
      ? raw.desc.trim()
      : typeof raw.description === 'string' && raw.description.trim()
        ? raw.description.trim()
        : 'Apple 中国官网在售商品。';
  const priceText = normalizePriceText(raw.price);
  const officialPrice = toNumber(raw.officialPrice);
  const explicitFinalPrice = toNumber(raw.finalPrice);
  const finalPrice =
    explicitFinalPrice && explicitFinalPrice > 0
      ? Math.round(explicitFinalPrice)
      : officialPrice && officialPrice > 0
        ? Math.round(officialPrice * 0.8)
        : null;
  const explicitDiscount = toNumber(raw.discountAmount);
  const discountAmount =
    explicitDiscount && explicitDiscount > 0
      ? Math.round(explicitDiscount)
      : officialPrice && finalPrice
        ? Math.max(0, Math.round(officialPrice - finalPrice))
        : null;
  const parameters = normalizeParameters(raw.parameters);
  const fullParameters = normalizeParameters(raw.fullParameters);
  const specsUrl = typeof raw.specsUrl === 'string' ? raw.specsUrl.trim() : '';
  const compatibilityModels = Array.isArray(raw.compatibilityModels)
    ? raw.compatibilityModels.map((item) => String(item || '').trim()).filter(Boolean).slice(0, 80)
    : [];
  const compatibilityDeviceIds = Array.isArray(raw.compatibilityDeviceIds)
    ? raw.compatibilityDeviceIds.map((item) => String(item || '').trim()).filter(Boolean).slice(0, 80)
    : [];

  return {
    id,
    category,
    name,
    description,
    priceText,
    officialPrice: officialPrice && officialPrice > 0 ? Math.round(officialPrice) : null,
    discountAmount,
    finalPrice,
    parameters,
    fullParameters: fullParameters.length ? fullParameters : parameters,
    buyUrl: typeof raw.buyUrl === 'string' ? raw.buyUrl.trim() : '',
    detailUrl: typeof raw.detailUrl === 'string' ? raw.detailUrl.trim() : '',
    specsUrl,
    compatibilityModels,
    compatibilityDeviceIds
  };
}

function normalizeKbDevice(raw, index) {
  const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : `apple-kb-${index + 1}`;
  const category = typeof raw.category === 'string' && raw.category.trim() ? raw.category.trim() : 'apple';
  const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : `Apple 设备 ${index + 1}`;
  const description =
    typeof raw.description === 'string' && raw.description.trim() ? raw.description.trim() : 'Apple 中国官网在售设备。';

  return {
    id,
    category,
    name,
    description,
    priceText: normalizePriceText(raw.price_text || raw.price),
    officialPrice: null,
    discountAmount: null,
    finalPrice: null,
    parameters: normalizeParameters(raw.parameters),
    fullParameters: normalizeParameters(raw.full_parameters || raw.parameters),
    buyUrl: typeof raw.buyUrl === 'string' ? raw.buyUrl.trim() : '',
    detailUrl: typeof raw.detailUrl === 'string' ? raw.detailUrl.trim() : '',
    specsUrl: typeof raw.specs_url === 'string' ? raw.specs_url.trim() : '',
    compatibilityModels: [],
    compatibilityDeviceIds: Array.isArray(raw.compatibility_device_ids)
      ? raw.compatibility_device_ids.map((item) => String(item || '').trim()).filter(Boolean).slice(0, 80)
      : []
  };
}

function loadCatalog() {
  if (catalogCache) {
    return catalogCache;
  }

  const productPath = path.join(process.cwd(), 'data', 'apple_products.json');
  const kbPath = path.join(process.cwd(), 'data', 'apple_kb.json');

  let catalog = [];

  if (fs.existsSync(productPath)) {
    const raw = fs.readFileSync(productPath, 'utf-8');
    const parsed = JSON.parse(raw);
    const products = Array.isArray(parsed?.products) ? parsed.products : [];
    catalog = products.map((item, index) => normalizeCatalogProduct(item, index));
  }

  if (!catalog.length && fs.existsSync(kbPath)) {
    const raw = fs.readFileSync(kbPath, 'utf-8');
    const parsed = JSON.parse(raw);
    const devices = Array.isArray(parsed?.devices) ? parsed.devices : [];
    catalog = devices.map((item, index) => normalizeKbDevice(item, index));
  }

  if (!catalog.length) {
    throw new Error('No catalog data found in apple_products.json or apple_kb.json');
  }

  catalogCache = catalog;
  return catalogCache;
}

function tokenize(query) {
  const normalized = normalizeText(query);
  const hits = normalized.match(/[a-z0-9+.#\-]{2,}|[\u4e00-\u9fff]{1,}/g);
  return hits ? Array.from(new Set(hits)) : [];
}

function containsAny(text, words) {
  return words.some((word) => text.includes(normalizeText(word)));
}

function detectExplicitCategory(query) {
  const q = normalizeText(query);
  if (!q) {
    return null;
  }

  if (containsAny(q, ['ipad', '平板'])) {
    return 'ipad';
  }
  if (containsAny(q, ['iphone', '手机'])) {
    return 'iphone';
  }
  if (containsAny(q, ['macbook', 'mac', '电脑', '笔记本'])) {
    return 'mac';
  }
  if (containsAny(q, ['watch', '手表'])) {
    return 'watch';
  }
  if (containsAny(q, ['airpods', '耳机'])) {
    return 'airpods';
  }
  if (containsAny(q, ['homepod', '音箱'])) {
    return 'homepod';
  }
  if (containsAny(q, ['vision', '头显'])) {
    return 'vision';
  }

  return null;
}

function categoryHints() {
  return {
    iphone: ['iphone', '手机', '影像', '拍照'],
    ipad: ['ipad', '平板', '学习', '画画', '创作'],
    mac: ['mac', 'macbook', '电脑', '笔记本', '开发', '剪辑', '办公'],
    watch: ['watch', '手表', '运动', '健康'],
    airpods: ['airpods', '耳机', '降噪', '通话'],
    homepod: ['homepod', '音箱', '家居', '智能家居'],
    vision: ['vision', '头显', '空间计算'],
    iphone_accessory: ['iphone', '手机壳', '贴膜', '配件'],
    ipad_accessory: ['ipad', '触控笔', '键盘', '配件'],
    mac_accessory: ['mac', '充电器', '扩展坞', '配件'],
    watch_accessory: ['watch', '表带', '配件'],
    airpods_accessory: ['airpods', '耳机', '配件'],
    vision_accessory: ['vision', '配件'],
    cross_device_accessory: ['配件', '充电', '线材', '电源'],
    general_accessory: ['配件', '保护', '连接']
  };
}

function queryIntentKeywords(query) {
  const q = normalizeText(query);
  const intents = [];
  const groups = [
    {
      name: 'battery',
      triggers: ['续航', '电池', '充电', '快充', '视频播放', '小时'],
      fields: ['续航', '电池', '充电', '快充', '视频播放', '流媒体', '小时', 'mah', '电量']
    },
    {
      name: 'screen',
      triggers: ['屏幕', '显示', '亮度', '刷新率', '分辨率', '尺寸', 'pro motion'],
      fields: ['屏幕', '显示', '亮度', '刷新率', '分辨率', '尺寸', 'nit', 'xdr', 'promotion']
    },
    {
      name: 'camera',
      triggers: ['拍照', '影像', '摄像', '镜头', '视频', '夜景', '变焦'],
      fields: ['摄像头', '镜头', '拍照', '影像', '视频', '变焦', '像素', '夜间', '录制']
    },
    {
      name: 'chip',
      triggers: ['芯片', '性能', '处理器', 'cpu', 'gpu', 'ai'],
      fields: ['芯片', '处理器', 'cpu', 'gpu', '神经网络', 'ai', '性能', '内存']
    },
    {
      name: 'compatibility',
      triggers: ['兼容', '适用于', '配件', '支持', '机型'],
      fields: ['兼容', '适用于', '支持', '机型', '配件']
    }
  ];

  for (const group of groups) {
    if (containsAny(q, group.triggers)) {
      intents.push(group);
    }
  }

  return intents;
}

function scoreParameterByQuery(parameter, query, intents) {
  const name = normalizeText(parameter?.name || '');
  const value = normalizeText(parameter?.value || '');
  const merged = `${name} ${value}`.trim();
  const q = normalizeText(query);
  let score = 0;

  if (!merged) {
    return score;
  }

  if (q && merged.includes(q)) {
    score += 20;
  }

  const tokens = tokenize(q).slice(0, 10);
  for (const token of tokens) {
    if (merged.includes(token)) {
      score += 3;
    }
  }

  for (const intent of intents) {
    for (const field of intent.fields) {
      if (merged.includes(normalizeText(field))) {
        score += 6;
      }
    }
  }

  if (/[0-9]/.test(merged)) {
    score += 1;
  }

  return score;
}

function prettifyParameter(param) {
  const rawName = String(param?.name || '');
  const rawValue = String(param?.value || '');

  const name = rawName
    .replace(/([^\d])\s*\d+(?=：)/g, '$1')
    .replace(/\s+/g, ' ')
    .replace(/：\s*$/, '')
    .trim();

  const value = rawValue
    .replace(/^\s*\d+\s*\/\s*/, '')
    .replace(/\s*\/\s*/g, '；')
    .replace(/(\D)\s+\d+\s*[，,]/g, '$1，')
    .replace(/\s+/g, ' ')
    .trim();

  return {
    name: name || rawName,
    value: value || rawValue
  };
}

function pickRelevantParameters(product, query, limit = 8) {
  const base = Array.isArray(product.fullParameters) && product.fullParameters.length
    ? product.fullParameters
    : Array.isArray(product.parameters)
      ? product.parameters
      : [];

  if (!base.length) {
    return [];
  }

  const intents = queryIntentKeywords(query);
  if (!query || !query.trim()) {
    return base.slice(0, limit).map(prettifyParameter);
  }

  const scored = base
    .map((item) => ({ item, score: scoreParameterByQuery(item, query, intents) }))
    .sort((a, b) => b.score - a.score);

  const strong = scored.filter((entry) => entry.score > 0).map((entry) => entry.item);
  if (strong.length) {
    return strong.slice(0, limit).map(prettifyParameter);
  }
  return base.slice(0, limit).map(prettifyParameter);
}

function hasBatteryEvidence(parameters) {
  const text = parameters.map((item) => `${item.name} ${item.value}`).join(' ');
  return containsAny(normalizeText(text), ['续航', '电池', '视频播放', '流媒体', '小时', '充电']);
}

function scoreProduct(product, query, tokens, options) {
  const { detailOpen, currentProductId, viewedSet, explicitCategory, accessoryIntent } = options;
  const q = normalizeText(query);
  const name = normalizeText(product.name);
  const desc = normalizeText(product.description || '');
  const category = normalizeText(product.category || '');
  const params = Array.isArray(product.parameters) ? product.parameters : [];

  let score = 0;

  if (detailOpen && currentProductId && product.id === currentProductId) {
    score += 80;
  }

  if (viewedSet.has(product.id)) {
    score += 5;
  }

  if (q && name.includes(q)) {
    score += 16;
  }

  for (const token of tokens) {
    if (name.includes(token)) {
      score += 5;
    }
    if (desc.includes(token)) {
      score += 2;
    }

    for (const param of params.slice(0, 12)) {
      const key = normalizeText(param?.name || '');
      const value = normalizeText(param?.value || '');
      if ((key && key.includes(token)) || (value && value.includes(token))) {
        score += 1;
        break;
      }
    }
  }

  if (containsAny(q, ['多少钱', '价格', '预算', '优惠', '折扣'])) {
    if (product.officialPrice || product.finalPrice) {
      score += 2;
    }
  }

  const hints = categoryHints()[category] || [];
  for (const hint of hints) {
    if (q.includes(normalizeText(hint))) {
      score += 2;
    }
  }

  if (!detailOpen && category.endsWith('_accessory') && containsAny(q, ['配件', '充电', '线', '壳', '保护'])) {
    score += 3;
  }

  if (explicitCategory) {
    const exactMatch = category === explicitCategory;
    const accessoryMatch = category === `${explicitCategory}_accessory`;
    const genericAccessory = category === 'cross_device_accessory' || category === 'general_accessory';

    if (accessoryIntent) {
      if (accessoryMatch) {
        score += 20;
      } else if (genericAccessory) {
        score += 10;
      } else if (exactMatch) {
        score += 2;
      } else {
        score -= 10;
      }
    } else if (exactMatch) {
      score += 24;
    } else if (accessoryMatch) {
      score += 4;
    } else {
      score -= 12;
    }
  }

  return score;
}

function selectCandidates(catalog, query, options) {
  const { detailOpen, currentProductId, allowedProductIds, recentTurns, viewedProductIds } = options;
  const allowedSet = new Set(allowedProductIds.length ? allowedProductIds : catalog.map((item) => item.id));
  const viewedSet = new Set(viewedProductIds);
  const pool = catalog.filter((item) => allowedSet.has(item.id));

  const explicitCategory = detectExplicitCategory(query);
  const accessoryIntent = containsAny(normalizeText(query), ['配件', '壳', '膜', '充电', '键盘', '保护']);
  const recentQuestionText = recentTurns.map((item) => item.question).join(' ');
  const combinedQuery = explicitCategory ? query.trim() : `${query} ${recentQuestionText}`.trim();
  const tokens = tokenize(combinedQuery);

  const scored = pool
    .map((item) => ({
      item,
      score: scoreProduct(item, combinedQuery, tokens, {
        detailOpen,
        currentProductId,
        viewedSet,
        explicitCategory,
        accessoryIntent
      })
    }))
    .sort((a, b) => b.score - a.score);

  let candidates = scored.filter((entry) => entry.score > 0).map((entry) => entry.item);
  if (!candidates.length) {
    candidates = scored.map((entry) => entry.item);
  }

  if (explicitCategory) {
    const categorySet = accessoryIntent
      ? new Set([`${explicitCategory}_accessory`, 'cross_device_accessory', 'general_accessory'])
      : new Set([explicitCategory, `${explicitCategory}_accessory`]);
    const focused = candidates.filter((item) => categorySet.has(item.category));
    if (focused.length >= Math.min(8, RECOMMENDATION_COUNT)) {
      candidates = focused;
    } else if (focused.length > 0) {
      candidates = [...focused, ...candidates.filter((item) => !categorySet.has(item.category))];
    }
  }

  if (detailOpen && currentProductId) {
    const current = pool.find((item) => item.id === currentProductId);
    if (current) {
      candidates = [current, ...candidates.filter((item) => item.id !== currentProductId)];
    }
  }

  return candidates.slice(0, CANDIDATE_POOL_SIZE);
}

function digestCandidates(candidates, query) {
  return candidates
    .map((item) => {
      const paramLines = pickRelevantParameters(item, query, 10)
        .map((param) => `${param.name}: ${param.value}`)
        .join(' | ');
      const compatibility = Array.isArray(item.compatibilityModels) ? item.compatibilityModels.slice(0, 8).join(' | ') : '';

      return [
        `id: ${item.id}`,
        `name: ${item.name}`,
        `category: ${item.category}`,
        `official_price: ${item.officialPrice ? formatMoney(item.officialPrice) : '未知'}`,
        `discount_amount: ${item.discountAmount ? formatMoney(item.discountAmount) : '未知'}`,
        `final_price: ${item.finalPrice ? formatMoney(item.finalPrice) : '未知'}`,
        `price_text: ${item.priceText || '官网可选配置'}`,
        `description: ${item.description || ''}`,
        `params: ${paramLines || '暂无'}`,
        `compatibility_models: ${compatibility || '暂无'}`,
        `buy_url: ${item.buyUrl || ''}`,
        `detail_url: ${item.detailUrl || ''}`,
        `specs_url: ${item.specsUrl || ''}`
      ].join('\n');
    })
    .join('\n\n');
}

function fallbackAnswer(query, candidates, options) {
  const { detailOpen, currentProductId } = options;
  const picks = candidates.slice(0, RECOMMENDATION_COUNT).map((item) => item.id);

  if (!candidates.length) {
    return {
      answer: '我暂时没匹配到合适商品，你可以告诉我预算、用途或偏好，我再帮你缩小范围。',
      picks: []
    };
  }

  const primary = detailOpen && currentProductId ? candidates.find((item) => item.id === currentProductId) || candidates[0] : candidates[0];
  if (!primary) {
    return {
      answer: '我先给你放一组 Apple 在售商品，你可以继续告诉我预算和用途。',
      picks
    };
  }

  const priceText = primary.finalPrice ? `到手价 ${formatMoney(primary.finalPrice)}` : primary.priceText;
  const relevantParams = pickRelevantParameters(primary, query, 3);
  const params = relevantParams.map((item) => `${item.name}：${item.value}`).join('；');
  const batteryAsk = containsAny(normalizeText(query), ['续航', '电池', '充电', '视频播放', '小时']);
  const batteryFound = hasBatteryEvidence(relevantParams) || hasBatteryEvidence(primary.fullParameters || []);

  if (detailOpen) {
    if (batteryAsk && !batteryFound) {
      const linkText = primary.specsUrl ? `你可在技术规格页查看：${primary.specsUrl}` : '当前页面未直接给出续航小时数';
      return {
        answer: `${primary.name} 当前知识库里没有明确续航小时参数，我不想给你编造值。${linkText}。如果你要，我可以继续给你做同价位机型续航对比。`,
        picks
      };
    }

    return {
      answer: `先看结论：${primary.name} 很适合当前需求，${priceText}。重点可关注 ${params || '官网参数与配件兼容性'}，你也可以继续问我同类对比。`,
      picks
    };
  }

  return {
    answer: `我先给你推荐 ${primary.name} 等 ${Math.min(RECOMMENDATION_COUNT, candidates.length)} 款 Apple 在售商品，${priceText}。继续告诉我预算和使用场景，我会再收敛。`,
    picks
  };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const apiKey = cleanEnvValue(process.env.MINIMAX_API_KEY);
  if (!apiKey) {
    res.status(500).json({ error: 'Missing MINIMAX_API_KEY environment variable' });
    return;
  }

  const rawBody = typeof req.body === 'string' ? safeParseJson(req.body) : req.body || {};
  const query = typeof rawBody.query === 'string' ? rawBody.query.trim() : '';

  if (!query) {
    res.status(400).json({ error: 'query is required' });
    return;
  }

  const context = rawBody.context && typeof rawBody.context === 'object' ? rawBody.context : {};
  const detailOpen = Boolean(context.detailOpen);
  const currentProductId = typeof context.currentProductId === 'string' ? context.currentProductId : null;
  const viewedProductIds = uniqueStrings(Array.isArray(context.viewedProductIds) ? context.viewedProductIds : []).slice(0, 40);
  const allowedProductIds = uniqueStrings(Array.isArray(context.allowedProductIds) ? context.allowedProductIds : []).slice(0, 260);
  const recentTurns = Array.isArray(context.recentTurns)
    ? context.recentTurns
        .map((turn) => {
          if (!turn || typeof turn !== 'object') {
            return null;
          }
          const question = typeof turn.question === 'string' ? turn.question.trim() : '';
          const answer = typeof turn.answer === 'string' ? turn.answer.trim() : '';
          if (!question) {
            return null;
          }
          return { question, answer };
        })
        .filter(Boolean)
        .slice(-6)
    : [];

  let catalog = [];
  try {
    catalog = loadCatalog();
  } catch (error) {
    res.status(500).json({ error: 'Failed to load catalog', detail: String(error?.message || error) });
    return;
  }

  const candidates = selectCandidates(catalog, query, {
    detailOpen,
    currentProductId,
    allowedProductIds,
    recentTurns,
    viewedProductIds
  });

  const candidateDigest = digestCandidates(candidates, query);
  const pickWhitelist = allowedProductIds.length ? allowedProductIds : candidates.map((item) => item.id);

  const systemPrompt = [
    '你是「Apple的体验店」导购 anna。',
    '你必须仅依据提供的候选商品摘要与最近对话回复，不得编造不存在的参数、价格和型号。',
    '如果摘要不足，明确说信息不足，并只追问 1 个最关键问题。',
    '严禁输出思考过程、分析过程、推理痕迹（例如“让我分析”“用户问的是”）。',
    '输出必须是严格 JSON，且只能有两个字段：',
    '{"answer":"...","picks":["id1","id2"]}',
    '回答规则：',
    '1) 使用中文，45-130 字，先给结论，再给 1-2 条理由，最后给下一步建议。',
    '2) detailOpen=true 时，优先围绕 currentProductId 回答，可附带 1-2 个同类对比。',
    '3) 涉及价格时，优先使用 official_price / discount_amount / final_price；缺失时再用 price_text。',
    '3.1) 若用户问续航/电池而摘要无明确数据，必须明确说“当前官方参数未提供该值”，并优先给 specs_url 让用户核对。',
    `4) picks 只能从 candidateDeviceIds 中选择 8-${RECOMMENDATION_COUNT} 个，第一位放最推荐商品。`,
    '5) 严禁输出 markdown、代码块、额外字段或解释性前后缀。'
  ].join('\n');

  const userPrompt = JSON.stringify(
    {
      query,
      detailOpen,
      currentProductId,
      viewedProductIds,
      recentTurns,
      candidateDeviceIds: candidates.map((item) => item.id),
      candidateDigest
    },
    null,
    2
  );

  const baseUrl = cleanEnvValue(process.env.MINIMAX_BASE_URL, DEFAULT_BASE_URL).replace(/\/$/, '');
  const model = cleanEnvValue(process.env.MINIMAX_MODEL, DEFAULT_MODEL);

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
        temperature: 0.1,
        max_tokens: 280
      })
    });

    if (!upstream.ok) {
      const local = fallbackAnswer(query, candidates, { detailOpen, currentProductId });
      res.status(200).json(local);
      return;
    }

    const data = await upstream.json();
    const content = readContentText(data?.choices?.[0]?.message?.content || '');
    const result = parseAnswerPayload(content, pickWhitelist);

    if (!result.answer) {
      const local = fallbackAnswer(query, candidates, { detailOpen, currentProductId });
      result.answer = local.answer;
      if (!result.picks.length) {
        result.picks = local.picks;
      }
    }

    if (!result.picks.length) {
      result.picks = candidates.slice(0, RECOMMENDATION_COUNT).map((item) => item.id);
    }

    if (detailOpen && currentProductId && result.picks.includes(currentProductId) === false) {
      const hasCurrent = candidates.some((item) => item.id === currentProductId);
      if (hasCurrent) {
        result.picks = [currentProductId, ...result.picks].slice(0, RECOMMENDATION_COUNT);
      }
    }

    res.status(200).json(result);
  } catch (_error) {
    const local = fallbackAnswer(query, candidates, { detailOpen, currentProductId });
    res.status(200).json(local);
  }
}
