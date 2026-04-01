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
    s = re.sub(r"^(https?:)/*", r"\1//", s).strip()
    if not s.endswith("/"):
        s += "/"
    return s

def sanitize_review_text(text: str):
    if not text:
        return "", False, 0
    url_pattern = re.compile(r'https?://[^\s"\'<>]+')
    urls = url_pattern.findall(text)
    cleaned = url_pattern.sub("", text)
    cleaned = re.sub(r"링크\s*:", "", cleaned)
    cleaned = re.sub(r"\n+", "\n", cleaned).strip()
    cleaned = re.sub(r"[,\\s]+$", "", cleaned)
    return cleaned, len(urls) > 0, len(urls)

def to_abs_steam_url(href: str) -> str:
    if not href:
        return ""
    h = href.strip()
    if h.startswith("http://") or h.startswith("https://"):
        return h.split("?")[0]
    if h.startswith("/"):
        return ("https://store.steampowered.com" + h).split("?")[0]
    return h.split("?")[0]

def is_date_like(text: str) -> bool:
    t = (text or "").strip()
    if not t:
        return False
    if len(t) > 32:
        return False
    months = r"(January|February|March|April|May|June|July|August|September|October|November|December)"
    if re.match(rf"^\d{{1,2}}\s+{months}(,?\s*\d{{4}})?$", t):
        return True
    if re.match(rf"^{months}\s+\d{{1,2}},?\s*\d{{4}}$", t):
        return True
    if re.match(r"^\d{4}-\d{2}-\d{2}$", t):
        return True
    if re.match(r"^\d{4}\.\d{1,2}\.\d{1,2}\.?$", t):
        return True
    if re.match(r"^\d{4}년\s*\d{1,2}월\s*\d{1,2}일$", t):
        return True
    return False

class SteamCuratorDumper:
    BASE_URL = "https://store.steampowered.com/curator"

    def __init__(self, curator_id: int, verbose: bool = True, sort: str = "recent", batch_size: int = 50, delay: float = 0.3):
        self.curator_id = curator_id
        self.verbose = verbose
        self.sort = sort
        self.batch_size = int(batch_size)
        self.delay = float(delay)
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
        if self._curator_base_url and self._filtered_url:
            return self._curator_base_url
        r = self.session.get(self._curator_page_url, timeout=25)
        html = r.text or ""
        m = re.search(r'g_strCuratorBaseURL\s*=\s*"([^"]+)"', html)
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
            r = self.session.get(url, timeout=25)
            soup = BeautifulSoup(r.text, "html.parser")
            name_elem = soup.find("h1", class_="curator_name") or soup.find("h1")
            if name_elem:
                self.curator_name = name_elem.get_text(strip=True)
            follower_elem = soup.find(class_=re.compile(r"follower|follow_count|num_followers|followers"))
            followers = 0
            if follower_elem:
                m = re.search(r"[\d,]+", follower_elem.get_text())
                if m:
                    digits = re.sub(r"[^0-9]", "", m.group(0))
                    followers = int(digits) if digits else 0
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

    def _fetch_filtered(self, start: int, count: int) -> dict:
        self._prime_and_get_base()
        headers = {
            "Referer": self._curator_page_url,
            "X-Requested-With": "XMLHttpRequest",
            "Accept": "*/*",
        }
        r = self.session.get(self._filtered_url, params=self._filtered_params(start, count), headers=headers, timeout=25)
        return r.json()

    def get_total_count(self) -> int:
        try:
            data = self._fetch_filtered(0, 1)
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
                data = self._fetch_filtered(start, self.batch_size)
                if not data.get("success"):
                    self.log(f"API 요청 실패: start={start}")
                    break
                html = data.get("results_html", "")
                if not html:
                    break
                reviews = self._parse_reviews_html(html)
                all_reviews.extend(reviews)
                fetched = len(reviews)
                start += self.batch_size
                progress = min(start, total)
                self.log(f"진행: {progress}/{total} ({len(all_reviews)} 게임 수집됨)")
                if progress_callback:
                    progress_callback(progress, total)
                if fetched <= 0:
                    break
                time.sleep(self.delay)
            except Exception as e:
                self.log(f"오류 발생 (start={start}): {e}")
                start += self.batch_size
                continue
        unique = self._remove_duplicates(all_reviews)
        self.log(f"\n완료! {len(unique)}개의 고유 게임 수집됨")
        return unique

    def _pick_best_review_text(self, container) -> str:
        candidates = []
        selectors = [
            r"recommendation_desc",
            r"recommendation_desc_text",
            r"curator_review",
            r"curator_review_desc",
            r"blurb",
            r"desc",
        ]
        for pat in selectors:
            elem = container.find(class_=re.compile(pat)) if getattr(container, "find", None) else None
            if elem:
                txt = elem.get_text("\n", strip=True)
                if txt:
                    candidates.append(txt)
        if not candidates:
            for elem in container.find_all(["div", "span", "p"], limit=60):
                cls = elem.get("class", [])
                cls_str = " ".join(cls) if isinstance(cls, list) else str(cls)
                if any(k in cls_str for k in ["date", "posted", "time", "timestamp"]):
                    continue
                txt = elem.get_text("\n", strip=True)
                if txt and len(txt) >= 8:
                    candidates.append(txt)
        best = ""
        for txt in candidates:
            if is_date_like(txt):
                continue
            if len(txt) > len(best):
                best = txt
        return best

    def _parse_reviews_html(self, html: str) -> list:
        soup = BeautifulSoup(html, "html.parser")
        results = []
        seen = set()

        app_links = soup.find_all("a", href=re.compile(r"/app/\d+"))
        for link in app_links:
            href = link.get("href", "")
            m = re.search(r"/app/(\d+)", href)
            if not m:
                continue
            appid = m.group(1)
            if appid in seen:
                continue

            container = link
            for _ in range(14):
                parent = getattr(container, "parent", None)
                if not parent:
                    break
                if getattr(parent, "name", None) == "div":
                    cls = parent.get("class", [])
                    cls_str = " ".join(cls) if isinstance(cls, list) else str(cls)
                    if ("recommend" in cls_str) or ("curator" in cls_str):
                        container = parent
                        break
                container = parent

            raw_review = self._pick_best_review_text(container) if container else ""
            clean_review, has_url, url_count = sanitize_review_text(raw_review)

            cls_acc = []
            cur = container
            for _ in range(10):
                if not cur:
                    break
                c = cur.get("class", [])
                if isinstance(c, list):
                    cls_acc.extend(c)
                cur = getattr(cur, "parent", None)
            cls_str = " ".join(cls_acc)
            if "not_recommended" in cls_str or "negative" in cls_str:
                rec_type = "not_recommended"
            elif "informational" in cls_str:
                rec_type = "informational"
            else:
                rec_type = "recommended"

            url = to_abs_steam_url(href) or f"https://store.steampowered.com/app/{appid}"
            curator_url = f"https://store.steampowered.com/app/{appid}/?curator_clanid={self.curator_id}"

            results.append({
                "appid": appid,
                "url": url,
                "curator_url": curator_url,
                "review": clean_review,
                "review_has_url": has_url,
                "review_url_count": url_count,
                "type": rec_type,
            })
            seen.add(appid)

        return results

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
        Path(output_file).parent.mkdir(parents=True, exist_ok=True)
        with open(output_file, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        self.log(f"JSON 파일 저장됨: {output_file}")

    def export_csv(self, reviews: list, output_file: str):
        Path(output_file).parent.mkdir(parents=True, exist_ok=True)
        with open(output_file, "w", encoding="utf-8-sig", newline="") as f:
            writer = csv.DictWriter(
                f,
                fieldnames=["appid", "url", "curator_url", "review", "review_has_url", "review_url_count", "type"],
            )
            writer.writeheader()
            writer.writerows(reviews)
        self.log(f"CSV 파일 저장됨: {output_file}")

    def export_txt(self, reviews: list, output_file: str):
        Path(output_file).parent.mkdir(parents=True, exist_ok=True)
        with open(output_file, "w", encoding="utf-8") as f:
            for review in reviews:
                f.write(f"{review.get('url', '')}\n")
        self.log(f"TXT 파일 저장됨: {output_file}")

    def export_appids(self, reviews: list, output_file: str):
        Path(output_file).parent.mkdir(parents=True, exist_ok=True)
        with open(output_file, "w", encoding="utf-8") as f:
            for review in reviews:
                f.write(f"{review.get('appid', '')}\n")
        self.log(f"AppID 파일 저장됨: {output_file}")

def extract_curator_id(input_str: str) -> Optional[int]:
    m = re.search(r"curator/(\d+)", input_str)
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
        print(f"\n[{config['name']}] 덤프 시작...")
        print(f"  큐레이터 ID: {config['id']}")
        dumper = SteamCuratorDumper(config["id"], verbose=True, sort=sort)
        info = dumper.get_curator_info()
        if info.get("followers") is not None:
            print(f"  팔로워: {info.get('followers', 0):,}명")
        reviews = dumper.fetch_reviews()
        if reviews:
            output_path = DATA_DIR / config["output"]
            dumper.export_json(reviews, str(output_path))
            print(f"  저장됨: {output_path} ({len(reviews)}개 게임)")
        else:
            print(f"  경고: {config['name']} 리뷰를 가져오지 못했습니다.")
    print("\n" + "=" * 60)
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
    if info.get("followers") is not None:
        print(f"팔로워: {info.get('followers', 0):,}명")
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
