#!/usr/bin/env python3
"""
Steam Curator Reviews Dumper
범용 Steam 큐레이터 리뷰 덤프 도구

사용법:
    python steam_curator_dump.py <curator_id> [options]
    python steam_curator_dump.py 42788178
    python steam_curator_dump.py 42788178 -o my_reviews.json
    python steam_curator_dump.py 42788178 --format csv
    python steam_curator_dump.py https://store.steampowered.com/curator/42788178/

    # 퀘이사플레이 큐레이터 덤프 (GitHub Actions용)
    python steam_curator_dump.py --quasarplay
"""

import argparse
import csv
import json
import os
import re
import sys
import time
from datetime import datetime
from pathlib import Path
from typing import Optional

try:
    import requests
    from bs4 import BeautifulSoup
except ImportError:
    print("필수 패키지가 설치되지 않았습니다.")
    print("다음 명령어로 설치하세요:")
    print("  pip install requests beautifulsoup4")
    sys.exit(1)

# 스크립트 위치 기준 data 폴더 경로
SCRIPT_DIR = Path(__file__).parent
DATA_DIR = SCRIPT_DIR.parent / "data"

# 퀘이사플레이 큐레이터 설정
QUASARPLAY_CURATORS = {
    "quasarplay": {
        "id": 42788178,
        "name": "퀘이사플레이",
        "output": "quasarplay.json"
    },
    "quasarzone": {
        "id": 30894603,
        "name": "퀘이사존",
        "output": "quasarzone.json"
    }
}


class SteamCuratorDumper:
    """Steam 큐레이터 리뷰 덤프 클래스"""

    BASE_URL = "https://store.steampowered.com/curator"
    BATCH_SIZE = 50
    DELAY = 0.3  # API 요청 간 딜레이 (초)

    def __init__(self, curator_id: int, verbose: bool = True):
        self.curator_id = curator_id
        self.verbose = verbose
        self.session = requests.Session()
        self.session.headers.update({
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            "Accept-Language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7"
        })
        self.curator_name = None
        self.total_count = 0

    def log(self, message: str):
        """로그 출력"""
        if self.verbose:
            print(message)

    def get_curator_info(self) -> dict:
        """큐레이터 기본 정보 가져오기"""
        url = f"{self.BASE_URL}/{self.curator_id}/"
        try:
            response = self.session.get(url)
            soup = BeautifulSoup(response.text, 'html.parser')

            # 큐레이터 이름 추출
            name_elem = soup.find('h1', class_='curator_name') or soup.find('h1')
            if name_elem:
                self.curator_name = name_elem.get_text(strip=True)

            # 팔로워 수 추출
            follower_elem = soup.find(class_=re.compile(r'follower|follow_count'))
            followers = 0
            if follower_elem:
                match = re.search(r'[\d,]+', follower_elem.get_text())
                if match:
                    followers = int(match.group().replace(',', ''))

            return {
                "curator_id": self.curator_id,
                "curator_name": self.curator_name,
                "curator_url": url,
                "followers": followers
            }
        except Exception as e:
            self.log(f"큐레이터 정보 가져오기 실패: {e}")
            return {"curator_id": self.curator_id}

    def get_total_count(self) -> int:
        """전체 리뷰 수 확인"""
        url = f"{self.BASE_URL}/{self.curator_id}/ajaxgetcuratorrecommendations/"
        params = {"start": 0, "count": 1}

        try:
            response = self.session.get(url, params=params)
            data = response.json()
            self.total_count = data.get("total_count", 0)
            return self.total_count
        except Exception as e:
            self.log(f"전체 리뷰 수 확인 실패: {e}")
            return 0

    def fetch_reviews(self, progress_callback=None) -> list:
        """모든 리뷰 가져오기"""
        all_reviews = []
        start = 0

        # 전체 개수 확인
        total = self.get_total_count()
        if total == 0:
            self.log("리뷰를 찾을 수 없습니다. 큐레이터 ID를 확인하세요.")
            return []

        self.log(f"총 {total}개의 리뷰를 가져옵니다...")

        url = f"{self.BASE_URL}/{self.curator_id}/ajaxgetcuratorrecommendations/"

        while start < total:
            params = {"start": start, "count": self.BATCH_SIZE}

            try:
                response = self.session.get(url, params=params)
                data = response.json()

                if not data.get("success"):
                    self.log(f"API 요청 실패: start={start}")
                    break

                html = data.get("results_html", "")
                if not html:
                    break

                # HTML 파싱
                reviews = self._parse_reviews_html(html)
                all_reviews.extend(reviews)

                fetched = len(reviews)
                start += self.BATCH_SIZE

                # 진행 상황
                progress = min(start, total)
                self.log(f"진행: {progress}/{total} ({len(all_reviews)} 게임 수집됨)")

                if progress_callback:
                    progress_callback(progress, total)

                if fetched < self.BATCH_SIZE:
                    break

                time.sleep(self.DELAY)

            except Exception as e:
                self.log(f"오류 발생 (start={start}): {e}")
                start += self.BATCH_SIZE
                continue

        # 중복 제거
        unique_reviews = self._remove_duplicates(all_reviews)
        self.log(f"\n완료! {len(unique_reviews)}개의 고유 게임 수집됨")

        return unique_reviews

    def _parse_reviews_html(self, html: str) -> list:
        """HTML에서 리뷰 데이터 파싱"""
        reviews = []
        soup = BeautifulSoup(html, 'html.parser')

        # 리뷰 컨테이너 찾기
        recommendations = soup.find_all("div", class_="recommendation")
        if not recommendations:
            recommendations = soup.find_all("div", class_=re.compile(r"curator.*recommendation"))

        for rec in recommendations:
            game_data = {}

            # 게임 링크 및 appid 추출
            link = rec.find("a", href=re.compile(r"/app/\d+"))
            if link:
                href = link.get("href", "")
                game_data["url"] = href.split("?")[0]
                app_match = re.search(r"/app/(\d+)", href)
                if app_match:
                    game_data["appid"] = app_match.group(1)
                    # 큐레이터 평가 페이지 URL
                    game_data["curator_url"] = f"https://store.steampowered.com/app/{game_data['appid']}/?curator_clanid={self.curator_id}"

            # 리뷰 내용 추출
            desc_elem = rec.find(class_=re.compile(r"desc|blurb|recommendation_desc"))
            if desc_elem:
                game_data["review"] = desc_elem.get_text(strip=True)
            else:
                game_data["review"] = ""

            # 추천 타입
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
        """중복 제거"""
        seen = set()
        unique = []
        for review in reviews:
            appid = review.get("appid")
            if appid and appid not in seen:
                seen.add(appid)
                unique.append(review)
        return unique

    def export_json(self, reviews: list, output_file: str):
        """JSON 파일로 내보내기"""
        data = {
            "curator_id": self.curator_id,
            "curator_name": self.curator_name or f"Curator #{self.curator_id}",
            "curator_url": f"{self.BASE_URL}/{self.curator_id}/",
            "total_games": len(reviews),
            "exported_at": datetime.now().isoformat(),
            "games": reviews
        }

        with open(output_file, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)

        self.log(f"JSON 파일 저장됨: {output_file}")

    def export_csv(self, reviews: list, output_file: str):
        """CSV 파일로 내보내기"""
        with open(output_file, "w", encoding="utf-8-sig", newline="") as f:
            writer = csv.DictWriter(f, fieldnames=["appid", "url", "curator_url", "review", "type"])
            writer.writeheader()
            writer.writerows(reviews)

        self.log(f"CSV 파일 저장됨: {output_file}")

    def export_txt(self, reviews: list, output_file: str):
        """텍스트 파일로 내보내기 (게임 링크만)"""
        with open(output_file, "w", encoding="utf-8") as f:
            for review in reviews:
                f.write(f"{review.get('url', '')}\n")

        self.log(f"TXT 파일 저장됨: {output_file}")

    def export_appids(self, reviews: list, output_file: str):
        """AppID 목록만 내보내기"""
        with open(output_file, "w", encoding="utf-8") as f:
            for review in reviews:
                f.write(f"{review.get('appid', '')}\n")

        self.log(f"AppID 파일 저장됨: {output_file}")


def extract_curator_id(input_str: str) -> Optional[int]:
    """URL 또는 문자열에서 큐레이터 ID 추출"""
    # URL에서 추출
    match = re.search(r"curator/(\d+)", input_str)
    if match:
        return int(match.group(1))

    # 숫자만 있는 경우
    if input_str.isdigit():
        return int(input_str)

    return None


def run_quasarplay_dump():
    """퀘이사플레이 큐레이터 두 개 모두 덤프 (GitHub Actions용)"""
    DATA_DIR.mkdir(parents=True, exist_ok=True)

    print("=" * 60)
    print("퀘이사플레이 큐레이터 덤프")
    print("=" * 60)

    for key, config in QUASARPLAY_CURATORS.items():
        print(f"\n[{config['name']}] 덤프 시작...")
        print(f"  큐레이터 ID: {config['id']}")

        dumper = SteamCuratorDumper(config['id'], verbose=True)
        info = dumper.get_curator_info()

        if info.get("followers"):
            print(f"  팔로워: {info['followers']:,}명")

        reviews = dumper.fetch_reviews()

        if reviews:
            output_path = DATA_DIR / config['output']
            dumper.export_json(reviews, str(output_path))
            print(f"  저장됨: {output_path} ({len(reviews)}개 게임)")
        else:
            print(f"  경고: {config['name']} 리뷰를 가져오지 못했습니다.")

    print("\n" + "=" * 60)
    print("퀘이사플레이 큐레이터 덤프 완료!")
    print("=" * 60)


def main():
    parser = argparse.ArgumentParser(
        description="Steam 큐레이터 리뷰 덤프 도구",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
예시:
  python steam_curator_dump.py 42788178
  python steam_curator_dump.py 42788178 -o reviews.json
  python steam_curator_dump.py 42788178 --format csv
  python steam_curator_dump.py "https://store.steampowered.com/curator/42788178/"
  python steam_curator_dump.py 42788178 --format appids -o appids.txt

  # 퀘이사플레이 큐레이터 덤프 (GitHub Actions용)
  python steam_curator_dump.py --quasarplay
        """
    )

    parser.add_argument(
        "curator",
        nargs="?",
        help="큐레이터 ID 또는 URL (예: 42788178 또는 https://store.steampowered.com/curator/42788178/)"
    )

    parser.add_argument(
        "-o", "--output",
        help="출력 파일명 (기본값: curator_<id>_reviews.<format>)"
    )

    parser.add_argument(
        "-f", "--format",
        choices=["json", "csv", "txt", "appids"],
        default="json",
        help="출력 형식 (기본값: json)"
    )

    parser.add_argument(
        "-q", "--quiet",
        action="store_true",
        help="진행 상황 출력 안함"
    )

    parser.add_argument(
        "--quasarplay",
        action="store_true",
        help="퀘이사플레이 큐레이터 덤프 (quasarplay.json, quasarzone.json을 data 폴더에 저장)"
    )

    args = parser.parse_args()

    # --quasarplay 옵션 처리
    if args.quasarplay:
        run_quasarplay_dump()
        return

    # 일반 모드: curator 인자 필수
    if not args.curator:
        parser.error("curator 인자가 필요합니다. 또는 --quasarplay 옵션을 사용하세요.")

    # 큐레이터 ID 추출
    curator_id = extract_curator_id(args.curator)
    if not curator_id:
        print(f"오류: 유효하지 않은 큐레이터 ID 또는 URL: {args.curator}")
        sys.exit(1)

    # 출력 파일명 결정
    if args.output:
        output_file = args.output
    else:
        ext = "txt" if args.format in ["txt", "appids"] else args.format
        output_file = f"curator_{curator_id}_reviews.{ext}"

    # 덤프 실행
    print("=" * 60)
    print("Steam 큐레이터 리뷰 덤프 도구")
    print("=" * 60)
    print(f"큐레이터 ID: {curator_id}")
    print(f"출력 형식: {args.format}")
    print(f"출력 파일: {output_file}")
    print()

    dumper = SteamCuratorDumper(curator_id, verbose=not args.quiet)

    # 큐레이터 정보 가져오기
    info = dumper.get_curator_info()
    if info.get("curator_name"):
        print(f"큐레이터: {info['curator_name']}")
    if info.get("followers"):
        print(f"팔로워: {info['followers']:,}명")
    print()

    # 리뷰 가져오기
    reviews = dumper.fetch_reviews()

    if not reviews:
        print("리뷰를 가져오지 못했습니다.")
        sys.exit(1)

    # 내보내기
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
