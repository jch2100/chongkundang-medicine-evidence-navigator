// 공공데이터포털 인증키 동작 확인 스크립트
// 사용법: node scripts/check-api-key.mjs
//
// .env.local 에 키를 저장한다. 인증키는 API별이 아니라 계정별이므로 한 줄이면 된다.
//   DATA_GO_KR_KEY=...
// DATA_GO_KR_KEY_PERMISSION 처럼 접미사가 붙은 이름도 그대로 읽는다.
// 값이 서로 다르면 경고만 하고 첫 번째 값을 쓴다.

import fs from 'node:fs';
import path from 'node:path';

// 엔드포인트 버전 접미사는 식약처 개정 시 올라간다.
// 404 / NO_OPENAPI_SERVICE_ERROR 가 나면 API 상세 페이지의
// '활용신청 상세기능정보' 표에서 요청주소를 복사해 교체한다.
const ENDPOINTS = [
  { label: '의약품 제품 허가정보', url: 'https://apis.data.go.kr/1471000/DrugPrdtPrmsnInfoService08/getDrugPrdtPrmsnInq08' },
  { label: 'DUR 품목정보(병용금기)', url: 'https://apis.data.go.kr/1471000/DURPrdlstInfoService03/getUsjntTabooInfoList03' },
];

// worktree 안에서 실행해도 본 저장소 루트의 .env.local 을 찾도록 상위로 거슬러 올라간다.
function findEnvFile() {
  let dir = process.cwd();
  for (let depth = 0; depth < 6; depth += 1) {
    const candidate = path.join(dir, '.env.local');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function readKey() {
  const envPath = findEnvFile();
  if (!envPath) {
    console.error('.env.local 없음 — 프로젝트 루트에 파일을 만들고 DATA_GO_KR_KEY=... 한 줄을 넣으세요.');
    console.error(`찾은 범위: ${process.cwd()} 및 상위 폴더`);
    process.exit(1);
  }
  console.log(`키 파일: ${envPath}`);
  const found = [];
  for (const row of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const line = row.trim();
    if (!line || line.startsWith('#') || !line.startsWith('DATA_GO_KR_KEY')) continue;
    const separator = line.indexOf('=');
    if (separator < 0) continue;
    const value = line.slice(separator + 1).trim().replace(/^["']|["']$/g, '');
    if (value) found.push({ name: line.slice(0, separator).trim(), value });
  }
  if (!found.length) {
    console.error('.env.local 에 DATA_GO_KR_KEY 로 시작하는 항목이 없습니다.');
    process.exit(1);
  }
  const distinct = new Set(found.map((entry) => entry.value));
  if (distinct.size > 1) {
    console.warn(`주의: 키 값이 ${distinct.size}종류입니다. 첫 항목(${found[0].name})을 사용합니다.`);
  }
  return normalizeKey(found[0].value);
}

// 포털은 Encoding 키(%2B 등이 이미 인코딩된 형태)와 Decoding 키를 함께 보여준다.
// URLSearchParams 는 값을 다시 인코딩하므로 Encoding 키를 그대로 넣으면 %가 %25 로 깨진다.
// 어느 쪽을 붙여넣어도 동작하도록 Decoding 형태로 되돌린다.
function normalizeKey(value) {
  if (!value.includes('%')) return value;
  try {
    const decoded = decodeURIComponent(value);
    console.log('Encoding 키로 판단해 Decoding 형태로 변환했습니다.');
    return decoded;
  } catch {
    return value;
  }
}

async function check(endpoint, key) {
  const url = new URL(endpoint.url);
  url.searchParams.set('serviceKey', key);
  url.searchParams.set('pageNo', '1');
  url.searchParams.set('numOfRows', '3');
  url.searchParams.set('type', 'json');

  let response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(20000) });
  } catch (error) {
    return { ok: false, detail: `요청 실패 · ${error.message}` };
  }

  const text = await response.text();
  if (response.status === 404) return { ok: false, detail: 'HTTP 404 · 엔드포인트 버전이 바뀌었습니다. 포털의 요청주소를 확인하세요.' };

  // 인증 오류 봉투는 XML 또는 JSON 으로 오고, HTTP 상태는 400/403 인 경우가 많다.
  const errMsg = text.match(/["<]errMsg["]?\s*[:>]\s*"?([^"<,}]+)/)?.[1]?.trim();
  const authMsg = text.match(/["<]returnAuthMsg["]?\s*[:>]\s*"?([^"<,}]+)/)?.[1]?.trim();
  if (errMsg || authMsg) return { ok: false, detail: [errMsg, authMsg].filter(Boolean).join(' · ') };

  if (!response.ok) return { ok: false, detail: `HTTP ${response.status} · ${text.slice(0, 200)}` };

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, detail: `JSON 파싱 실패 · 응답 앞부분: ${text.slice(0, 200)}` };
  }

  const resultCode = data?.header?.resultCode ?? data?.response?.header?.resultCode;
  const resultMsg = data?.header?.resultMsg ?? data?.response?.header?.resultMsg;
  if (resultCode && resultCode !== '00') return { ok: false, detail: `${resultMsg} (${resultCode})` };

  const totalCount = data?.body?.totalCount ?? data?.response?.body?.totalCount ?? '확인불가';
  return { ok: true, detail: `totalCount=${totalCount}` };
}

const key = readKey();
let failed = 0;
for (const endpoint of ENDPOINTS) {
  const result = await check(endpoint, key);
  if (result.ok) {
    console.log(`[OK]   ${endpoint.label} · ${result.detail}`);
  } else {
    failed += 1;
    console.error(`[FAIL] ${endpoint.label} · ${result.detail}`);
  }
}

if (failed) {
  console.error('\n인증키 확인 실패. docs/OPENAPI_KEY_SETUP.md 의 "오류가 날 때" 표를 확인하세요.');
  console.error('가장 흔한 원인: 신청 직후 키 반영 전(최대 1시간), 또는 Decoding 대신 Encoding 키를 써야 하는 경우.');
  process.exit(1);
}
console.log('\n인증키 정상입니다.');
