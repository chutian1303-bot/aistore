const homeIntents = ['进店看新品', '帮我选 iPhone', '帮我找 Mac', '我要降噪耳机'];
const detailIntents = ['参数解读', '同类对比', '适合人群', '购买建议'];
const fixedIntents = ['商品足迹', '历史消息'];

const fallbackProducts = [
  {
    id: 'iphone-fallback-17-pro',
    category: 'iphone',
    name: 'iPhone 17 Pro',
    tag: 'iPhone',
    price: '官网可选配置',
    desc: '新一代 iPhone Pro 机型，主打更强影像和性能。',
    image: 'https://www.apple.com/v/iphone-17-pro/e/images/meta/iphone-17-pro_overview__eumhhclcpuaa_og.png?202603260044',
    buyUrl: 'https://www.apple.com.cn/cn/shop/goto/buy_iphone/iphone_17_pro',
    detailUrl: 'https://www.apple.com.cn/iphone-17-pro/',
    specsUrl: 'https://www.apple.com.cn/iphone-17-pro/specs/',
    parameters: []
  },
  {
    id: 'ipad-fallback-air',
    category: 'ipad',
    name: 'iPad Air',
    tag: 'iPad',
    price: '官网可选配置',
    desc: '轻薄机身与高性能芯片结合，适合学习与创作。',
    image: 'https://www.apple.com/v/ipad-air/ah/images/meta/ipad-air_overview__bc2fd15uec0y_og.png?202603292059',
    buyUrl: 'https://www.apple.com.cn/cn/shop/goto/buy_ipad/ipad_air',
    detailUrl: 'https://www.apple.com.cn/ipad-air/',
    specsUrl: 'https://www.apple.com.cn/ipad-air/specs/',
    parameters: []
  },
  {
    id: 'mac-fallback-air',
    category: 'mac',
    name: 'MacBook Air',
    tag: 'Mac',
    price: '官网可选配置',
    desc: '轻薄便携，续航持久，适合日常办公与学习。',
    image: 'https://www.apple.com/v/macbook-air/v/images/meta/macbook-air_overview__f4p7jv8hkg66_og.png?202603190127',
    buyUrl: 'https://www.apple.com.cn/cn/shop/goto/buy_mac/macbook_air',
    detailUrl: 'https://www.apple.com.cn/macbook-air/',
    specsUrl: 'https://www.apple.com.cn/macbook-air/specs/',
    parameters: []
  },
  {
    id: 'airpods-fallback-pro',
    category: 'airpods',
    name: 'AirPods Pro 3',
    tag: 'AirPods',
    price: '官网可选配置',
    desc: '支持主动降噪与通透模式，适合通勤和差旅。',
    image: 'https://www.apple.com/v/airpods-pro/r/images/meta/og__c0ceegchesom_overview.png?202604010850',
    buyUrl: 'https://www.apple.com.cn/cn/shop/goto/buy_airpods/airpods_pro_3',
    detailUrl: 'https://www.apple.com.cn/airpods-pro/',
    specsUrl: 'https://www.apple.com.cn/airpods-pro/specs/',
    parameters: []
  }
];

let products = [...fallbackProducts];

const state = {
  detailOpen: false,
  historyOpen: false,
  selectedProductId: null,
  viewed: [],
  canvasItems: [],
  activeChip: '',
  pending: false,
  sheetMode: 'footprint'
};

const dom = {
  conversationStream: document.getElementById('conversationStream'),
  intentStrip: document.getElementById('intentStrip'),
  intentInput: document.getElementById('intentInput'),
  sendBtn: document.getElementById('sendBtn'),
  detailOverlay: document.getElementById('detailOverlay'),
  detailCloseBtn: document.getElementById('detailCloseBtn'),
  detailAiBtn: document.getElementById('detailAiBtn'),
  historySheet: document.getElementById('historySheet'),
  historyTitle: document.getElementById('historyTitle'),
  historyList: document.getElementById('historyList'),
  historyCloseBtn: document.getElementById('historyCloseBtn'),
  detailImage: document.getElementById('detailImage'),
  detailImageLabel: document.getElementById('detailImageLabel'),
  detailName: document.getElementById('detailName'),
  detailInsight: document.getElementById('detailInsight'),
  sizeRow: document.getElementById('sizeRow'),
  sizeNote: document.getElementById('sizeNote'),
  bundleList: document.getElementById('bundleList'),
  buyPrice: document.getElementById('buyPrice')
};

function money(price) {
  if (typeof price === 'number' && Number.isFinite(price)) {
    return `¥${price.toLocaleString('zh-CN')}`;
  }

  if (typeof price === 'string') {
    const cleaned = price
      .replace(/\{[^}]+\}/g, '')
      .replace(/\$price\.display\.monthlyFrom\*/g, '官网价')
      .replace(/\s+/g, ' ')
      .trim();

    return cleaned || '官网可选配置';
  }

  return '官网可选配置';
}

function timeLabel() {
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function safeCssUrl(url) {
  return encodeURI(String(url || ''))
    .replace(/'/g, '%27')
    .replace(/\(/g, '%28')
    .replace(/\)/g, '%29');
}

function categoryLabel(category) {
  const map = {
    iphone: 'iPhone',
    ipad: 'iPad',
    mac: 'Mac',
    watch: 'Watch',
    airpods: 'AirPods',
    homepod: 'HomePod',
    vision: 'Vision'
  };
  return map[category] || 'Apple';
}

function normalizeProduct(raw, index) {
  const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : `apple-${index + 1}`;
  const category = typeof raw.category === 'string' && raw.category.trim() ? raw.category.trim() : 'apple';
  const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : `Apple 设备 ${index + 1}`;
  const desc = typeof raw.desc === 'string' && raw.desc.trim() ? raw.desc.trim() : 'Apple 中国官网在售设备。';
  const image = typeof raw.image === 'string' ? raw.image.trim() : '';
  const tag = typeof raw.tag === 'string' && raw.tag.trim() ? raw.tag.trim() : categoryLabel(category);
  const price = raw.price ?? '官网可选配置';
  const buyUrl = typeof raw.buyUrl === 'string' ? raw.buyUrl.trim() : '';
  const detailUrl = typeof raw.detailUrl === 'string' ? raw.detailUrl.trim() : '';
  const specsUrl = typeof raw.specsUrl === 'string' ? raw.specsUrl.trim() : '';
  const parameters = Array.isArray(raw.parameters)
    ? raw.parameters
        .map((item) => {
          if (!item || typeof item !== 'object') {
            return null;
          }
          const key = typeof item.name === 'string' ? item.name.trim() : '';
          const value = typeof item.value === 'string' ? item.value.trim() : '';
          if (!key || !value) {
            return null;
          }
          return { name: key, value };
        })
        .filter(Boolean)
    : [];

  return {
    id,
    category,
    name,
    desc,
    image,
    tag,
    price,
    buyUrl,
    detailUrl,
    specsUrl,
    parameters,
    color: '#ece8df'
  };
}

async function loadAppleCatalog() {
  try {
    const response = await fetch('./data/apple_products.json', { cache: 'no-cache' });
    if (!response.ok) {
      return;
    }

    const data = await response.json();
    if (!data || !Array.isArray(data.products) || !data.products.length) {
      return;
    }

    products = data.products.map((item, index) => normalizeProduct(item, index));
  } catch (_error) {
    // keep fallback products
  }
}

function findProductById(id) {
  return products.find((item) => item.id === id);
}

function renderIntentStrip(list) {
  dom.intentStrip.innerHTML = list
    .map((item) => {
      const fixedClass = item === '商品足迹' ? 'foot' : item === '历史消息' ? 'msg' : '';
      const activeClass = state.activeChip === item ? 'active' : '';
      return `<button class="chip ${fixedClass} ${activeClass}" type="button" data-intent="${escapeHtml(item)}">${escapeHtml(item)}</button>`;
    })
    .join('');
}

function pickPoint(product) {
  return `→ ${categoryLabel(product.category)} 在售设备`;
}

function productThumbStyle(product) {
  if (product.image) {
    return `background-color:#ece8df;background-image:url('${safeCssUrl(product.image)}');background-size:cover;background-position:center;`;
  }
  return `background:${product.color || '#ece8df'}`;
}

function productCardHtml(product) {
  return `
    <article class="assistant-pick" data-open="${product.id}">
      <div class="assistant-pick-thumb" style="${productThumbStyle(product)}"></div>
      <div class="assistant-pick-point">${escapeHtml(pickPoint(product))}</div>
      <div class="assistant-pick-name">${escapeHtml(product.name)}</div>
      <div class="assistant-pick-price">${escapeHtml(money(product.price))}</div>
    </article>
  `;
}

function conversationItemHtml(item, index) {
  const userRow = item.question
    ? `
      <div class="msg-row user">
        <div class="user-bubble">${escapeHtml(item.question)}</div>
        <div class="user-avatar" aria-hidden="true">王</div>
      </div>
    `
    : '';

  const picksHtml = item.picks.length
    ? `
      <div class="assistant-feed-row">
        <div class="assistant-feed">
          ${item.picks.map((pick) => productCardHtml(pick)).join('')}
        </div>
      </div>
    `
    : '';

  return `
    <article class="msg-group" data-conv-index="${index}">
      ${userRow}
      <div class="msg-row assistant">
        <div class="assistant-bubble">
          <p class="assistant-text">${escapeHtml(item.answer)}</p>
        </div>
      </div>
      ${picksHtml}
    </article>
  `;
}

function scrollCanvasToConversationTop(index) {
  const target = dom.conversationStream.querySelector(`.msg-group[data-conv-index="${index}"]`);
  if (!target) {
    return;
  }

  const nextTop = Math.max(0, target.offsetTop - 6);
  dom.conversationStream.scrollTop = nextTop;
}

function renderCanvas(options = {}) {
  const { anchorConversationIndex = null } = options;

  if (!state.canvasItems.length) {
    dom.conversationStream.innerHTML = `
      <article class="canvas-empty">
        anna 已在线，你可以直接说「帮我选 iPhone」「我想买轻薄笔记本」「AirPods 哪个适合通勤」。
      </article>
    `;
    return;
  }

  dom.conversationStream.innerHTML = state.canvasItems
    .map((item, index) => conversationItemHtml(item, index))
    .join('');

  if (Number.isInteger(anchorConversationIndex)) {
    window.requestAnimationFrame(() => {
      scrollCanvasToConversationTop(anchorConversationIndex);
      window.setTimeout(() => {
        scrollCanvasToConversationTop(anchorConversationIndex);
      }, 80);
    });
    return;
  }

  window.requestAnimationFrame(() => {
    dom.conversationStream.scrollTop = dom.conversationStream.scrollHeight;
  });
}

function currentIntentList() {
  const base = state.detailOpen ? detailIntents : homeIntents;
  return [...fixedIntents, ...base];
}

function containsAny(text, keywords) {
  return keywords.some((item) => text.includes(item));
}

function scoreProductByQuery(product, query) {
  const q = query.toLowerCase();
  let score = 0;

  if (product.name.toLowerCase().includes(q)) {
    score += 5;
  }

  if (containsAny(q, [product.category.toLowerCase(), categoryLabel(product.category).toLowerCase()])) {
    score += 3;
  }

  if (product.desc.toLowerCase().includes(q)) {
    score += 2;
  }

  for (const param of product.parameters.slice(0, 8)) {
    if (param.value.toLowerCase().includes(q) || param.name.toLowerCase().includes(q)) {
      score += 1;
    }
  }

  return score;
}

function topProductsByQuery(query, limit = 4) {
  const q = query.trim().toLowerCase();
  if (!q) {
    return products.slice(0, limit);
  }

  const scored = products
    .map((product) => ({ product, score: scoreProductByQuery(product, q) }))
    .sort((a, b) => b.score - a.score);

  const positive = scored.filter((item) => item.score > 0).map((item) => item.product);
  if (positive.length) {
    return positive.slice(0, limit);
  }

  return products.slice(0, limit);
}

function sameCategoryPicks(product, limit = 4) {
  return products.filter((item) => item.category === product.category && item.id !== product.id).slice(0, limit);
}

function categoryPicks(category, limit = 4) {
  return products.filter((item) => item.category === category).slice(0, limit);
}

function paramSummary(product, take = 3) {
  const params = product.parameters.slice(0, take);
  if (!params.length) {
    return '这款设备的完整参数可在详情页与技术规格页查看。';
  }
  return params.map((item) => `${item.name}：${item.value}`).join('；');
}

function buildAnswer(query) {
  const q = query.trim();
  const lc = q.toLowerCase();
  const selected = findProductById(state.selectedProductId);

  if (state.detailOpen && selected) {
    if (containsAny(q, ['参数', '规格', '配置', '芯片', '续航', '屏幕'])) {
      return {
        answer: `${selected.name} 的核心参数：${paramSummary(selected)}。`,
        picks: [selected]
      };
    }

    if (containsAny(q, ['对比', '区别', '怎么选', '差异'])) {
      const picks = [selected, ...sameCategoryPicks(selected, 2)];
      return {
        answer: `我给你放了同类别设备做对比，重点看芯片、屏幕和续航这三项会更快做决策。`,
        picks
      };
    }

    if (containsAny(q, ['适合', '人群', '场景', '通勤', '学习', '办公', '剪辑'])) {
      return {
        answer: `${selected.name} 更适合 ${selected.desc}。你也可以继续告诉我预算和使用场景，我会进一步收敛。`,
        picks: [selected]
      };
    }

    if (containsAny(q, ['价格', '优惠', '多少钱', '预算', '购买'])) {
      const buyHint = selected.buyUrl ? '可直接点开购买入口查看当前配置价格。' : '可进入官网查看实时价格。';
      return {
        answer: `${selected.name} 当前展示为「${money(selected.price)}」。${buyHint}`,
        picks: [selected]
      };
    }

    return {
      answer: `关于 ${selected.name}，你可以继续问参数解读、同类对比、适合人群和购买建议。`,
      picks: [selected]
    };
  }

  if (containsAny(q, ['新品', '上新', '最新'])) {
    return {
      answer: '我先给你放一组 Apple 中国官网当前在售的热门新款设备，方便你快速浏览。',
      picks: products.slice(0, 4)
    };
  }

  if (containsAny(lc, ['iphone', '手机'])) {
    return {
      answer: '下面是当前在售 iPhone 机型，我优先按主流选择放在前面。',
      picks: categoryPicks('iphone', 4)
    };
  }

  if (containsAny(lc, ['ipad', '平板'])) {
    return {
      answer: '下面是当前在售 iPad 机型，你可以继续告诉我侧重学习、创作还是娱乐。',
      picks: categoryPicks('ipad', 4)
    };
  }

  if (containsAny(lc, ['mac', 'macbook', '电脑', '笔记本'])) {
    return {
      answer: '我先放适合大多数用户的 Mac 设备组合，你可以继续补充预算和性能需求。',
      picks: categoryPicks('mac', 4)
    };
  }

  if (containsAny(lc, ['watch', '手表'])) {
    return {
      answer: '下面是当前在售 Apple Watch 机型，可继续按运动、健康或续航偏好细分。',
      picks: categoryPicks('watch', 4)
    };
  }

  if (containsAny(lc, ['airpods', '耳机', '降噪'])) {
    return {
      answer: '我先给你放在售 AirPods 机型，重点可以对比降噪、佩戴和续航。',
      picks: categoryPicks('airpods', 4)
    };
  }

  const matched = topProductsByQuery(q, 4);
  return {
    answer: '已根据你的问题匹配到官网在售设备。你可以继续补充预算、使用场景和偏好，我会进一步收敛。',
    picks: matched
  };
}

function setPending(pending) {
  state.pending = pending;
  dom.sendBtn.disabled = pending;
  dom.intentInput.disabled = pending;
}

function normalizeServerPicks(rawPicks) {
  if (!Array.isArray(rawPicks)) {
    return [];
  }

  return rawPicks
    .map((pick) => {
      if (typeof pick === 'string') {
        return findProductById(pick);
      }

      if (pick && typeof pick === 'object' && typeof pick.id === 'string') {
        return findProductById(pick.id);
      }

      return null;
    })
    .filter(Boolean)
    .slice(0, 4);
}

async function fetchServerAnswer(query) {
  const payload = {
    query,
    context: {
      detailOpen: state.detailOpen,
      currentProductId: state.selectedProductId,
      viewedProductIds: state.viewed.map((item) => item.id),
      allowedProductIds: products.map((item) => item.id)
    }
  };

  const response = await fetch('/api/chat', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    throw new Error(`chat api status ${response.status}`);
  }

  const data = await response.json();
  if (!data || typeof data.answer !== 'string' || !data.answer.trim()) {
    throw new Error('invalid chat payload');
  }

  return {
    answer: data.answer.trim(),
    picks: normalizeServerPicks(data.picks)
  };
}

async function sendIntent(manualText) {
  const text = (manualText || dom.intentInput.value).trim();
  if (!text || state.pending) {
    return;
  }

  setPending(true);
  let result = null;

  try {
    result = await fetchServerAnswer(text);
  } catch (_error) {
    result = buildAnswer(text);
  } finally {
    setPending(false);
  }

  state.canvasItems.push({
    question: text,
    answer: result.answer,
    picks: result.picks,
    createdAt: timeLabel()
  });
  const latestUserIndex = state.canvasItems.length - 1;

  dom.intentInput.value = '';
  state.activeChip = '';

  renderCanvas({ anchorConversationIndex: latestUserIndex });
  renderIntentStrip(currentIntentList());
  closeHistorySheet();
}

function upsertViewed(productId) {
  const existsIndex = state.viewed.findIndex((item) => item.id === productId);
  const viewedItem = {
    id: productId,
    time: timeLabel()
  };

  if (existsIndex >= 0) {
    state.viewed.splice(existsIndex, 1);
  }

  state.viewed.unshift(viewedItem);
}

function fillDetailParams(product) {
  const params = product.parameters.slice(0, 4);
  dom.sizeRow.innerHTML = params
    .map((item, index) => `<span class="sz ${index === 1 ? 'rec' : ''}">${escapeHtml(item.name.slice(0, 6) || '参数')}</span>`)
    .join('');

  if (params.length < 4) {
    const fillers = ['芯片', '显示', '影像', '续航'].slice(params.length);
    dom.sizeRow.innerHTML += fillers.map((item) => `<span class="sz">${escapeHtml(item)}</span>`).join('');
  }

  const summary = params.map((item) => `${item.name}：${item.value}`).join('；');
  dom.sizeNote.textContent = summary || '以下信息来自 Apple 中国官网公开技术规格。';
}

function renderDetail(product) {
  dom.detailImage.style.backgroundColor = '#ece8df';
  if (product.image) {
    dom.detailImage.style.backgroundImage = `url('${safeCssUrl(product.image)}')`;
    dom.detailImage.style.backgroundSize = 'cover';
    dom.detailImage.style.backgroundPosition = 'center';
  } else {
    dom.detailImage.style.backgroundImage = 'none';
  }

  dom.detailImageLabel.textContent = product.name;
  dom.detailName.textContent = product.name;
  dom.detailInsight.textContent = `${product.name} 的建议：${product.desc}`;
  dom.buyPrice.textContent = money(product.price);

  fillDetailParams(product);

  dom.bundleList.innerHTML = products
    .filter((item) => item.id !== product.id)
    .slice(0, 3)
    .map(
      (item) => `
      <article class="bundle-item">
        <div class="bundle-item-thumb" style="${productThumbStyle(item)}"></div>
        <div class="bundle-item-name">${escapeHtml(item.name)}</div>
        <div class="bundle-item-price">${escapeHtml(money(item.price))}</div>
      </article>
    `
    )
    .join('');
}

function openDetail(productId) {
  const product = findProductById(productId);
  if (!product) {
    return;
  }

  state.selectedProductId = product.id;
  state.detailOpen = true;
  state.activeChip = '';

  closeHistorySheet();
  upsertViewed(product.id);
  renderDetail(product);
  renderIntentStrip(currentIntentList());

  dom.detailOverlay.classList.add('open');
  dom.detailOverlay.setAttribute('aria-hidden', 'false');
  dom.intentInput.placeholder = '继续问这台设备：参数、对比、适合人群、购买建议';
}

function closeDetail() {
  state.detailOpen = false;
  state.activeChip = '';

  dom.detailOverlay.classList.remove('open');
  dom.detailOverlay.setAttribute('aria-hidden', 'true');
  dom.intentInput.placeholder = 'anna 在线，可以问我任何问题';

  renderIntentStrip(currentIntentList());
}

function localCondense(text) {
  const cleaned = String(text || '').replace(/\s+/g, ' ').trim();
  if (!cleaned) {
    return 'anna 已更新推荐内容';
  }
  if (cleaned.length <= 28) {
    return cleaned;
  }
  return `${cleaned.slice(0, 28)}…`;
}

function renderHistorySheet() {
  if (state.sheetMode === 'history') {
    dom.historyTitle.textContent = '历史消息';

    const historyRows = state.canvasItems
      .map((item, index) => ({ item, index }))
      .filter(({ item }) => item.question && item.question.trim())
      .reverse();

    if (!historyRows.length) {
      dom.historyList.innerHTML = '<div class="empty-sheet">还没有历史消息，先提一个问题吧。</div>';
      return;
    }

    dom.historyList.innerHTML = historyRows
      .map(
        ({ item, index }) => `
        <article class="sheet-item">
          <div class="sheet-thumb" style="background:${index % 2 === 0 ? '#ede8de' : '#f5f0e8'}"></div>
          <div>
            <div class="sheet-name">${escapeHtml(item.question)}</div>
            <div class="sheet-meta">${escapeHtml(localCondense(item.answer))} · ${escapeHtml(item.createdAt || '刚刚')}</div>
          </div>
          <button type="button" data-history="${index}">定位</button>
        </article>
      `
      )
      .join('');
    return;
  }

  dom.historyTitle.textContent = '商品足迹';
  if (!state.viewed.length) {
    dom.historyList.innerHTML = '<div class="empty-sheet">还没有商品足迹，先点开一台设备看看吧。</div>';
    return;
  }

  dom.historyList.innerHTML = state.viewed
    .map((viewed) => {
      const product = findProductById(viewed.id);
      if (!product) {
        return '';
      }

      return `
        <article class="sheet-item">
          <div class="sheet-thumb" style="${productThumbStyle(product)}"></div>
          <div>
            <div class="sheet-name">${escapeHtml(product.name)}</div>
            <div class="sheet-meta">${escapeHtml(money(product.price))} · ${viewed.time} 浏览</div>
          </div>
          <button type="button" data-open="${product.id}">重看</button>
        </article>
      `;
    })
    .join('');
}

function openHistorySheet(mode = 'footprint') {
  state.sheetMode = mode === 'history' ? 'history' : 'footprint';
  renderHistorySheet();
  state.historyOpen = true;
  state.activeChip = state.sheetMode === 'history' ? '历史消息' : '商品足迹';
  renderIntentStrip(currentIntentList());
  dom.historySheet.classList.add('open');
  dom.historySheet.setAttribute('aria-hidden', 'false');
}

function closeHistorySheet() {
  state.historyOpen = false;
  if (state.activeChip === '商品足迹' || state.activeChip === '历史消息') {
    state.activeChip = '';
    renderIntentStrip(currentIntentList());
  }
  dom.historySheet.classList.remove('open');
  dom.historySheet.setAttribute('aria-hidden', 'true');
}

function scrollConversationTo(index) {
  const target = dom.conversationStream.querySelector(`[data-conv-index="${index}"]`);
  if (!target) {
    return;
  }

  target.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function seedCanvasWelcome() {
  if (state.canvasItems.length) {
    return;
  }

  state.canvasItems.push(
    {
      question: '',
      answer: 'hi 王同学，欢迎进店。我是你的 Apple 设备导购 anna。我会基于 Apple 中国官网在售知识库给你推荐。',
      picks: products.slice(0, 4),
      createdAt: timeLabel()
    },
    {
      question: '',
      answer: '你可以直接问我：选 iPhone、对比 Mac、找降噪耳机、看参数差异。',
      picks: [],
      createdAt: timeLabel()
    }
  );
}

function bindEvents() {
  dom.conversationStream.addEventListener('click', (event) => {
    const button = event.target.closest('[data-open]');
    if (!button) {
      return;
    }

    openDetail(button.dataset.open);
  });

  dom.intentStrip.addEventListener('click', (event) => {
    const target = event.target.closest('[data-intent]');
    if (!target) {
      return;
    }

    const intent = target.dataset.intent;
    if (intent === '商品足迹' || intent === '历史消息') {
      const mode = intent === '历史消息' ? 'history' : 'footprint';
      if (state.historyOpen && state.sheetMode === mode) {
        closeHistorySheet();
      } else {
        openHistorySheet(mode);
      }
      return;
    }

    void sendIntent(intent);
  });

  dom.sendBtn.addEventListener('click', () => {
    void sendIntent();
  });

  dom.intentInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      void sendIntent();
    }
  });

  dom.detailCloseBtn.addEventListener('click', () => {
    closeDetail();
  });

  dom.detailAiBtn.addEventListener('click', () => {
    void sendIntent('参数解读');
  });

  dom.historyCloseBtn.addEventListener('click', () => {
    closeHistorySheet();
  });

  dom.historyList.addEventListener('click', (event) => {
    const historyButton = event.target.closest('[data-history]');
    if (historyButton) {
      const index = Number(historyButton.dataset.history);
      closeHistorySheet();
      if (Number.isInteger(index)) {
        scrollConversationTo(index);
      }
      return;
    }

    const button = event.target.closest('[data-open]');
    if (!button) {
      return;
    }

    closeHistorySheet();
    openDetail(button.dataset.open);
  });
}

async function init() {
  await loadAppleCatalog();
  seedCanvasWelcome();
  renderCanvas();
  renderIntentStrip(currentIntentList());
  bindEvents();
}

void init();
