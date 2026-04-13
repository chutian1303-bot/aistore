#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const DATA_PATH = path.join(ROOT, 'data', 'apple_products.json');
const OUT_DIR = path.join(ROOT, 'data', 'selfplay');
const LOG_PATH = path.join(OUT_DIR, 'selfplay_log.jsonl');
const BADCASE_PATH = path.join(OUT_DIR, 'badcases.jsonl');
const SUMMARY_PATH = path.join(OUT_DIR, 'summary_latest.json');

const BASE_URL = (process.env.SELFPLAY_BASE_URL || 'https://jnby-ai-store-demo.vercel.app').replace(/\/$/, '');
const MODE = (process.env.SELFPLAY_MODE || 'local').toLowerCase();
const INTERVAL_MS = Number(process.env.SELFPLAY_INTERVAL_MS || 1200);
const SESSION_TURNS_MIN = Number(process.env.SELFPLAY_TURNS_MIN || 3);
const SESSION_TURNS_MAX = Number(process.env.SELFPLAY_TURNS_MAX || 6);
const LOW_SCORE_LINE = Number(process.env.SELFPLAY_BADCASE_LINE || 65);
const LOOP_SLEEP_MS = Number(process.env.SELFPLAY_LOOP_SLEEP_MS || 400);
const RUN_FOREVER = process.env.SELFPLAY_RUN_FOREVER !== '0';
const MAX_SESSIONS = Number(process.env.SELFPLAY_MAX_SESSIONS || 0);

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function appendJsonl(filePath, payload) {
  fs.appendFileSync(filePath, `${JSON.stringify(payload)}\n`, 'utf8');
}

function readCatalog() {
  const raw = fs.readFileSync(DATA_PATH, 'utf8');
  const parsed = JSON.parse(raw);
  const products = Array.isArray(parsed?.products) ? parsed.products : [];
  if (!products.length) {
    throw new Error('apple_products.json 为空，无法启动 selfplay');
  }
  return products;
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randomPick(list) {
  return list[randomInt(0, list.length - 1)];
}

function categoryLabel(category) {
  const map = {
    iphone: 'iPhone',
    ipad: 'iPad',
    mac: 'Mac',
    watch: 'Apple Watch',
    airpods: 'AirPods',
    homepod: 'HomePod',
    vision: 'Apple Vision',
    iphone_accessory: 'iPhone 配件',
    ipad_accessory: 'iPad 配件',
    mac_accessory: 'Mac 配件',
    watch_accessory: 'Watch 配件',
    vision_accessory: 'Vision 配件',
    airpods_accessory: 'AirPods 配件',
    cross_device_accessory: '通用配件',
    general_accessory: 'Apple 配件'
  };
  return map[category] || 'Apple 商品';
}

function turnTemplates(categoryName, productName) {
  const budget = randomPick([2000, 3000, 5000, 8000, 10000, 15000]);
  return [
    `我想买${categoryName}，主要是通勤用，预算 ${budget}，先给我推荐 2-4 个。`,
    `帮我看看 ${productName} 的核心参数，重点说我最该关注哪 2 点。`,
    `如果预算再降 20%，你会换成哪款，为什么？`,
    `我还需要配件，优先推荐性价比高的。`,
    `你给我一个直接可执行的购买建议，按优先级排一下。`,
    `这款和同类怎么选？只说关键差异。`,
    `优惠怎么计算？店铺红包 8 折抵扣后到手价是多少？`
  ];
}

function makeSessionSeed(catalog) {
  const primary = randomPick(catalog);
  const category = categoryLabel(primary.category);
  const templates = turnTemplates(category, primary.name);
  return {
    primary,
    category,
    templates
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithTimeout(url, init, timeoutMs = 60000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal
    });
    return response;
  } finally {
    clearTimeout(timer);
  }
}

function scoreTurn({ answer, picks, query, detailOpen, currentProductId, recentTurns }, catalogMap) {
  const reasons = [];
  let score = 100;

  const cleanAnswer = typeof answer === 'string' ? answer.trim() : '';
  if (!cleanAnswer) {
    score -= 45;
    reasons.push('空回复');
  } else {
    if (cleanAnswer.length < 28) {
      score -= 12;
      reasons.push('回复过短');
    }
    if (cleanAnswer.length > 220) {
      score -= 10;
      reasons.push('回复过长');
    }
  }

  if (!Array.isArray(picks) || picks.length < 1) {
    score -= 20;
    reasons.push('无商品推荐');
  } else if (picks.length > 4) {
    score -= 8;
    reasons.push('推荐数超过 4');
  }

  if (Array.isArray(picks)) {
    for (const id of picks) {
      if (!catalogMap.has(id)) {
        score -= 6;
        reasons.push(`未知商品ID: ${id}`);
      }
    }
  }

  if (detailOpen && currentProductId) {
    if (!Array.isArray(picks) || picks[0] !== currentProductId) {
      score -= 12;
      reasons.push('详情态未将当前商品置顶');
    }
  }

  const queryTokens = String(query || '')
    .toLowerCase()
    .match(/[a-z0-9\u4e00-\u9fff]{2,}/g) || [];

  if (queryTokens.length && cleanAnswer) {
    const hit = queryTokens.some((token) => cleanAnswer.toLowerCase().includes(token));
    if (!hit) {
      score -= 6;
      reasons.push('回复与问题关键词弱相关');
    }
  }

  if (recentTurns.length > 0 && cleanAnswer) {
    const priorQuestion = recentTurns[recentTurns.length - 1]?.question || '';
    const priorToken = String(priorQuestion).replace(/\s+/g, '').slice(0, 8);
    if (priorToken && cleanAnswer.includes(priorToken)) {
      score += 2;
    }
  }

  score = Math.max(0, Math.min(100, score));
  return { score, reasons };
}

async function runHttpTurn({ baseUrl, payload, catalogMap }) {
  const startedAt = Date.now();
  try {
    const response = await fetchWithTimeout(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });
    const latencyMs = Date.now() - startedAt;

    if (!response.ok) {
      const text = await response.text();
      return {
        ok: false,
        latencyMs,
        status: response.status,
        answer: '',
        picks: [],
        score: 0,
        reasons: [`HTTP ${response.status}`, text.slice(0, 120)]
      };
    }

    const data = await response.json();
    const answer = typeof data?.answer === 'string' ? data.answer.trim() : '';
    const picks = Array.isArray(data?.picks) ? data.picks.filter((item) => typeof item === 'string') : [];
    const { query, context } = payload;

    const scored = scoreTurn(
      {
        answer,
        picks,
        query,
        detailOpen: Boolean(context?.detailOpen),
        currentProductId: typeof context?.currentProductId === 'string' ? context.currentProductId : null,
        recentTurns: Array.isArray(context?.recentTurns) ? context.recentTurns : []
      },
      catalogMap
    );

    return {
      ok: true,
      latencyMs,
      status: 200,
      answer,
      picks,
      score: scored.score,
      reasons: scored.reasons
    };
  } catch (error) {
    return {
      ok: false,
      latencyMs: Date.now() - startedAt,
      status: 0,
      answer: '',
      picks: [],
      score: 0,
      reasons: [String(error?.message || error)]
    };
  }
}

function buildLocalRes() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    setHeader(key, value) {
      this.headers[key] = value;
    },
    json(payload) {
      this.body = payload;
      return this;
    }
  };
}

async function runLocalTurn({ payload, catalogMap, localHandler }) {
  const startedAt = Date.now();
  try {
    const req = {
      method: 'POST',
      body: payload
    };
    const res = buildLocalRes();
    await localHandler(req, res);
    const latencyMs = Date.now() - startedAt;

    if (res.statusCode >= 400) {
      return {
        ok: false,
        latencyMs,
        status: res.statusCode,
        answer: '',
        picks: [],
        score: 0,
        reasons: [`LOCAL_HTTP ${res.statusCode}`]
      };
    }

    const data = res.body || {};
    const answer = typeof data?.answer === 'string' ? data.answer.trim() : '';
    const picks = Array.isArray(data?.picks) ? data.picks.filter((item) => typeof item === 'string') : [];
    const { query, context } = payload;

    const scored = scoreTurn(
      {
        answer,
        picks,
        query,
        detailOpen: Boolean(context?.detailOpen),
        currentProductId: typeof context?.currentProductId === 'string' ? context.currentProductId : null,
        recentTurns: Array.isArray(context?.recentTurns) ? context.recentTurns : []
      },
      catalogMap
    );

    return {
      ok: true,
      latencyMs,
      status: 200,
      answer,
      picks,
      score: scored.score,
      reasons: scored.reasons
    };
  } catch (error) {
    return {
      ok: false,
      latencyMs: Date.now() - startedAt,
      status: 0,
      answer: '',
      picks: [],
      score: 0,
      reasons: [String(error?.message || error)]
    };
  }
}

async function main() {
  ensureDir(OUT_DIR);
  const catalog = readCatalog();
  const catalogMap = new Map(catalog.map((item) => [item.id, item]));
  const allIds = catalog.map((item) => item.id);
  let localHandler = null;

  if (MODE === 'local') {
    const module = await import(path.join(ROOT, 'api', 'chat.js'));
    localHandler = module.default;
    if (typeof localHandler !== 'function') {
      throw new Error('api/chat.js default export 不是函数，无法运行本地模式');
    }
  }

  const stats = {
    startedAt: new Date().toISOString(),
    baseUrl: BASE_URL,
    mode: MODE,
    totalSessions: 0,
    totalTurns: 0,
    okTurns: 0,
    failTurns: 0,
    lowScoreTurns: 0,
    avgLatencyMs: 0,
    avgScore: 0
  };

  let latencyAcc = 0;
  let scoreAcc = 0;

  while (RUN_FOREVER || stats.totalSessions < MAX_SESSIONS) {
    const seed = makeSessionSeed(catalog);
    const turnCount = randomInt(SESSION_TURNS_MIN, SESSION_TURNS_MAX);
    const recentTurns = [];
    const viewedProductIds = [];

    let detailOpen = false;
    let currentProductId = null;

    for (let i = 0; i < turnCount; i += 1) {
      const useDetail = i >= 1 && Math.random() < 0.55;
      if (useDetail) {
        detailOpen = true;
        currentProductId = currentProductId || seed.primary.id;
        if (!viewedProductIds.includes(currentProductId)) {
          viewedProductIds.push(currentProductId);
        }
      } else {
        detailOpen = false;
        currentProductId = null;
      }

      const query = seed.templates[i % seed.templates.length];
      const payload = {
        query,
        context: {
          detailOpen,
          currentProductId,
          viewedProductIds,
          allowedProductIds: allIds,
          recentTurns
        }
      };

      const result =
        MODE === 'local'
          ? await runLocalTurn({
              payload,
              catalogMap,
              localHandler
            })
          : await runHttpTurn({
              baseUrl: BASE_URL,
              payload,
              catalogMap
            });

      stats.totalTurns += 1;
      latencyAcc += result.latencyMs;
      scoreAcc += result.score;

      if (result.ok) {
        stats.okTurns += 1;
      } else {
        stats.failTurns += 1;
      }

      if (result.score < LOW_SCORE_LINE) {
        stats.lowScoreTurns += 1;
      }

      stats.avgLatencyMs = Math.round(latencyAcc / stats.totalTurns);
      stats.avgScore = Number((scoreAcc / stats.totalTurns).toFixed(2));

      const row = {
        at: new Date().toISOString(),
        session: stats.totalSessions + 1,
        turn: i + 1,
        query,
        detailOpen,
        currentProductId,
        status: result.status,
        ok: result.ok,
        score: result.score,
        reasons: result.reasons,
        picks: result.picks,
        answer: result.answer,
        latencyMs: result.latencyMs
      };
      appendJsonl(LOG_PATH, row);

      if (result.score < LOW_SCORE_LINE) {
        appendJsonl(BADCASE_PATH, row);
      }

      if (result.answer) {
        recentTurns.push({
          question: query,
          answer: result.answer
        });
        if (recentTurns.length > 6) {
          recentTurns.shift();
        }
      }

      fs.writeFileSync(
        SUMMARY_PATH,
        JSON.stringify(
          {
            ...stats,
            updatedAt: new Date().toISOString(),
            latestTurn: row
          },
          null,
          2
        ),
        'utf8'
      );

      process.stdout.write(
        `[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] #${stats.totalTurns} ` +
          `score=${String(result.score).padStart(3, ' ')} latency=${String(result.latencyMs).padStart(4, ' ')}ms ` +
          `${result.ok ? 'ok' : 'fail'} ${query.slice(0, 26)}\n`
      );

      await sleep(Math.max(100, INTERVAL_MS));
    }

    stats.totalSessions += 1;
    if (!RUN_FOREVER && MAX_SESSIONS > 0 && stats.totalSessions >= MAX_SESSIONS) {
      break;
    }

    await sleep(Math.max(100, LOOP_SLEEP_MS));
  }
}

main().catch((error) => {
  process.stderr.write(`selfplay runner crashed: ${String(error?.message || error)}\n`);
  process.exit(1);
});
