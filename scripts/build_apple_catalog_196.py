#!/usr/bin/env python3
import json
import re
import time
from datetime import datetime
from html import unescape
from pathlib import Path
from urllib.parse import urljoin
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
PRODUCTS_PATH = ROOT / 'data' / 'apple_products.json'
SUMMARY_PATH = ROOT / 'data' / 'apple_catalog_summary.json'

BASE_URL = 'https://www.apple.com.cn'
USER_AGENT = (
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) '
    'AppleWebKit/537.36 (KHTML, like Gecko) '
    'Chrome/123.0.0.0 Safari/537.36'
)

DEVICE_CATEGORIES = {'iphone', 'ipad', 'mac', 'watch', 'airpods', 'homepod', 'vision'}

ACCESSORY_PAGES = [
    '/shop/accessories/all',
    '/shop/mac/accessories',
    '/shop/ipad/accessories',
    '/shop/iphone/accessories',
    '/shop/watch/accessories',
    '/shop/vision/accessories',
    '/shop/airpods/accessories'
]

ENRICH_ACCESSORY_DETAIL = False

PAGE_TO_ACCESSORY_CATEGORY = {
    '/shop/iphone/accessories': 'iphone_accessory',
    '/shop/ipad/accessories': 'ipad_accessory',
    '/shop/mac/accessories': 'mac_accessory',
    '/shop/watch/accessories': 'watch_accessory',
    '/shop/vision/accessories': 'vision_accessory',
    '/shop/airpods/accessories': 'airpods_accessory'
}

CATEGORY_TAG = {
    'iphone_accessory': 'iPhone 配件',
    'ipad_accessory': 'iPad 配件',
    'mac_accessory': 'Mac 配件',
    'watch_accessory': 'Watch 配件',
    'vision_accessory': 'Vision 配件',
    'airpods_accessory': 'AirPods 配件',
    'cross_device_accessory': '通用配件',
    'general_accessory': 'Apple 配件'
}


def fetch_html(url: str, retries: int = 4, timeout: int = 25) -> str:
    last_error = None
    for attempt in range(retries):
        try:
            req = Request(url, headers={'User-Agent': USER_AGENT})
            with urlopen(req, timeout=timeout) as resp:
                return resp.read().decode('utf-8', errors='ignore')
        except Exception as error:  # noqa: BLE001
            last_error = error
            time.sleep(0.5 * (attempt + 1))
    raise RuntimeError(f'fetch failed: {url} ({last_error})')


def text_from_html(fragment: str) -> str:
    text = re.sub(r'<[^>]+>', '', fragment)
    return unescape(' '.join(text.split())).strip()


def parse_anchor_attributes(block: str) -> tuple[str, str]:
    href_match = re.search(r'href="([^"]+)"', block)
    part_match = re.search(r'data-part-number="([A-Za-z0-9]+)"', block)
    href = href_match.group(1).strip() if href_match else ''
    part = part_match.group(1).strip() if part_match else ''
    return href, part


def parse_tile_image(window_html: str) -> str:
    patterns = [
        r'<img[^>]*src="([^"]+)"[^>]*class="[^"]*as-pinwheel-tileheroimage[^"]*"',
        r'<img[^>]*class="[^"]*as-pinwheel-tileheroimage[^"]*"[^>]*src="([^"]+)"'
    ]
    found = []
    for pattern in patterns:
        found.extend(re.findall(pattern, window_html))
    if not found:
        return ''
    return unescape(found[-1]).replace('&amp;', '&').strip()


def parse_page_tiles(page_html: str) -> dict[str, dict]:
    anchor_pattern = re.compile(r'<a\s+[^>]*class="[^"]*tilelink[^"]*"[^>]*>[\s\S]*?</a>', re.S)
    page_items: dict[str, dict] = {}

    for match in anchor_pattern.finditer(page_html):
        block = match.group(0)
        href, part = parse_anchor_attributes(block)
        if not href or not part:
            continue

        title = text_from_html(block)
        if not title:
            continue

        start, end = match.span()
        before = page_html[max(0, start - 2600):end + 200]
        after = page_html[end:end + 1200]

        price_match = re.search(r'RMB\s*([0-9,]+)', after)
        image = parse_tile_image(before)

        price_value = None
        if price_match:
            try:
                price_value = int(price_match.group(1).replace(',', '').strip())
            except Exception:  # noqa: BLE001
                price_value = None

        candidate = {
            'part': part,
            'href': href.split('?')[0],
            'name': title,
            'price': price_value,
            'image': image
        }

        existing = page_items.get(part)
        if not existing:
            page_items[part] = candidate
            continue

        # Prefer richer info (has image/price and longer title)
        existing_score = (1 if existing.get('image') else 0) + (1 if existing.get('price') else 0) + len(existing.get('name', ''))
        candidate_score = (1 if candidate.get('image') else 0) + (1 if candidate.get('price') else 0) + len(candidate.get('name', ''))
        if candidate_score > existing_score:
            page_items[part] = candidate

    return page_items


def best_page_snapshot(path: str, attempts: int = 3) -> dict[str, dict]:
    best: dict[str, dict] = {}
    for _ in range(attempts):
        html = fetch_html(urljoin(BASE_URL, path))
        parsed = parse_page_tiles(html)
        if len(parsed) > len(best):
            best = parsed
    return best


def parse_meta_description(page_html: str) -> str:
    desc_match = re.search(r'<meta name="description" content="([^"]+)"', page_html)
    og_desc_match = re.search(r'<meta property="og:description" content="([^"]+)"', page_html)
    if desc_match:
        return unescape(desc_match.group(1)).strip()
    if og_desc_match:
        return unescape(og_desc_match.group(1)).strip()
    return ''


def parse_meta_image(page_html: str) -> str:
    og_match = re.search(r'<meta property="og:image" content="([^"]+)"', page_html)
    if og_match:
        return unescape(og_match.group(1)).strip().replace('&amp;', '&')
    return ''


def parse_canonical(page_html: str, fallback_url: str) -> str:
    canonical_match = re.search(r'<link rel="canonical" href="([^"]+)"', page_html)
    if canonical_match:
        return canonical_match.group(1).strip()
    return fallback_url


def parse_parameters(page_html: str, limit: int = 6) -> list[dict]:
    items = re.findall(r'<li[^>]*>(.*?)</li>', page_html, flags=re.S)
    params = []
    seen = set()
    for item in items:
        text = text_from_html(item)
        if not text:
            continue
        if len(text) < 4 or len(text) > 90:
            continue
        if text in seen:
            continue
        if 'Apple Store' in text or '技术支持' in text:
            continue

        seen.add(text)
        key = text[:16]
        params.append({'name': key, 'value': text})
        if len(params) >= limit:
            break
    return params


def classify_accessory_category(source_pages: set[str]) -> str:
    specific = sorted({PAGE_TO_ACCESSORY_CATEGORY[p] for p in PAGE_TO_ACCESSORY_CATEGORY if p in source_pages})
    if len(specific) == 1:
        return specific[0]
    if len(specific) > 1:
        return 'cross_device_accessory'
    return 'general_accessory'


def build_accessories_catalog() -> list[dict]:
    combined: dict[str, dict] = {}

    for path in ACCESSORY_PAGES:
        page_items = best_page_snapshot(path, attempts=3)
        print(f'[catalog] {path}: {len(page_items)} unique parts')

        for part, item in page_items.items():
            if part not in combined:
                combined[part] = {
                    'part': part,
                    'name': item['name'],
                    'href': item['href'],
                    'price': item.get('price'),
                    'image': item.get('image', ''),
                    'source_pages': {path}
                }
            else:
                merged = combined[part]
                merged['source_pages'].add(path)
                if not merged.get('price') and item.get('price'):
                    merged['price'] = item['price']
                if not merged.get('image') and item.get('image'):
                    merged['image'] = item['image']
                if len(item.get('name', '')) > len(merged.get('name', '')):
                    merged['name'] = item['name']
                if len(item.get('href', '')) > len(merged.get('href', '')):
                    merged['href'] = item['href']

    accessories = []

    for part, item in sorted(combined.items()):
        detail_url = urljoin(BASE_URL, item.get('href', ''))
        meta = {'description': '', 'image': '', 'canonical': detail_url, 'parameters': []}
        if ENRICH_ACCESSORY_DETAIL:
            try:
                detail_html = fetch_html(detail_url, retries=2, timeout=12)
            except Exception:
                detail_html = ''
            if detail_html:
                meta = {
                    'description': parse_meta_description(detail_html),
                    'image': parse_meta_image(detail_html),
                    'canonical': parse_canonical(detail_html, detail_url),
                    'parameters': parse_parameters(detail_html)
                }
        official_price = item.get('price')
        discount_amount = int(round(official_price * 0.2)) if isinstance(official_price, int) else None
        final_price = official_price - discount_amount if isinstance(official_price, int) and isinstance(discount_amount, int) else None

        category = classify_accessory_category(item.get('source_pages', set()))
        description = meta['description'] or f"Apple 官方在售配件：{item['name']}"
        image = item.get('image') or meta.get('image', '')

        accessory = {
            'id': f"acc-{part.lower()}",
            'category': category,
            'name': item['name'],
            'tag': CATEGORY_TAG.get(category, 'Apple 配件'),
            'price': official_price if isinstance(official_price, int) else '官网可选配置',
            'officialPrice': official_price,
            'discountAmount': discount_amount,
            'finalPrice': final_price,
            'priceSource': 'accessory-list',
            'desc': description,
            'image': image,
            'buyUrl': detail_url,
            'detailUrl': meta.get('canonical', detail_url),
            'specsUrl': '',
            'parameters': meta.get('parameters', []),
            'partNumber': part
        }
        accessories.append(accessory)

    return accessories


def load_device_products() -> list[dict]:
    payload = json.loads(PRODUCTS_PATH.read_text(encoding='utf-8'))
    products = payload.get('products', [])
    if not isinstance(products, list):
        return []
    devices = [item for item in products if item.get('category') in DEVICE_CATEGORIES]
    return devices


def write_catalog(products: list[dict], accessory_count: int, device_count: int) -> None:
    payload = {
        'generated_at': datetime.utcnow().strftime('%Y-%m-%dT%H:%M:%SZ'),
        'scope': 'Apple 中国官网在售设备 + 配件商品库',
        'products': products
    }
    PRODUCTS_PATH.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding='utf-8')

    summary = {
        'generated_at': payload['generated_at'],
        'total_products': len(products),
        'device_count': device_count,
        'accessory_count': accessory_count,
        'category_counts': {}
    }

    counts = {}
    for item in products:
        category = item.get('category', 'unknown')
        counts[category] = counts.get(category, 0) + 1
    summary['category_counts'] = dict(sorted(counts.items(), key=lambda kv: kv[0]))

    SUMMARY_PATH.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding='utf-8')

    print('[catalog] done')
    print(f"[catalog] total={summary['total_products']} device={device_count} accessory={accessory_count}")
    for key, value in summary['category_counts'].items():
        print(f' - {key}: {value}')


def main() -> None:
    devices = load_device_products()
    if not devices:
        raise RuntimeError('No device products found in apple_products.json')
    print(f'[catalog] loaded devices: {len(devices)}')

    accessories = build_accessories_catalog()
    print(f'[catalog] loaded accessories: {len(accessories)}')

    all_products = devices + accessories
    write_catalog(all_products, accessory_count=len(accessories), device_count=len(devices))


if __name__ == '__main__':
    main()
