import os
import json
import time
import random
import re
from datetime import datetime
import cloudscraper
from bs4 import BeautifulSoup

DATA_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'data')
OUTPUT_FILE = os.path.join(DATA_DIR, 'quasarplay.json')
BASE_URL = 'https://quasarplay.com/bbs/qp_korean'
MAX_PAGES = 100

def load_existing_data():
    try:
        with open(OUTPUT_FILE, 'r', encoding='utf-8') as f:
            return json.load(f)
    except FileNotFoundError:
        return []

def extract_steam_app_id(onclick_attr):
    if not onclick_attr:
        return None
    match = re.search(r'store\.steampowered\.com/app/(\d+)', onclick_attr)
    return match.group(1) if match else None

def create_scraper():
    # Configure 2Captcha if API key is present
    captcha_key = os.environ.get('TWO_CAPTCHA_API_KEY')
    captcha_config = {
        'provider': '2captcha',
        'api_key': captcha_key
    } if captcha_key else {}

    scraper = cloudscraper.create_scraper(
        browser={
            'browser': 'chrome',
            'platform': 'windows',
            'desktop': True
        },
        captcha=captcha_config
    )

    # Load cookies from env if present (fallback for 403)
    cookie_str = os.environ.get('QUASARPLAY_COOKIE')
    if cookie_str:
        cookies = {}
        for part in cookie_str.split(';'):
            if '=' in part:
                name, value = part.strip().split('=', 1)
                cookies[name] = value
        scraper.cookies.update(cookies)
        print(f"Loaded {len(cookies)} cookies from QUASARPLAY_COOKIE")

    return scraper

def scrape_page(scraper, page_num):
    url = f"{BASE_URL}?page={page_num}"
    print(f"Fetching: {url}")
    
    try:
        response = scraper.get(url)
        if response.status_code != 200:
            print(f"Failed to fetch page {page_num}: {response.status_code}")
            # Debug: Print headers and small body snippet
            print("Response Headers:", dict(response.headers))
            print("Response Body Snippet:", response.text[:500])
            return []

        soup = BeautifulSoup(response.text, 'html.parser')
        games = []
        
        rows = soup.select('table tbody tr.item')
        
        for row in rows:
            type_span = row.select_one('td.type_area span.type')
            type_text = type_span.get_text(strip=True) if type_span else ""
            patch_type = 'user' if '유저' in type_text else 'official'
            
            details = row.select_one('td.details-control')
            if not details:
                continue

            thumbnail = details.select_one('.thumbnail_wrapper')
            onclick_attr = thumbnail.get('onclick', '') if thumbnail else ''
            steam_app_id = extract_steam_app_id(onclick_attr)
            
            title_p = details.select_one('p.title')
            game_title = title_p.get_text(strip=True) if title_p else ''
            
            download_link_a = details.select_one('p.download_link a.forward')
            patch_link = download_link_a.get('href', '') if download_link_a else ''
            
            # Remove colorGray3 spans to get clean producer text
            producer_p = details.select_one('p.producer')
            producer = ""
            if producer_p:
                for span in producer_p.select('span.colorGray3'):
                    span.decompose()
                producer = producer_p.get_text(strip=True)

            steam_link = f"https://store.steampowered.com/app/{steam_app_id}" if steam_app_id else ''
            
            if game_title:
                games.append({
                    'source': 'quasarplay',
                    'app_id': steam_app_id,
                    'game_title': game_title,
                    'steam_link': steam_link,
                    'patch_type': patch_type,
                    'patch_links': [patch_link] if patch_link else [],
                    'description': f"제작자: {producer}" if producer else '',
                    'updated_at': datetime.utcnow().isoformat() + 'Z'
                })
        
        return games

    except Exception as e:
        print(f"Error scraping page {page_num}: {e}")
        return []

def main():
    print('Starting quasarplay.com scraper (Python/Cloudscraper)...')
    
    os.makedirs(DATA_DIR, exist_ok=True)
    
    existing_data = load_existing_data()
    existing_map = {g.get('app_id') or g.get('game_title'): g for g in existing_data}
    all_games = {} # Use dict to dedupe
    
    scraper = create_scraper()
    
    consecutive_duplicates = 0
    duplicate_threshold = 3
    
    for page_num in range(1, MAX_PAGES + 1):
        games = scrape_page(scraper, page_num)
        
        if not games:
            print(f"No games found on page {page_num}, stopping.")
            break
            
        new_games_on_page = 0
        for game in games:
            key = game.get('app_id') or game.get('game_title')
            
            # If we don't have it in current run AND don't have it in existing data -> New
            # Or if we want to update regardless? The original logic was:
            # if not in allGames and not in existingMap -> New
            # if not in allGames -> Add to allGames
            
            if key not in all_games and key not in existing_map:
                all_games[key] = game
                new_games_on_page += 1
            elif key not in all_games:
                all_games[key] = game
        
        print(f"Page {page_num}: {len(games)} games ({new_games_on_page} new)")
        
        if new_games_on_page == 0:
            consecutive_duplicates += 1
            if consecutive_duplicates >= duplicate_threshold:
                print(f"{duplicate_threshold} consecutive pages with no new games, stopping.")
                break
        else:
            consecutive_duplicates = 0
            
        time.sleep(random.uniform(1, 3))

    # Merge new data with existing
    # existing_map was initial state. Update it with all_games found in this run
    for key, game in all_games.items():
        existing_map[key] = game
        
    merged = list(existing_map.values())
    
    with open(OUTPUT_FILE, 'w', encoding='utf-8') as f:
        json.dump(merged, f, indent=2, ensure_ascii=False)
        
    print(f"Saved {len(merged)} games to {OUTPUT_FILE}")

if __name__ == '__main__':
    main()
