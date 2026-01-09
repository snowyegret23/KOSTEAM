# Steam 한국어 패치 정보 (Steam_KRLocInfo)

Steam 스토어 페이지에서 한국어 패치/한글화 정보를 자동으로 표시해주는 Chrome 확장 프로그램 + 데이터 수집 시스템

## 기능

- Steam 스토어 게임 페이지 접속 시 한국어 지원 상태 자동 표시
- 공식 한국어 / 유저 한글패치 / DirectG / STOVE 구분
- 패치 다운로드 링크 및 설명 제공
- 4개 소스에서 데이터 자동 수집 (SteamApp, QuasarPlay, DirectG, STOVE)

## Chrome 확장 프로그램 설치

1. 저장소 클론 또는 다운로드
2. `chrome://extensions` 접속
3. 개발자 모드 활성화
4. "압축해제된 확장 프로그램을 로드합니다" 클릭
5. `extension` 폴더 선택

## 개발 환경

```bash
# 요구사항: Node.js 18+

# 의존성 설치
npm install
```

## 스크래퍼 실행

```bash
# 개별 실행
npm run scrape:steamapp
npm run scrape:quasarplay
npm run scrape:directg
npm run scrape:stove

# 전체 스크랩 + 병합
npm run build

# 전체 스크랩 + 링크 리다이렉트 해소 + 병합
npm run build:full

# 병합만
npm run merge

# Steam 링크 리다이렉트 해소
npm run resolve-links

# 기존 데이터 Steam 링크 검증
npm run resolve-links:verify
```

## 데이터 소스

| 소스 | 설명 |
|------|------|
| SteamApp | steamapp.net |
| QuasarPlay | quasarplay.com |
| DirectG | directg.net |
| STOVE | store.onstove.com |

## 데이터 파일

| 파일 | 설명 |
|------|------|
| `data/{source}.json` | 각 소스별 원본 데이터 |
| `data/merged.json` | 전체 병합 데이터 (Steam 링크 유/무 구분) |
| `data/lookup.json` | AppID 기반 조회용 (확장 프로그램에서 사용) |
| `data/alias.json` | Steam AppID 리다이렉트 매핑 (구ID → 신ID) |
| `data/version.json` | 데이터 버전 정보 |

## GitHub Actions 자동화

**스케줄:** 매주 화/금/일 06:00 KST (cron: `0 21 * * 1,4,6` UTC)

**수동 실행:** Actions 탭 → "Scrape Korean Patch Info" → Run workflow → 스크래퍼 선택

### 필요한 Secrets

| Secret | 용도 |
|--------|------|
| `TWO_CAPTCHA_API_KEY` | 2Captcha API Key |
| `QUASARPLAY_COOKIE` | QuasarPlay 로그인 세션 (선택) |
| `QUASARPLAY_PROXY` | 프록시 URL (선택) |

## 패치 타입 분류 로직

1. Steam 공식 한국어 지원 → `공식` (녹색)
2. DirectG에 존재 → `다이렉트 게임즈` (파랑)
3. STOVE에 존재 → `스토브` (주황)
4. DB에 official 타입 → `공식지원 추정` (녹색)
5. DB에 user 타입 → `유저패치` (보라)
6. 정보 없음 → `한국어 없음` (빨강)

## 라이선스

MIT License
