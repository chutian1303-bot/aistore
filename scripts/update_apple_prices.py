#!/usr/bin/env python3
import json
import re
from html import unescape
from pathlib import Path
from typing import Optional
from concurrent.futures import ThreadPoolExecutor, as_completed
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
PRODUCTS_PATH = ROOT / 'data' / 'apple_products.json'
KB_PATH = ROOT / 'data' / 'apple_kb.json'

USER_AGENT = (
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) '
    'AppleWebKit/537.36 (KHTML, like Gecko) '
    'Chrome/123.0.0.0 Safari/537.36'
)
MAX_WORKERS = 6
REQUEST_TIMEOUT = 16
REQUEST_RETRIES = 2

HIGH_SIGNAL_TOKENS = {
    'plus', 'max', 'ultra', 'mini', 'se', 'pro',
    '11', '13', '14', '15', '16', '17', '40', '42', '44', '46', '49',
    'm3', 'm4', 'm5', 'm3ultra', 'm4pro', 'm4max', 'm5pro', 'm5max',
    '2port', '4port'
}

GENERIC_TOKENS = {
    'apple', 'iphone', 'ipad', 'mac', 'macbook', 'watch', 'airpods', 'homepod',
    'vision', 'inch', 'wi', 'fi', 'cellular', 'gb', 'tb', 'mm', 'ch', 'a'
}

VARIANT_TOKENS = {'plus', 'max', 'ultra', 'mini', 'se'}
SIZE_TOKENS = {'11', '13', '14', '15', '16', '17', '40', '42', '44', '46', '49'}
MANUAL_FALLBACK_PRICES = {
    'Apple Vision Pro': 32999
}


def fetch_html(url: str, retries: int = REQUEST_RETRIES, timeout: int = REQUEST_TIMEOUT) -> str:
    last_error = None
    for _ in range(max(1, retries)):
        try:
            req = Request(url, headers={'User-Agent': USER_AGENT})
            with urlopen(req, timeout=timeout) as resp:
                return resp.read().decode('utf-8', errors='ignore')
        except Exception as error:  # noqa: BLE001
            last_error = error
    raise RuntimeError(f'fetch failed: {url} ({last_error})')


def fetch_price_sources(url: str) -> tuple[str, list[tuple[str, int]], list[tuple[str, int]], Optional[str]]:
    try:
        html = fetch_html(url)
        return url, parse_named_prices(html), parse_key_prices(html), None
    except Exception as error:  # noqa: BLE001
        return url, [], [], str(error)


def normalize_text(text: str) -> str:
    text = unescape(str(text or '')).lower().replace('\xa0', ' ')
    replacements = {
        '（': ' ', '）': ' ', '(': ' ', ')': ' ', '，': ' ', '、': ' ',
        '+': ' plus ', '英寸': ' inch ', '毫米': ' mm ', '/': ' ', '-': ' '
    }
    for src, dst in replacements.items():
        text = text.replace(src, dst)
    text = re.sub(r'[^a-z0-9\u4e00-\u9fff]+', ' ', text)
    return re.sub(r'\s+', ' ', text).strip()


def tokenize(text: str) -> set[str]:
    normalized = normalize_text(text)
    tokens = set(normalized.split()) if normalized else set()

    merged = normalized.replace(' ', '')
    for combo in ('m3ultra', 'm4pro', 'm4max', 'm5pro', 'm5max'):
        if combo in merged:
            tokens.add(combo)

    if '两个端口' in text:
        tokens.add('2port')
    if '四个端口' in text:
        tokens.add('4port')

    return tokens


def score_tokens(target: set[str], candidate: set[str]) -> int:
    score = 0

    for token in target:
        if token in candidate:
            score += 5 if token in HIGH_SIGNAL_TOKENS else 2

    for token in VARIANT_TOKENS:
        if token in target and token not in candidate:
            score -= 5
        if token in candidate and token not in target:
            score -= 4

    for token in SIZE_TOKENS:
        if token in target and token in candidate:
            score += 3
        elif token in target and token not in candidate:
            score -= 1

    return score


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
    except Exception:
        return {}


def parse_named_prices(html: str) -> list[tuple[str, int]]:
    results = []
    seen = set()
    patterns = [
        re.compile(r'"price":\{"fullPrice":\s*([0-9]+(?:\.[0-9]+)?)\},"category":"[^"]*","name":"([^"]+)"'),
        re.compile(r'fullPrice":\s*([0-9]+(?:\.[0-9]+)?)\},"category":"[^"]*","name":"([^"]+)"')
    ]

    for pattern in patterns:
        for price_raw, name in pattern.findall(html):
            price = int(round(float(price_raw)))
            key = (name, price)
            if key in seen:
                continue
            seen.add(key)
            results.append((name, price))

    return results


def parse_key_prices(html: str) -> list[tuple[str, int]]:
    prices_obj = extract_json_object_after(html, '"prices":')
    pairs = []

    for key, payload in prices_obj.items():
        if not isinstance(payload, dict):
            continue

        price = None
        if isinstance(payload.get('amount'), (int, float)):
            price = float(payload['amount'])
        elif isinstance(payload.get('amountBeforeTradeIn'), (int, float)):
            price = float(payload['amountBeforeTradeIn'])
        else:
            current = payload.get('currentPrice')
            if isinstance(current, dict):
                raw = current.get('raw_amount')
                try:
                    price = float(raw)
                except Exception:
                    price = None

        if price and price > 0:
            pairs.append((str(key), int(round(price))))

    return pairs


def choose_official_price(product: dict, named_prices: list[tuple[str, int]], key_prices: list[tuple[str, int]]) -> tuple[Optional[int], str]:
    product_name = product.get('name', '')
    target_tokens = tokenize(product_name)
    target_tokens = {t for t in target_tokens if t and t not in GENERIC_TOKENS}

    if '两个端口' in product_name and key_prices:
        return min(price for _, price in key_prices), 'key-min'
    if '四个端口' in product_name and key_prices:
        return max(price for _, price in key_prices), 'key-max'

    if named_prices:
        scored = []
        for name, price in named_prices:
            score = score_tokens(target_tokens, tokenize(name))
            scored.append((score, price))
        scored.sort(key=lambda item: (item[0], -item[1]), reverse=True)
        if scored and scored[0][0] > 0:
            best_score = scored[0][0]
            best_prices = [price for score, price in scored if score == best_score]
            return min(best_prices), 'name-match'

    if key_prices:
        scored = []
        for key, price in key_prices:
            key_tokens = tokenize(key.replace('_', ' '))
            score = score_tokens(target_tokens, key_tokens)
            scored.append((score, price))
        scored.sort(key=lambda item: (item[0], -item[1]), reverse=True)
        if scored and scored[0][0] > 0:
            best_score = scored[0][0]
            best_prices = [price for score, price in scored if score == best_score]
            return min(best_prices), 'key-match'

    if named_prices:
        return min(price for _, price in named_prices), 'name-fallback'
    if key_prices:
        return min(price for _, price in key_prices), 'key-fallback'

    return None, 'none'


def main() -> None:
    products_data = json.loads(PRODUCTS_PATH.read_text(encoding='utf-8'))
    products = products_data.get('products', [])
    if not isinstance(products, list) or not products:
        raise RuntimeError('apple_products.json missing products')

    page_cache: dict[str, tuple[list[tuple[str, int]], list[tuple[str, int]]]] = {}
    fetch_errors: dict[str, str] = {}
    updated = 0
    missed = []

    unique_urls = sorted({str(item.get('buyUrl', '')).strip() for item in products if str(item.get('buyUrl', '')).strip()})
    total_urls = len(unique_urls)
    print(f'[prices] fetch urls={total_urls} workers={MAX_WORKERS}')

    if unique_urls:
        with ThreadPoolExecutor(max_workers=MAX_WORKERS) as executor:
            futures = [executor.submit(fetch_price_sources, url) for url in unique_urls]
            finished = 0
            for future in as_completed(futures):
                buy_url, named_prices, key_prices, error = future.result()
                finished += 1
                if error:
                    fetch_errors[buy_url] = error
                else:
                    page_cache[buy_url] = (named_prices, key_prices)
                if finished % 20 == 0 or finished == total_urls:
                    print(f'[prices] fetched {finished}/{total_urls}')

    for product in products:
        buy_url = str(product.get('buyUrl', '')).strip()
        if not buy_url:
            missed.append(product.get('id', 'unknown'))
            continue

        named_prices, key_prices = page_cache.get(buy_url, ([], []))

        official_price, method = choose_official_price(product, named_prices, key_prices)
        if official_price is None:
            manual = MANUAL_FALLBACK_PRICES.get(product.get('name', ''))
            if manual:
                official_price = manual
                method = 'manual-fallback'
        if official_price is None:
            missed.append(product.get('id', 'unknown'))
            continue

        discount_amount = int(round(official_price * 0.2))
        final_price = official_price - discount_amount

        product['officialPrice'] = official_price
        product['discountAmount'] = discount_amount
        product['finalPrice'] = final_price
        product['priceSource'] = method
        updated += 1

    products_data['products'] = products
    PRODUCTS_PATH.write_text(json.dumps(products_data, ensure_ascii=False, indent=2), encoding='utf-8')

    if KB_PATH.exists():
        kb_data = json.loads(KB_PATH.read_text(encoding='utf-8'))
        id_to_price = {
            item.get('id'): (
                item.get('officialPrice'),
                item.get('discountAmount'),
                item.get('finalPrice')
            )
            for item in products
        }
        devices = kb_data.get('devices', [])
        if isinstance(devices, list):
            for device in devices:
                device_id = device.get('id')
                if device_id not in id_to_price:
                    continue
                official, discount, final = id_to_price[device_id]
                if official is None:
                    continue
                device['official_price'] = official
                device['discount_amount'] = discount
                device['final_price'] = final
        KB_PATH.write_text(json.dumps(kb_data, ensure_ascii=False, indent=2), encoding='utf-8')

    print(f'[prices] updated={updated} total={len(products)}')
    if fetch_errors:
        print(f'[prices] fetch_errors={len(fetch_errors)}')
    if missed:
        print('[prices] missed ids:')
        for item in missed:
            print(f' - {item}')


if __name__ == '__main__':
    main()
