#!/usr/bin/env python3
import hashlib
import json
import re
import time
from datetime import datetime
from html import unescape
from urllib.parse import urljoin, urlparse
from urllib.request import Request, urlopen

BASE_URL = 'https://www.apple.com.cn'

COMPARE_SOURCES = {
    'iphone': 'https://www.apple.com.cn/iphone/compare/',
    'ipad': 'https://www.apple.com.cn/ipad/compare/',
    'mac': 'https://www.apple.com.cn/mac/compare/',
    'watch': 'https://www.apple.com.cn/watch/compare/',
    'airpods': 'https://www.apple.com.cn/airpods/compare/'
}

NON_COMPARE_DEVICES = [
    {
        'category': 'homepod',
        'name': 'HomePod',
        'buy_path': '/cn/shop/goto/buy_homepod/homepod',
        'detail_path': '/homepod/',
        'parameters': [
            {'name': '高保真音质', 'value': '高振幅低音单元与波束成形高音单元阵列，带来细节丰富的听感。'},
            {'name': '空间感知', 'value': '可感知空间并自动调音，优化房间内播放效果。'},
            {'name': '智能助理', 'value': '支持 Siri，语音即可控制音乐、提醒和智能家居。'},
            {'name': '智能家居中枢', 'value': '可作为 HomeKit / Matter 智能家居控制中心。'},
            {'name': '多房间音频', 'value': '支持多房间音频与立体声组合播放。'},
            {'name': '无缝接力', 'value': '与 iPhone 协同，支持靠近接力播放。'},
            {'name': '隐私设计', 'value': '“嘿 Siri”语音数据默认最小化采集并重视隐私安全。'},
            {'name': '生态联动', 'value': '与 Apple Music、Apple TV 及 Apple 设备深度联动。'}
        ]
    },
    {
        'category': 'homepod',
        'name': 'HomePod mini',
        'buy_path': '/cn/shop/goto/buy_homepod/homepod_mini',
        'detail_path': '/homepod-mini/'
    },
    {
        'category': 'vision',
        'name': 'Apple Vision Pro',
        'buy_path': '/cn/shop/goto/buy_vision/apple_vision_pro',
        'detail_path': '/apple-vision-pro/'
    }
]

IGNORE_FEATURES = {
    '新款 iPhone 机型',
    '更多 iPhone 机型',
    '新款 iPad 机型',
    '更多 iPad 机型',
    '新款 Mac 机型',
    '更多 Mac 机型',
    '新款 Apple Watch 机型',
    '更多 Apple Watch 机型',
    '新款 AirPods 机型',
    '更多 AirPods 机型',
    '颜色导航',
    'Image Link',
    'Badge',
    '价格',
    'dynamic-price-proxy',
    '购买',
    '进一步了解'
}

USER_AGENT = (
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) '
    'AppleWebKit/537.36 (KHTML, like Gecko) '
    'Chrome/123.0.0.0 Safari/537.36'
)

NAV_NOISE = {
    'Mac',
    'iPad',
    'iPhone',
    'Watch',
    'Vision',
    'AirPods',
    '技术支持',
    '支持',
    'Apple Store'
}

NOISE_KEYWORDS = {
    '账户',
    '零售店',
    'Genius',
    'App Store',
    'Apple Pay',
    'iCloud',
    '播客',
    '管理你的 Apple 账户',
    '查找零售店',
    'Apple Store 账户'
}

GENERIC_MATCH_TOKENS = {
    'apple',
    'iphone',
    'ipad',
    'mac',
    'macbook',
    'watch',
    'airpods',
    'homepod',
    'vision',
    'inch',
    'wi',
    'fi',
    'cellular',
    'gb',
    'tb',
    'ch',
    'a'
}

HIGH_SIGNAL_TOKENS = {
    'plus',
    'max',
    'ultra',
    'mini',
    'se',
    'pro',
    '11',
    '13',
    '14',
    '15',
    '16',
    '17',
    'm3',
    'm4',
    'm5',
    'm3ultra',
    'm4pro',
    'm4max',
    'm5pro',
    'm5max',
    '2port',
    '4port',
    'anc'
}


def normalize_text_for_match(text: str) -> str:
    text = unescape(str(text or '')).lower().replace('\xa0', ' ')
    text = (
        text.replace('（', ' ')
        .replace('）', ' ')
        .replace('(', ' ')
        .replace(')', ' ')
        .replace('，', ' ')
        .replace('、', ' ')
        .replace('英寸', ' inch ')
        .replace('毫米', ' mm ')
        .replace('+', ' plus ')
    )
    text = re.sub(r'[^a-z0-9\u4e00-\u9fff]+', ' ', text)
    return re.sub(r'\s+', ' ', text).strip()


def tokenize_for_match(text: str) -> set[str]:
    normalized = normalize_text_for_match(text)
    if not normalized:
        return set()
    return set(normalized.split())


def fetch_html(url: str, timeout: int = 25) -> str:
    request = Request(url, headers={'User-Agent': USER_AGENT})
    with urlopen(request, timeout=timeout) as response:
        return response.read().decode('utf-8', errors='ignore')


def strip_tags(text: str) -> str:
    text = re.sub(r'<[^>]+>', '', text)
    text = unescape(' '.join(text.split()))
    return text.strip()


def slugify(name: str) -> str:
  slug = re.sub(r'[^a-z0-9]+', '-', name.lower()).strip('-')
  if slug:
    return slug
  return hashlib.md5(name.encode('utf-8')).hexdigest()[:8]


def build_device_id(category: str, name: str, buy_path: str = '') -> str:
  base = slugify(name)
  suffix = hashlib.md5(f'{name}|{buy_path}'.encode('utf-8')).hexdigest()[:6]
  return f'{category}-{base}-{suffix}'


def extract_balanced_div(html: str, start_idx: int) -> str:
    i = start_idx
    depth = 0
    n = len(html)

    while i < n:
        open_idx = html.find('<div', i)
        close_idx = html.find('</div', i)

        if open_idx == -1 and close_idx == -1:
            return html[start_idx:]

        if open_idx != -1 and (close_idx == -1 or open_idx < close_idx):
            end = html.find('>', open_idx)
            if end == -1:
                return html[start_idx:]
            depth += 1
            i = end + 1
            continue

        end = html.find('>', close_idx)
        if end == -1:
            return html[start_idx:]
        depth -= 1
        i = end + 1

        if depth == 0:
            return html[start_idx:i]

    return html[start_idx:]


def extract_feature_cell(row_html: str, start_idx: int, tag: str) -> tuple[str, int]:
    if tag == 'a':
        end = row_html.find('</a>', start_idx)
        if end == -1:
            return row_html[start_idx:], len(row_html)
        return row_html[start_idx:end + 4], end + 4

    block = extract_balanced_div(row_html, start_idx)
    return block, start_idx + len(block)


def parse_feature_cells(row_html: str) -> list[dict]:
    cells = []
    pos = 0
    pattern = re.compile(r'<(a|div)\s+[^>]*data-type="featureItems"[^>]*>')

    while True:
        match = pattern.search(row_html, pos)
        if not match:
            break

        tag = match.group(1)
        block, next_pos = extract_feature_cell(row_html, match.start(), tag)

        href = ''
        href_match = re.search(r'href="([^"]+)"', block)
        if href_match:
            href = href_match.group(1)

        text = ''
        text_match = re.search(r'<div data-store-value=""[^>]*>(.*?)</div>', block, flags=re.S)
        if text_match:
            text = strip_tags(text_match.group(1))
        else:
            text = strip_tags(block)

        cells.append({'href': href, 'text': text})
        pos = max(next_pos, match.end())

    return cells


def parse_compare_page(html: str) -> tuple[list[str], list[dict]]:
    root_start = html.find('<div id="backport-data"')
    if root_start == -1:
        raise RuntimeError('Missing #backport-data in compare page')

    root = extract_balanced_div(html, root_start)

    rows = []
    pos = 0
    while True:
        idx = root.find('<div class="backport-row"', pos)
        if idx == -1:
            break
        row = extract_balanced_div(root, idx)
        rows.append(row)
        pos = idx + len(row)

    if not rows:
        raise RuntimeError('No backport rows parsed')

    products = [
        strip_tags(item)
        for item in re.findall(
            r'data-type="products"[^>]*>\s*<div data-store-value=""[^>]*>(.*?)</div>',
            rows[0],
            flags=re.S
        )
    ]

    parsed_rows = []
    for row_html in rows[1:]:
        spec_match = re.search(
            r'data-type="specs"[^>]*>\s*<div data-store-value=""[^>]*>(.*?)</div>',
            row_html,
            flags=re.S
        )
        feature_match = re.search(
            r'data-type="features"[^>]*>\s*<div data-store-value=""[^>]*>(.*?)</div>',
            row_html,
            flags=re.S
        )

        spec_label = strip_tags(spec_match.group(1)) if spec_match else ''
        feature_label = strip_tags(feature_match.group(1)) if feature_match else ''
        cells = parse_feature_cells(row_html)

        if spec_label or feature_label:
            parsed_rows.append(
                {
                    'spec': spec_label,
                    'feature': feature_label,
                    'cells': cells
                }
            )

    return products, parsed_rows


def normalize_detail_path(path: str) -> str:
    if not path:
        return ''

    if path.startswith('http://') or path.startswith('https://'):
        parsed = urlparse(path)
        path = parsed.path or '/'

    if not path.startswith('/'):
        path = f'/{path}'

    # 优先展示页，其次技术规格页
    if '/specs/' in path:
        candidate = path.replace('/specs/', '/')
        if candidate.endswith('//'):
            candidate = candidate[:-1]
        return candidate

    return path


def parse_page_meta(url: str) -> dict:
    html = fetch_html(url)

    title_match = re.search(r'<title>(.*?)</title>', html, flags=re.S)
    desc_match = re.search(r'<meta name="description" content="([^"]*)"', html)
    og_desc_match = re.search(r'<meta property="og:description" content="([^"]*)"', html)
    og_match = re.search(r'<meta property="og:image" content="([^"]+)"', html)
    canonical_match = re.search(r'<link rel="canonical" href="([^"]+)"', html)

    title = strip_tags(title_match.group(1)) if title_match else ''
    description = unescape(desc_match.group(1)).strip() if desc_match else ''
    if not description and og_desc_match:
        description = unescape(og_desc_match.group(1)).strip()
    image_url = og_match.group(1).strip() if og_match else ''
    canonical = canonical_match.group(1).strip() if canonical_match else url

    specs_match = re.search(r'href="([^"]*/specs/)"', html)
    specs_url = urljoin(BASE_URL, specs_match.group(1)) if specs_match else ''

    return {
        'url': url,
        'title': title,
        'description': description,
        'image_url': image_url,
        'canonical': canonical,
        'specs_url': specs_url,
        'html': html
    }


def extract_specs_lines(specs_html: str, limit: int = 12) -> list[str]:
    raw_items = re.findall(r'<li[^>]*>(.*?)</li>', specs_html, flags=re.S)
    lines = []

    for item in raw_items:
        text = strip_tags(item)
        if not text:
            continue
        if text in {'进一步了解', '购买', 'Apple', '比较'}:
            continue
        if len(text) < 3 or len(text) > 90:
            continue
        if '{' in text and '}' in text:
            continue
        if text in NAV_NOISE:
            continue
        if 'Apple (中国大陆)' in text or text.endswith('- Apple'):
            continue
        if re.fullmatch(r'[A-Za-z ]{1,20}', text):
            continue
        if text == '技术规格':
            continue
        if any(keyword in text for keyword in NOISE_KEYWORDS):
            continue

        if text not in lines:
            lines.append(text)

        if len(lines) >= limit:
            break

    return lines


def is_meaningful_value(value: str) -> bool:
    if not value:
        return False
    if value in {'-', '不适用', '暂无', '无'}:
        return False
    if '{' in value and '}' in value:
        return False
    return True


def build_devices_from_compare(category: str, compare_url: str) -> list[dict]:
    html = fetch_html(compare_url)
    products, rows = parse_compare_page(html)

    buy_row = next((row for row in rows if row['feature'] == '购买'), None)
    learn_row = next((row for row in rows if row['feature'] == '进一步了解'), None)
    price_row = next((row for row in rows if row['feature'] == '价格'), None)

    if buy_row is None:
        return []

    devices = []
    total = len(products)

    for idx, product_name in enumerate(products):
        if idx >= len(buy_row['cells']):
            continue

        buy_cell = buy_row['cells'][idx]
        buy_path = buy_cell.get('href', '')

        if '/cn/shop/goto/buy_' not in buy_path:
            continue

        learn_path = ''
        if learn_row and idx < len(learn_row['cells']):
            learn_path = learn_row['cells'][idx].get('href', '')

        detail_path = normalize_detail_path(learn_path)
        if not detail_path:
            continue

        price_text = ''
        if price_row and idx < len(price_row['cells']):
            price_text = price_row['cells'][idx].get('text', '')

        params = []
        for row in rows:
            feature = row['feature']
            cells = row['cells']

            if not feature or feature in IGNORE_FEATURES:
                continue
            if len(cells) < total or idx >= len(cells):
                continue

            value = cells[idx].get('text', '').strip()
            if not is_meaningful_value(value):
                continue

            params.append({'name': feature, 'value': value})
            if len(params) >= 12:
                break

        device = {
            'id': build_device_id(category, product_name, buy_path),
            'category': category,
            'name': product_name,
            'buy_path': buy_path,
            'detail_path': detail_path,
            'compare_url': compare_url,
            'price_text': price_text,
            'parameters': params
        }
        devices.append(device)

    return devices


def enrich_device_meta(device: dict) -> dict:
    detail_url = urljoin(BASE_URL, device['detail_path'])
    meta = parse_page_meta(detail_url)

    # 如果详情页 404，回退到 specs 页面
    if '页面找不到' in meta['title']:
        fallback_url = urljoin(BASE_URL, device['detail_path'].rstrip('/') + '/specs/')
        fallback_meta = parse_page_meta(fallback_url)
        if '页面找不到' not in fallback_meta['title']:
            meta = fallback_meta

    device['detail_url'] = meta['canonical'] or meta['url']
    device['title'] = meta['title']
    device['description'] = meta['description']
    device['image_url'] = meta['image_url']

    specs_url = meta['specs_url']
    if not specs_url and '/specs/' not in meta['url']:
        maybe_specs = meta['url'].rstrip('/') + '/specs/'
        try:
            specs_meta = parse_page_meta(maybe_specs)
            if '页面找不到' not in specs_meta['title']:
                specs_url = maybe_specs
        except Exception:
            specs_url = ''

    if specs_url:
        device['specs_url'] = specs_url
        try:
            if len(device.get('parameters', [])) < 8:
                specs_html = fetch_html(specs_url)
                specs_lines = extract_specs_lines(specs_html)
                if specs_lines:
                    existing_names = {item['name'] for item in device.get('parameters', [])}
                    for line in specs_lines:
                        if len(device['parameters']) >= 16:
                            break
                        key = line[:18]
                        if key in existing_names:
                            continue
                        device['parameters'].append({'name': key, 'value': line})
        except Exception:
            pass
    else:
        device['specs_url'] = ''

    if not device.get('parameters') and device.get('description'):
        fragments = [frag.strip() for frag in re.split(r'[。；;]', device['description']) if frag.strip()]
        for frag in fragments[:4]:
            if len(frag) < 4:
                continue
            key = frag[:14]
            device['parameters'].append({'name': key, 'value': frag})

    return device


def build_non_compare_devices() -> list[dict]:
    items = []
    for info in NON_COMPARE_DEVICES:
        device = {
            'id': build_device_id(info['category'], info['name'], info['buy_path']),
            'category': info['category'],
            'name': info['name'],
            'buy_path': info['buy_path'],
            'detail_path': info['detail_path'],
            'compare_url': '',
            'price_text': '',
            'parameters': info.get('parameters', [])
        }
        items.append(device)
    return items


def kb_to_markdown(kb: dict) -> str:
    lines = []
    lines.append('# Apple 中国官网设备知识库')
    lines.append('')
    lines.append(f"- 生成时间: {kb['generated_at']}")
    lines.append(f"- 设备总数: {len(kb['devices'])}")
    lines.append(f"- 范围: {kb['scope']}")
    lines.append('')

    categories = {}
    for device in kb['devices']:
        categories.setdefault(device['category'], []).append(device)

    for category in sorted(categories.keys()):
        lines.append(f"## {category}")
        lines.append('')
        for device in categories[category]:
            lines.append(f"### {device['name']}")
            lines.append(f"- id: `{device['id']}`")
            lines.append(f"- 详情页: {device.get('detail_url', '')}")
            lines.append(f"- 购买页: {urljoin(BASE_URL, device.get('buy_path', ''))}")
            if device.get('image_url'):
                lines.append(f"- 图片: {device['image_url']}")
            if device.get('description'):
                lines.append(f"- 描述: {device['description']}")

            params = device.get('parameters', [])[:8]
            if params:
                lines.append('- 参数:')
                for param in params:
                    lines.append(f"  - {param['name']}: {param['value']}")
            lines.append('')

    return '\n'.join(lines).strip() + '\n'


def build_demo_products(kb_devices: list[dict]) -> list[dict]:
    tag_map = {
        'iphone': 'iPhone',
        'ipad': 'iPad',
        'mac': 'Mac',
        'watch': 'Watch',
        'airpods': 'AirPods',
        'homepod': 'HomePod',
        'vision': 'Vision'
    }

    demo = []
    for device in kb_devices:
        desc = device.get('description') or ''
        if not desc:
            param_preview = '；'.join([p['value'] for p in device.get('parameters', [])[:2]])
            desc = param_preview or 'Apple 中国官网在售设备。'

        demo.append(
            {
                'id': device['id'],
                'category': device['category'],
                'name': device['name'],
                'tag': tag_map.get(device['category'], 'Apple'),
                'price': device.get('price_text') or '官网可选配置',
                'desc': desc,
                'image': device.get('image_url', ''),
                'buyUrl': urljoin(BASE_URL, device.get('buy_path', '')),
                'detailUrl': device.get('detail_url', ''),
                'specsUrl': device.get('specs_url', ''),
                'parameters': device.get('parameters', [])
            }
        )

    return demo


def main():
    devices = []

    for category, compare_url in COMPARE_SOURCES.items():
        print(f'[KB] Parsing compare: {category}')
        category_devices = build_devices_from_compare(category, compare_url)
        devices.extend(category_devices)

    devices.extend(build_non_compare_devices())

    # 去重（同 id 保留首个）
    deduped = []
    seen = set()
    for device in devices:
        if device['id'] in seen:
            continue
        seen.add(device['id'])
        deduped.append(device)

    # enrich
    enriched = []
    for index, device in enumerate(deduped, 1):
        print(f"[KB] Enrich {index}/{len(deduped)}: {device['name']}")
        try:
            enriched.append(enrich_device_meta(device))
        except Exception as err:
            print(f"  ! enrich failed: {err}")
            device['detail_url'] = urljoin(BASE_URL, device.get('detail_path', ''))
            device['title'] = ''
            device['description'] = ''
            device['image_url'] = ''
            device['specs_url'] = ''
            enriched.append(device)
        time.sleep(0.05)

    kb = {
        'generated_at': datetime.utcnow().strftime('%Y-%m-%dT%H:%M:%SZ'),
        'scope_option': 1,
        'scope': 'Apple 中国官网当前在售全量设备（iPhone/iPad/Mac/Watch/AirPods/HomePod/Vision）',
        'demo_constraints': {
            'demo_mode': True,
            'copyright_restriction': False,
            'asset_size_limit': False
        },
        'source_base': BASE_URL,
        'sources': list(COMPARE_SOURCES.values()) + [
            urljoin(BASE_URL, item['detail_path']) for item in NON_COMPARE_DEVICES
        ],
        'devices': enriched
    }

    with open('data/apple_kb.json', 'w', encoding='utf-8') as f:
        json.dump(kb, f, ensure_ascii=False, indent=2)

    markdown = kb_to_markdown(kb)
    with open('data/apple_kb.md', 'w', encoding='utf-8') as f:
        f.write(markdown)

    demo_products = build_demo_products(enriched)
    with open('data/apple_products.json', 'w', encoding='utf-8') as f:
        json.dump({'generated_at': kb['generated_at'], 'products': demo_products}, f, ensure_ascii=False, indent=2)

    print(f"[KB] Done. devices={len(enriched)}")


if __name__ == '__main__':
    main()
