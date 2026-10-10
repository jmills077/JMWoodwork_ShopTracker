#!/usr/bin/env python3
"""Read Parkerville Wood Products' public lumber price lists and write lumber-prices.json.

Run weekly by .github/workflows/lumber-prices.yml. Shop Tracker loads the JSON and
updates the price of every species linked to a Parkerville item in Settings.
Exits with an error, leaving the previous file untouched, if a price list can't be read.
"""
import json
import re
import sys
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

PAGES = {
    "domestic": "https://parkervillewoodproducts.com/domestic-pricing/",
    "exotic": "https://parkervillewoodproducts.com/exotic-pricing/",
}
MIN_ROWS = {"domestic": 60, "exotic": 15}   # fewer than this means the page changed, not the prices
OUT = Path(__file__).resolve().parent.parent / "lumber-prices.json"
HEADERS = {"User-Agent": "Mozilla/5.0 (compatible; ShopTracker weekly price check)"}


def fetch(url, referer=None):
    request = urllib.request.Request(url, headers={**HEADERS, **({"Referer": referer} if referer else {})})
    with urllib.request.urlopen(request, timeout=60) as response:
        return response.read().decode("utf-8", errors="replace")


def clean(value):
    text = re.sub(r"<[^>]+>", "", str(value or ""))
    return "" if text.strip() in ("--", "-") else " ".join(text.split())


def read_list(name, page_url):
    # The price table is filled in by the page from a data address embedded in it.
    match = re.search(r'"data_request_url":"([^"]+)"', fetch(page_url))
    if not match:
        raise RuntimeError(f"{name}: no price table found on {page_url}")
    rows = json.loads(fetch(json.loads(f'"{match.group(1)}"'), referer=page_url))
    items = []
    for row in rows:
        value = row.get("value", row)
        price = re.sub(r"[^0-9.]", "", str(value.get("price", "")))
        species = clean(value.get("species"))
        if not species or not re.fullmatch(r"\d+(\.\d+)?", price) or float(price) <= 0:
            continue
        items.append({
            "id": f"{name[0]}{value.get('___id___')}",
            "list": name,
            "species": species,
            "size": clean(value.get("size") or value.get("sizes")),   # the two lists name this column differently
            "wide": clean(value.get("extra_wide")),
            "spec": clean(value.get("specifications")),
            "price": round(float(price), 2),
        })
    if len(items) < MIN_ROWS[name]:
        raise RuntimeError(f"{name}: only {len(items)} priced rows found, expected at least {MIN_ROWS[name]}")
    return items


def main():
    items = []
    for name, url in PAGES.items():
        found = read_list(name, url)
        print(f"{name}: {len(found)} prices")
        items += found
    OUT.write_text(json.dumps({
        "source": "Parkerville Wood Products",
        "checked": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "items": items,
    }, indent=1) + "\n")
    print(f"wrote {OUT.name}")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:   # keep last week's prices rather than publish a broken list
        print(f"Price update failed: {error}", file=sys.stderr)
        sys.exit(1)
