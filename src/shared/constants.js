// Remote data URLs
export const REMOTE_BASE_URL = 'https://raw.githubusercontent.com/snowyegret23/KOSTEAM/refs/heads/main/data';
export const VERSION_URL = `${REMOTE_BASE_URL}/version.json`;
export const DATA_URL = `${REMOTE_BASE_URL}/lookup.json`;
export const ALIAS_URL = `${REMOTE_BASE_URL}/alias.json`;

// Storage keys
export const CACHE_KEY = 'kr_patch_data';
export const CACHE_ALIAS_KEY = 'kr_patch_alias';
export const CACHE_VERSION_KEY = 'kr_patch_version';
export const LAST_UPDATE_CHECK_KEY = 'kr_last_update_check';

// Time constants
export const UPDATE_INTERVAL_MINUTES = 30;
export const MS_PER_SECOND = 1000;
export const MS_PER_MINUTE = 60000;
export const MS_PER_HOUR = 3600000;
export const MS_PER_DAY = 86400000;
export const MS_PER_WEEK = 604800000;

// Default settings
export const DEFAULT_SETTINGS = {
    source_steamapp: true,
    source_quasarplay: true,
    source_directg: true,
    source_stove: true,
    bypass_language_filter: true,
    cart_feature_enabled: false,
    disable_patch_info: false
};

// Source labels
export const SOURCE_LABELS = {
    stove: '스토브',
    quasarplay: '퀘이사존 큐레이터',
    directg: '다이렉트 게임즈',
    steamapp: '스팀앱'
};

// Patch type configurations
export const PATCH_TYPES = {
    OFFICIAL_STEAM: { label: '공식 한국어', cssClass: 'official-steam', color: '#4c9a2a' },
    OFFICIAL_WITH_USER: { label: '공식(추가정보 존재)', cssClass: 'official-with-user', color: '#4c9a2a' },
    OFFICIAL_DIRECTG: { label: '다이렉트 게임즈', cssClass: 'official-directg', color: '#0C7CED' },
    OFFICIAL_STOVE: { label: '스토브', cssClass: 'official-stove', color: '#FF8126' },
    OFFICIAL_ESTIMATED: { label: '공식지원 추정', cssClass: 'official', color: '#38C198' },
    USER_PATCH: { label: '유저패치', cssClass: 'user', color: '#B921FF' },
    NONE: { label: '한국어 없음', cssClass: 'none', color: '#e74c3c' }
};

// Message types
export const MSG_GET_PATCH_INFO = 'GET_PATCH_INFO';
export const MSG_REFRESH_DATA = 'REFRESH_DATA';
export const MSG_CHECK_UPDATE_STATUS = 'CHECK_UPDATE_STATUS';
export const MSG_RESTORE_CART = 'RESTORE_CART';

// Korean language labels for detection
export const KOREAN_LABELS = ['Korean', '한국어'];

// UI text strings
export const UI_STRINGS = {
    LINK_PREFIX: '링크',
    OFFICIAL_ESTIMATED_TEXT: '한국어를 공식 지원하는 것으로 추정되는 게임입니다.',
    OFFICIAL_ESTIMATED_SUBTEXT: '(패치 정보 사이트에 한국어 번역이 존재한다고 보고된 게임)',
    OFFICIAL_SUPPORT_TEXT: '한국어를 공식 지원하는 게임입니다.',
    NO_PATCH_INFO_TEXT: '현재 데이터베이스에 등록된 한국어 패치 정보가 없습니다.',
    NO_LINK_TEXT: '해당 게임의 패치 정보 사이트로 연결되는 링크를 찾을 수 없습니다.'
};

// Retry configuration for search bypass
export const SEARCH_BYPASS_MAX_ATTEMPTS = 50;
export const SEARCH_BYPASS_RETRY_DELAY_MS = 100;

// Content script timing constants
export const CURATOR_SCROLL_TIMEOUT_MS = 5000;
export const LANGUAGE_TABLE_WATCH_TIMEOUT_MS = 10000;
