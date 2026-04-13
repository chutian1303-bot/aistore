const DEFAULT_BASE_URL = 'https://api.minimaxi.com/v1';
const DEFAULT_MODEL = 'MiniMax-M2.5';

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

function fallbackSummary(answer) {
  const cleaned = String(answer || '').replace(/\s+/g, ' ').trim();
  if (!cleaned) {
    return 'anna 已更新推荐内容';
  }
  if (cleaned.length <= 24) {
    return cleaned;
  }
  return `${cleaned.slice(0, 24)}…`;
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

  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
  const answer = typeof body.answer === 'string' ? body.answer.trim() : '';
  const question = typeof body.question === 'string' ? body.question.trim() : '';

  if (!answer) {
    res.status(400).json({ error: 'answer is required' });
    return;
  }

  const baseUrl = cleanEnvValue(process.env.MINIMAX_BASE_URL, DEFAULT_BASE_URL).replace(/\/$/, '');
  const model = cleanEnvValue(process.env.MINIMAX_MODEL, DEFAULT_MODEL);

  const systemPrompt = [
    '你是 Apple 设备导购的简述助手。',
    '将导购回复压缩成一句中文简述，用于滚动时顶部提示。',
    '要求：',
    '1) 只输出简述本身，不要解释，不要 markdown。',
    '2) 18-28 个中文字符，优先保留款式、优惠、行动建议。',
    '3) 语气自然，避免夸张。'
  ].join('\n');

  const userPrompt = JSON.stringify(
    {
      question,
      answer
    },
    null,
    2
  );

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
        max_tokens: 80
      })
    });

    if (!upstream.ok) {
      const errorText = await upstream.text();
      res.status(502).json({
        error: 'Upstream minimax error',
        detail: errorText.slice(0, 300),
        summary: fallbackSummary(answer)
      });
      return;
    }

    const data = await upstream.json();
    const content = readContentText(data?.choices?.[0]?.message?.content || '');
    const summary = content.replace(/\s+/g, ' ').trim() || fallbackSummary(answer);
    res.status(200).json({ summary });
  } catch (error) {
    res.status(200).json({
      summary: fallbackSummary(answer),
      fallback: true,
      detail: String(error && error.message ? error.message : error)
    });
  }
}
