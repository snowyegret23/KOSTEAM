# Steam 한국어 패치 정보 (Steam_KRLocInfo)

Steam 스토어 페이지에서 한국어 패치 정보를 자동으로 표시하는 Chrome 확장 프로그램입니다.

## 📋 기능

- Steam 스토어 페이지에서 한국어 패치 존재 여부 자동 표시
- 공식 한국어 / 유저 한글패치 구분
- 다양한 패치 사이트 링크 제공
- 4개 데이터 소스에서 정보 수집

## 📂 데이터 소스

| 소스 | URL | 특징 |
|------|-----|------|
| SteamApp | steamapp.net | 가장 포괄적인 한글패치 DB |
| QuasarPlay | quasarplay.com | 유저 커뮤니티 기반 |
| DirectG | directg.net | 한국어 전용 판매처 |
| STOVE | store.onstove.com | 스토브 한글화 게임 |

## 🛠 설치 방법

### Chrome 확장 프로그램

1. 이 저장소를 클론하거나 다운로드합니다
2. Chrome에서 `chrome://extensions` 접속
3. "개발자 모드" 활성화
4. "압축해제된 확장 프로그램을 로드합니다" 클릭
5. `extension` 폴더 선택

### 아이콘 설정

`extension/icons` 폴더에 다음 파일들을 추가해야 합니다:
- `icon16.png` (16x16)
- `icon48.png` (48x48)  
- `icon128.png` (128x128)

## 🔄 데이터 업데이트

GitHub Actions가 **월/목/토 오전 6시 (KST)**에 자동으로 데이터를 수집합니다.

### 수동 실행

```bash
# 의존성 설치
npm install

# 개별 스크래퍼 실행
npm run scrape:steamapp
npm run scrape:quasarplay
npm run scrape:directg
npm run scrape:stove

# 전체 실행 및 병합
npm run build
```

## 📁 프로젝트 구조

```
Steam_KRLocInfo/
├── .github/workflows/     # GitHub Actions
├── scrapers/              # 웹 스크래퍼
│   ├── steamapp.js
│   ├── quasarplay.js
│   ├── directg.js
│   └── stove.js
├── scripts/               # 유틸리티 스크립트
│   └── merge.js
├── data/                  # 수집된 데이터
│   ├── steamapp.json
│   ├── quasarplay.json
│   ├── directg.json
│   ├── stove.json
│   ├── merged.json
│   └── lookup.json
├── extension/             # Chrome 확장 프로그램
│   ├── manifest.json
│   ├── background.js
│   ├── content.js
│   ├── popup.html
│   ├── popup.js
│   ├── styles.css
│   └── icons/
└── package.json
```

## ⚠️ 주의사항

- DirectG와 STOVE 데이터는 Steam 링크를 수동으로 입력해야 합니다
- `extension/background.js`의 `DATA_URL`을 본인의 GitHub 저장소 URL로 변경하세요

## 📝 설정 변경

### GitHub 저장소 URL 변경

`extension/background.js` 파일에서:
```javascript
const DATA_URL = 'https://raw.githubusercontent.com/YOUR_USERNAME/Steam_KRLocInfo/main/data/lookup.json';
```

`extension/popup.html` 및 `extension/popup.js`에서도 GitHub URL을 변경하세요.

## 🎨 색상 코드

| 소스 | 색상 |
|------|------|
| SteamApp | #66c0f4 (Steam Blue) |
| QuasarPlay | #9b59b6 (Purple) |
| DirectG | #e74c3c (Red) |
| STOVE | #ff6b35 (Orange) |

## 📄 라이선스

MIT License
