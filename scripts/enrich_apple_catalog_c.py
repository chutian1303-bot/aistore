#!/usr/bin/env python3
import json
import re
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
from html import unescape
from pathlib import Path
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
PRODUCTS_PATH = ROOT / 'data' / 'apple_products.json'
KB_PATH = ROOT / 'data' / 'apple_kb.json'
MATRIX_PATH = ROOT / 'data' / 'apple_compatibility_matrix.json'

USER_AGENT = (
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) '
    'AppleWebKit/537.36 (KHTML, like Gecko) '
    'Chrome/123.0.0.0 Safari/537.36'
)

MAX_WORKERS = 8
REQUEST_TIMEOUT = 22
REQUEST_RETRIES = 3

DEVICE_CATEGORIES = {'iphone', 'ipad', 'mac', 'watch', 'airpods', 'homepod', 'vision'}
ACCESSORY_CATEGORIES = {
    'iphone_accessory',
    'ipad_accessory',
    'mac_accessory',
    'watch_accessory',
    'vision_accessory',
    'airpods_accessory',
    'cross_device_accessory',
    'general_accessory'
}

BATTERY_HINTS = ['电池', '续航', '视频播放', '流媒体视频播放', '充电', '小时', 'mah', 'mAh', '快充']


def now_iso() -> str:
    return datetime.utcnow().replace(microsecond=0).isoformat() + 'Z'


def fetch_html(url: str, retries: int = REQUEST_RETRIES, timeout: int = REQUEST_TIMEOUT) -> str:
    last_error = None
    for attempt in range(max(1, retries)):
        try:
            req = Request(url, headers={'User-Agent': USER_AGENT})
            with urlopen(req, timeout=timeout) as resp:
                return resp.read().decode('utf-8', errors='ignore')
        except Exception as error:  # noqa: BLE001
            last_error = error
            time.sleep(0.35 * (attempt + 1))
    raise RuntimeError(f'fetch failed: {url} ({last_error})')


def fetch_url_job(url: str) -> tuple[str, str, str]:
    try:
        return url, fetch_html(url), ''
    except Exception as error:  # noqa: BLE001
        return url, '', str(error)


def strip_tags(text: str) -> str:
    text = re.sub(r'<script[\s\S]*?</script>', ' ', text, flags=re.I)
    text = re.sub(r'<style[\s\S]*?</style>', ' ', text, flags=re.I)
    text = re.sub(r'<br\s*/?>', ' / ', text, flags=re.I)
    text = re.sub(r'<[^>]+>', ' ', text)
    text = unescape(text.replace('\xa0', ' '))
    text = re.sub(r'\s+', ' ', text).strip()
    return text


def normalize_key(text: str) -> str:
    value = strip_tags(text)
    value = re.sub(r'脚注\s*\d+', '', value)
    value = re.sub(r'\s+', ' ', value).strip(' ：:')
    return value


def normalize_for_match(text: str) -> str:
    value = strip_tags(text).lower()
    value = re.sub(r'[^a-z0-9\u4e00-\u9fff]+', '', value)
    return value


def extract_json_object_after(html: str, marker: str) -> dict:
    idx = html.find(marker)
    if idx == -1:
        return {}

    brace_idx = html.find('{', idx)
    if brace_idx == -1:
        return {}

    i = brace_idx
    depth = 0
    in_str = False
    escaped = False
    end = None

    while i < len(html):
        ch = html[i]

        if in_str:
            if escaped:
                escaped = False
            elif ch == '\\':
                escaped = True
            elif ch == '"':
                in_str = False
        else:
            if ch == '"':
                in_str = True
            elif ch == '{':
                depth += 1
            elif ch == '}':
                depth -= 1
                if depth == 0:
                    end = i + 1
                    break
        i += 1

    if end is None:
        return {}

    try:
        return json.loads(html[brace_idx:end])
    except Exception:  # noqa: BLE001
        return {}


def parse_named_prices(html: str) -> list[dict]:
    pattern = re.compile(r'"price":\{"fullPrice":\s*([0-9]+(?:\.[0-9]+)?)\},"category":"[^"]*","name":"([^"]+)"')
    entries = []
    seen = set()
    for raw_price, name in pattern.findall(html):
        price = int(round(float(raw_price)))
        label = strip_tags(name)
        key = (label, price)
        if key in seen:
            continue
        seen.add(key)
        entries.append({'label': label, 'price': price, 'source': 'name'})
    entries.sort(key=lambda item: (item['price'], item['label']))
    return entries


def parse_key_prices(html: str) -> list[dict]:
    prices_obj = extract_json_object_after(html, '"prices":')
    entries = []
    for key, payload in prices_obj.items():
        if not isinstance(payload, dict):
            continue

        price = None
        if isinstance(payload.get('amountBeforeTradeIn'), (int, float)):
            price = float(payload.get('amountBeforeTradeIn'))
        elif isinstance(payload.get('amount'), (int, float)):
            price = float(payload.get('amount'))
        else:
            current = payload.get('currentPrice')
            if isinstance(current, dict):
                raw = current.get('raw_amount')
                try:
                    price = float(raw)
                except Exception:  # noqa: BLE001
                    price = None

        if not price or price <= 0:
            continue

        entries.append({'label': str(key), 'price': int(round(price)), 'source': 'key'})

    entries.sort(key=lambda item: (item['price'], item['label']))
    return entries


def unique_variants(variants: list[dict], limit: int = 40) -> list[dict]:
    unique = []
    seen = set()
    for item in variants:
        label = str(item.get('label', '')).strip()
        price = item.get('price')
        if not label or not isinstance(price, int):
            continue
        key = (label, price)
        if key in seen:
            continue
        seen.add(key)
        unique.append({'label': label, 'price': price, 'source': item.get('source', '')})
        if len(unique) >= limit:
            break
    return unique


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


def parse_specs_parameters(specs_html: str) -> list[dict]:
    parameters = []
    seen = set()

    row_marker = '<div role="row" class="techspecs-row">'
    pos = 0
    while True:
        start = specs_html.find(row_marker, pos)
        if start == -1:
            break
        row_block = extract_balanced_div(specs_html, start)
        pos = start + max(1, len(row_block))

        header_match = re.search(r'class="techspecs-rowheader"[^>]*>([\s\S]*?)</div>', row_block)
        header = normalize_key(header_match.group(1)) if header_match else ''
        if not header:
            continue

        p_blocks = re.findall(r'<p[^>]*>([\s\S]*?)</p>', row_block, flags=re.I)
        if not p_blocks:
            li_blocks = re.findall(r'<li[^>]*>([\s\S]*?)</li>', row_block, flags=re.I)
            p_blocks = li_blocks

        for p_html in p_blocks:
            if not p_html.strip():
                continue
            strong_match = re.search(r'<strong[^>]*>([\s\S]*?)</strong>', p_html, flags=re.I)
            sub_key = normalize_key(strong_match.group(1)) if strong_match else ''
            text = normalize_key(p_html)
            if sub_key and text.startswith(sub_key):
                text = normalize_key(text[len(sub_key):])

            key = f'{header}：{sub_key}' if sub_key else header
            value = text if text else sub_key
            if not key or not value:
                continue
            if len(value) < 2:
                continue

            row = {'name': key[:42], 'value': value[:220]}
            signature = (row['name'], row['value'])
            if signature in seen:
                continue
            seen.add(signature)
            parameters.append(row)

    # 补一层关键词行扫描，确保像“视频播放最长可达 xx 小时”不会漏掉
    battery_hits = re.findall(r'(视频播放[\s\S]{0,80}?小时|流媒体视频播放[\s\S]{0,80}?小时|最多可充至[^<]{0,60}电量)', specs_html)
    for hit in battery_hits:
        value = normalize_key(hit)
        if not value:
            continue
        row = {'name': '电源和电池：关键指标', 'value': value[:220]}
        signature = (row['name'], row['value'])
        if signature in seen:
            continue
        seen.add(signature)
        parameters.append(row)

    return parameters[:140]


def parse_compatibility_models(detail_html: str) -> list[str]:
    models = []
    seen = set()
    for item in re.findall(r'rf-pdp-compatibility-productlistitems[\s\S]*?<span>([\s\S]*?)</span>', detail_html):
        text = normalize_key(item)
        if not text:
            continue
        if text in seen:
            continue
        seen.add(text)
        models.append(text)
    return models


def build_device_aliases(products: list[dict]) -> dict:
    aliases = {}
    for product in products:
        if product.get('category') not in DEVICE_CATEGORIES:
            continue
        pid = product.get('id')
        name = str(product.get('name', '')).strip()
        if not pid or not name:
            continue

        values = {name}
        values.add(re.sub(r'\([^)]*\)', '', name).strip())
        values.add(name.replace('（', '(').replace('）', ')'))
        values = {v for v in values if v}
        aliases[pid] = {normalize_for_match(v) for v in values if normalize_for_match(v)}
    return aliases


def extract_model_like_tokens(text: str) -> list[str]:
    clean = text.replace('（', '(').replace('）', ')')
    segments = re.split(r'[，,、/;；|]', clean)
    out = []
    for seg in segments:
        seg = seg.strip()
        if not seg:
            continue
        if '适用于' in seg:
            seg = seg.split('适用于', 1)[-1].strip()
        seg = re.sub(r'^\(|\)$', '', seg).strip()
        if seg:
            out.append(seg)
    return out


def map_compatibility_ids(models: list[str], name: str, desc: str, device_aliases: dict) -> list[str]:
    candidates = []
    candidates.extend(models)
    candidates.extend(extract_model_like_tokens(name))
    candidates.extend(extract_model_like_tokens(desc))
    normalized = [normalize_for_match(item) for item in candidates if normalize_for_match(item)]

    matched = []
    for device_id, alias_set in device_aliases.items():
        if any(alias and (alias in text or text in alias) for text in normalized for alias in alias_set):
            matched.append(device_id)
    return sorted(set(matched))


def contains_battery_data(parameters: list[dict]) -> bool:
    merged = ' '.join([f"{item.get('name', '')} {item.get('value', '')}" for item in parameters]).lower()
    return any(hint.lower() in merged for hint in BATTERY_HINTS)


def main() -> None:
    data = json.loads(PRODUCTS_PATH.read_text(encoding='utf-8'))
    products = data.get('products', [])
    if not isinstance(products, list) or not products:
        raise RuntimeError('apple_products.json 缺少 products')

    print(f'[enrich-c] products={len(products)}')
    updated_at = now_iso()

    buy_urls = sorted({str(item.get('buyUrl', '')).strip() for item in products if str(item.get('buyUrl', '')).strip()})
    specs_urls = sorted({str(item.get('specsUrl', '')).strip() for item in products if str(item.get('specsUrl', '')).strip()})
    accessory_detail_urls = sorted(
        {
            str(item.get('detailUrl', '')).strip()
            for item in products
            if str(item.get('detailUrl', '')).strip() and str(item.get('category', '')).strip() in ACCESSORY_CATEGORIES
        }
    )

    all_urls = sorted(set(buy_urls + specs_urls + accessory_detail_urls))
    print(f'[enrich-c] fetch_urls={len(all_urls)} workers={MAX_WORKERS}')

    html_cache = {}
    fetch_errors = {}
    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as executor:
        futures = [executor.submit(fetch_url_job, url) for url in all_urls]
        done = 0
        for future in as_completed(futures):
            url, html, error = future.result()
            done += 1
            if error:
                fetch_errors[url] = error
            else:
                html_cache[url] = html
            if done % 25 == 0 or done == len(all_urls):
                print(f'[enrich-c] fetched {done}/{len(all_urls)}')

    device_aliases = build_device_aliases(products)
    accessory_to_devices = {}
    device_to_accessories = {item['id']: [] for item in products if item.get('category') in DEVICE_CATEGORIES}

    enhanced = 0
    battery_completed = 0
    for product in products:
        buy_url = str(product.get('buyUrl', '')).strip()
        detail_url = str(product.get('detailUrl', '')).strip()
        specs_url = str(product.get('specsUrl', '')).strip()
        category = str(product.get('category', '')).strip()

        # 1) 变体价格
        variants = []
        if buy_url and buy_url in html_cache:
            html = html_cache[buy_url]
            variants.extend(parse_named_prices(html))
            variants.extend(parse_key_prices(html))

        variants = unique_variants(sorted(variants, key=lambda item: (item.get('price', 10**9), item.get('label', ''))))
        if variants:
            min_price = min(item['price'] for item in variants)
            max_price = max(item['price'] for item in variants)
            discount = int(round(min_price * 0.2))
            final_price = min_price - discount
            product['variantPrices'] = variants
            product['priceMin'] = min_price
            product['priceMax'] = max_price
            product['officialPrice'] = min_price
            product['discountAmount'] = discount
            product['finalPrice'] = final_price
            product['priceSource'] = 'variant-min'
            product['priceUpdatedAt'] = updated_at

        # 2) 全量规格参数
        full_params = []
        if specs_url and specs_url in html_cache:
            full_params = parse_specs_parameters(html_cache[specs_url])
        if full_params:
            product['fullParameters'] = full_params
            if category in DEVICE_CATEGORIES and contains_battery_data(full_params):
                battery_completed += 1

        # 3) 配件兼容矩阵
        if category in ACCESSORY_CATEGORIES:
            models = []
            if detail_url and detail_url in html_cache:
                models = parse_compatibility_models(html_cache[detail_url])
            desc = str(product.get('desc', ''))
            compat_ids = map_compatibility_ids(models, str(product.get('name', '')), desc, device_aliases)
            if models:
                product['compatibilityModels'] = models[:80]
            if compat_ids:
                product['compatibilityDeviceIds'] = compat_ids
                accessory_to_devices[product['id']] = compat_ids
                for did in compat_ids:
                    if did in device_to_accessories:
                        device_to_accessories[did].append(product['id'])

        product['knowledgeUpdatedAt'] = updated_at
        enhanced += 1

    for did in list(device_to_accessories.keys()):
        device_to_accessories[did] = sorted(set(device_to_accessories[did]))

    matrix = {
        'updatedAt': updated_at,
        'source': 'apple.com.cn official pages (shop/detail/specs)',
        'coverage': {
            'products': len(products),
            'accessoriesWithCompat': len(accessory_to_devices),
            'devicesWithAccessories': sum(1 for v in device_to_accessories.values() if v)
        },
        'deviceToAccessories': device_to_accessories,
        'accessoryToDevices': accessory_to_devices
    }

    data['products'] = products
    data['meta'] = {
        'knowledgePlan': 'C',
        'updatedAt': updated_at,
        'source': 'official',
        'fetchErrors': len(fetch_errors),
        'batteryParamCoverageDevices': battery_completed,
        'totalProducts': len(products)
    }
    PRODUCTS_PATH.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding='utf-8')
    MATRIX_PATH.write_text(json.dumps(matrix, ensure_ascii=False, indent=2), encoding='utf-8')

    # 同步到 apple_kb（设备层）
    if KB_PATH.exists():
        kb = json.loads(KB_PATH.read_text(encoding='utf-8'))
        id_map = {item.get('id'): item for item in products}
        devices = kb.get('devices', [])
        if isinstance(devices, list):
            for item in devices:
                pid = item.get('id')
                product = id_map.get(pid)
                if not product:
                    continue
                item['official_price'] = product.get('officialPrice')
                item['discount_amount'] = product.get('discountAmount')
                item['final_price'] = product.get('finalPrice')
                if product.get('fullParameters'):
                    item['full_parameters'] = product.get('fullParameters')
                if product.get('compatibilityDeviceIds'):
                    item['compatibility_device_ids'] = product.get('compatibilityDeviceIds')
                item['knowledge_updated_at'] = updated_at
        KB_PATH.write_text(json.dumps(kb, ensure_ascii=False, indent=2), encoding='utf-8')

    print(f'[enrich-c] enhanced={enhanced} products')
    print(f'[enrich-c] accessory_to_devices={len(accessory_to_devices)}')
    print(f'[enrich-c] battery_params_devices={battery_completed}')
    print(f'[enrich-c] fetch_errors={len(fetch_errors)}')
    if fetch_errors:
        sample = list(fetch_errors.items())[:5]
        print('[enrich-c] fetch error samples:')
        for url, err in sample:
            print(f' - {url} => {err[:180]}')


if __name__ == '__main__':
    main()
