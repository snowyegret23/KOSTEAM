#!/usr/bin/env python3
import argparse
import csv
import json
import re
import sys
import time
from datetime import datetime
from pathlib import Path
from typing import Optional

import requests
from bs4 import BeautifulSoup

SCRIPT_DIR = Path(__file__).parent
DATA_DIR = SCRIPT_DIR.parent / "data"

QUASARPLAY_CURATORS = {
    "quasarplay": {"id": 42788178, "name": "퀘이사플레이", "output": "quasarplay.json"},
    "quasarzone": {"id": 30894603, "name": "퀘이사존", "output": "quasarzone.json"},
}

def normalize_base_url(raw: str) -> str:
    s = (raw or "").strip()
    for _ in range(10):
        if "\\/" not in s:
            break
        s = s.replace("\\/", "/")
    s = s.replace("\\", "")
    s = re.sub(r"^(https?:)/*", r"\1//", s)
    s = s.strip()
    if not s.endswith("/"):
        s += "/"
    return s

def sanitize_review_text(text: str):
    if not text:
        return "", False, 0
    url_pattern = re.compile(r'https?://[^\s"\'<>]+')
    urls = url_pattern.findall(text)
    cleaned = url_pattern.sub("", text)
    cleaned = re.sub(r"링크\\s*:", "", cleaned)
    cleaned = re.sub(r"\n+", "\n", cleaned).strip()
    cleaned = re.sub(r"[,\\s]+$", "", cleaned)
    return cleaned, len(urls) > 0, len(urls)

class SteamCuratorDumper:
    BASE_URL = "https://store.steampowered.com/curator"
    BATCH_SIZE = 50
    DELAY = 0.3

    def __init__(self, curator_id: int, verbose: bool = True, sort: str = "recent"):
        self.curator_id = curator_id
        self.verbose = verbose
        self.sort = sort
        self.session = requests.Session()
        self.session.headers.update({
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            "Accept-Language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7",
            "Accept": "*/*",
        })
        self.curator_name = None
        self.total_count = 0
        self._curator_page_url = f"{self.BASE_URL}/{self.curator_id}/"
        self._curator_base_url = None
        self._filtered_url = None

    def log(self, message: str):
        if self.verbose:
            print(message)

    def _prime_and_get_base(self) -> str:
        if self._curator_base_url:
            return self._curator_base_url
        r = self.session.get(self._curator_page_url, timeout=20)
        html = r.text
        m = re.search(r'g_strCuratorBaseURL\\s*=\\s*"([^"]+)"', html)
        base = None
        if m:
            base = normalize_base_url(m.group(1))
        if not base:
            soup = BeautifulSoup(html, "html.parser")
            canon = soup.find("link", rel="canonical")
            if canon and canon.get("href"):
                base = normalize_base_url(canon.get("href"))
            if not base:
                og = soup.find("meta", property="og:url")
                if og and og.get("content"):
                    base = normalize_base_url(og.get("content"))
        if not base:
            base = normalize_base_url(self._curator_page_url)
        self._curator_base_url = base
        self._filtered_url = base + "ajaxgetfilteredrecommendations/"
        return self._curator_base_url

    def get_curator_info(self) -> dict:
        url = self._curator_page_url
        try:
            r = self.session.get(url, timeout=20)
            soup = BeautifulSoup(r.text, "html.parser")
            name_elem = soup.find("h1", class_="curator_name") or soup.find("h1")
            if name_elem:
                self.curator_name = name_elem.get_text(strip=True)
            follower_elem = soup.find(class_=re.compile(r"follower|follow_count|num_followers|followers"))
            followers = 0
            if follower_elem:
                match = re.search(r"[\\d,]+", follower_elem.get_text())
                if match:
                    followers = int(match.group().replace(",", ""))
            return {
                "curator_id": self.curator_id,
                "curator_name": self.curator_name,
                "curator_url": url,
                "followers": followers,
            }
        except Exception as e:
            self.log(f"큐레이터 정보 가져오기 실패: {e}")
            return {"curator_id": self.curator_id}

    def _filtered_params(self, start: int, count: int) -> dict:
        return {
            "query": "",
            "start": str(start),
            "count": str(count),
            "dynamic_data": "",
            "tagids": "",
            "sort": self.sort,
            "app_types": "",
            "curations": "",
            "reset": "false",
        }

    def get_total_count(self) -> int:
        self._prime_and_get_base()
        try:
            r = self.session.get(self._filtered_url, params=self._filtered_params(0, 1), timeout=20)
            data = r.json()
            total = int(data.get("total_count", 0) or 0)
            self.total_count = total
            return total
        except Exception as e:
            self.log(f"전체 리뷰 수 확인 실패: {e}")
            return 0

    def fetch_reviews(self, progress_callback=None) -> list:
        all_reviews = []
        start = 0
        total = self.get_total_count()
        if total == 0:
            self.log("리뷰를 찾을 수 없습니다.")
            return []
        self.log(f"총 {total}개의 리뷰를 가져옵니다...")
        while start < total:
            try:
                r = self.session.get(self._filtered_url, params=self._filtered_params(start, self.BATCH_SIZE), timeout=20)
                data = r.json()
                if not data.get("success"):
                    self.log(f"API 요청 실패: start={start}")
                    break
                html = data.get("results_html", "")
                if not html:
                    break
                reviews = self._parse_reviews_html(html)
                all_reviews.extend(reviews)
                fetched = len(reviews)
                start += self.BATCH_SIZE
                progress = min(start, total)
                self.log(f"진행: {progress}/{total} ({len(all_reviews)} 게임 수집됨)")
                if progress_callback:
                    progress_callback(progress, total)
                if fetched <= 0:
                    break
                time.sleep(self.DELAY)
            except Exception as e:
                self.log(f"오류 발생 (start={start}): {e}")
                start += self.BATCH_SIZE
                continue
        unique_reviews = self._remove_duplicates(all_reviews)
        self.log(f"\\n완료! {len(unique_reviews)}개의 고유 게임 수집됨")
        return unique_reviews

    def _parse_reviews_html(self, html: str) -> list:
        reviews = []
        soup = BeautifulSoup(html, "html.parser")
        recommendations = soup.find_all("div", class_="recommendation")
        if not recommendations:
            recommendations = soup.find_all("div", class_=re.compile(r"curator.*recommendation"))
        for rec in recommendations:
            game_data = {}
            link = rec.find("a", href=re.compile(r"/app/\\d+"))
            if link:
                href = link.get("href", "")
                game_data["url"] = href.split("?")[0]
                app_match = re.search(r"/app/(\\d+)", href)
                if app_match:
                    game_data["appid"] = app_match.group(1)
                    game_data["curator_url"] = f"https://store.steampowered.com/app/{game_data['appid']}/?curator_clanid={self.curator_id}"
            desc_elem = rec.find(class_=re.compile(r"recommendation_desc|desc|blurb"))
            raw_review = desc_elem.get_text("\n", strip=True) if desc_elem else ""
            clean_review, has_url, url_count = sanitize_review_text(raw_review)
            game_data["review"] = clean_review
            game_data["review_has_url"] = has_url
            game_data["review_url_count"] = url_count
            rec_class = rec.get("class", [])
            rec_class_str = " ".join(rec_class) if isinstance(rec_class, list) else str(rec_class)
            if "not_recommended" in rec_class_str or "negative" in rec_class_str:
                game_data["type"] = "not_recommended"
            elif "informational" in rec_class_str:
                game_data["type"] = "informational"
            else:
                game_data["type"] = "recommended"
            if game_data.get("appid"):
                reviews.append(game_data)
        return reviews

    def _remove_duplicates(self, reviews: list) -> list:
        seen = set()
        unique = []
        for review in reviews:
            appid = review.get("appid")
            if appid and appid not in seen:
                seen.add(appid)
                unique.append(review)
        return unique

    def export_json(self, reviews: list, output_file: str):
        data = {
            "curator_id": self.curator_id,
            "curator_name": self.curator_name or f"Curator #{self.curator_id}",
            "curator_url": self._curator_page_url,
            "total_games": len(reviews),
            "exported_at": datetime.now().isoformat(),
            "games": reviews,
        }
        with open(output_file, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        self.log(f"JSON 파일 저장됨: {output_file}")

    def export_csv(self, reviews: list, output_file: str):
        with open(output_file, "w", encoding="utf-8-sig", newline="") as f:
            writer = csv.DictWriter(f, fieldnames=["appid", "url", "curator_url", "review", "review_has_url", "review_url_count", "type"])
            writer.writeheader()
            writer.writerows(reviews)
        self.log(f"CSV 파일 저장됨: {output_file}")

    def export_txt(self, reviews: list, output_file: str):
        with open(output_file, "w", encoding="utf-8") as f:
            for review in reviews:
                f.write(f"{review.get('url', '')}\n")
        self.log(f"TXT 파일 저장됨: {output_file}")

    def export_appids(self, reviews: list, output_file: str):
        with open(output_file, "w", encoding="utf-8") as f:
            for review in reviews:
                f.write(f"{review.get('appid', '')}\n")
        self.log(f"AppID 파일 저장됨: {output_file}")

def extract_curator_id(input_str: str) -> Optional[int]:
    m = re.search(r"curator/(\\d+)", input_str)
    if m:
        return int(m.group(1))
    if input_str.isdigit():
        return int(input_str)
    return None

def run_quasarplay_dump(sort: str):
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    print("=" * 60)
    print("퀘이사플레이 큐레이터 덤프")
    print("=" * 60)
    for _, config in QUASARPLAY_CURATORS.items():
        print(f"\\n[{config['name']}] 덤프 시작...")
        print(f"  큐레이터 ID: {config['id']}")
        dumper = SteamCuratorDumper(config["id"], verbose=True, sort=sort)
        info = dumper.get_curator_info()
        if info.get("followers"):
            print(f"  팔로워: {info['followers']:,}명")
        reviews = dumper.fetch_reviews()
        if reviews:
            output_path = DATA_DIR / config["output"]
            dumper.export_json(reviews, str(output_path))
            print(f"  저장됨: {output_path} ({len(reviews)}개 게임)")
        else:
            print(f"  경고: {config['name']} 리뷰를 가져오지 못했습니다.")
    print("\\n" + "=" * 60)
    print("퀘이사플레이 큐레이터 덤프 완료!")
    print("=" * 60)

def main():
    parser = argparse.ArgumentParser(description="Steam 큐레이터 리뷰 덤프 도구")
    parser.add_argument("curator", nargs="?", help="큐레이터 ID 또는 URL")
    parser.add_argument("-o", "--output", help="출력 파일명")
    parser.add_argument("-f", "--format", choices=["json", "csv", "txt", "appids"], default="json", help="출력 형식")
    parser.add_argument("-q", "--quiet", action="store_true", help="진행 상황 출력 안함")
    parser.add_argument("--sort", default="recent", help="정렬 (recent 등)")
    parser.add_argument("--quasarplay", action="store_true", help="퀘이사플레이/퀘이사존 둘 다 덤프")
    args = parser.parse_args()

    if args.quasarplay:
        run_quasarplay_dump(sort=args.sort)
        return

    if not args.curator:
        parser.error("curator 인자가 필요합니다. 또는 --quasarplay 옵션을 사용하세요.")

    curator_id = extract_curator_id(args.curator)
    if not curator_id:
        print(f"오류: 유효하지 않은 큐레이터 ID 또는 URL: {args.curator}")
        sys.exit(1)

    if args.output:
        output_file = args.output
    else:
        ext = "txt" if args.format in ["txt", "appids"] else args.format
        output_file = f"curator_{curator_id}_reviews.{ext}"

    print("=" * 60)
    print("Steam 큐레이터 리뷰 덤프 도구")
    print("=" * 60)
    print(f"큐레이터 ID: {curator_id}")
    print(f"출력 형식: {args.format}")
    print(f"출력 파일: {output_file}")
    print()

    dumper = SteamCuratorDumper(curator_id, verbose=not args.quiet, sort=args.sort)

    info = dumper.get_curator_info()
    if info.get("curator_name"):
        print(f"큐레이터: {info['curator_name']}")
    if info.get("followers"):
        print(f"팔로워: {info['followers']:,}명")
    print()

    reviews = dumper.fetch_reviews()
    if not reviews:
        print("리뷰를 가져오지 못했습니다.")
        sys.exit(1)

    if args.format == "json":
        dumper.export_json(reviews, output_file)
    elif args.format == "csv":
        dumper.export_csv(reviews, output_file)
    elif args.format == "txt":
        dumper.export_txt(reviews, output_file)
    elif args.format == "appids":
        dumper.export_appids(reviews, output_file)

    print()
    print("=" * 60)
    print(f"완료! 총 {len(reviews)}개의 게임 정보가 저장되었습니다.")
    print("=" * 60)

if __name__ == "__main__":
    main()
