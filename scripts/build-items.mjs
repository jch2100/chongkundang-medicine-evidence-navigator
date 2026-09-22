// 심평원 약가마스터(허가·유통) + 약제급여목록표(급여)를 조인해 코드 백본을 만든다.
// 사용법: node scripts/build-items.mjs [브랜드명 ...] [--write]
//   인자 없으면 CORE_BRANDS(핵심 15개)를 처리한다.
//
// 입력: data/source/건강보험심사평가원_약가마스터_의약품표준코드_*.csv  (CP949)
//       data/source/건강보험심사평가원_약가마스터_의약품주성분_*.csv    (CP949)
//       data/source/약제급여목록및급여상한금액표_*.xlsx                 (zip + OOXML, 외부 의존성 없이 직접 파싱)
// 출력: 표준출력 리포트 + --write 지정 시
//       data/public/items.json   (허가 층 — DATA_DICTIONARY §2)
//       data/public/billing.json (급여 층 — DATA_DICTIONARY §3)
//       qa/runs/latest.json      (생성 결과 기록)
//
// 절대 원칙: 허가 ≠ 급여 ≠ 청구. 원본에 없는 값은 만들지 않고 null 로 둔다.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

// ---------------------------------------------------------------- 브랜드 정의

// products.json / additional-products.json 의 id 와 1:1 로 맞춘다.
const CORE_BRANDS = [
  { brandId: 'prolia', name: '프롤리아' },
  { brandId: 'atozet', name: '아토젯' },
  { brandId: 'gliatilin', name: '글리아티린' },
  { brandId: 'pexuclue', name: '펙수클루' },
  { brandId: 'januvia', name: '자누비아' },
  { brandId: 'godex', name: '고덱스' },
  { brandId: 'dilatrend', name: '딜라트렌' },
  { brandId: 'telminuvo', name: '텔미누보' },
  { brandId: 'tacrobell', name: '타크로벨' },
  { brandId: 'lipilou', name: '리피로우' },
  { brandId: 'qsymia', name: '큐시미아' },
  { brandId: 'cypol', name: '사이폴' },
  { brandId: 'evenity', name: '이베니티' },
  { brandId: 'telmitren', name: '텔미트렌' },
  { brandId: 'myrept', name: '마이렙트' },
];

// DATA_DICTIONARY §4 — 브랜드명이 포함관계인 품목은 별도 브랜드로 분리한다.
// products.json 에 대응 id 가 없으므로 brandId 는 null 로 두고 brandNameRaw 로 남긴다.
const SPLIT_BRANDS = [
  { brandId: 'lipilouzet', name: '리피로우젯', splitFrom: '리피로우' },
  { brandId: 'telminuvo-plus', name: '텔미누보플러스', splitFrom: '텔미누보' },
  // 텔미누보에스는 3품목 전부 2018-10-16 허가취소. 판매 중인 제품이 아니므로 브랜드로 만들지 않는다.
  { brandId: null, name: '텔미누보에스', splitFrom: '텔미누보' },
  // 텔미트렌도 텔미누보와 같은 포함관계 구조를 가진다.
  { brandId: 'telmitren-s', name: '텔미트렌에스', splitFrom: '텔미트렌' },
  { brandId: 'telmitren-plus', name: '텔미트렌플러스', splitFrom: '텔미트렌' },
];

// DATA_DICTIONARY §4 — 업체명 검증. 브랜드 문자열만으로는 타사 동명 품목이 섞인다.
// requireCompany: 업체명에 이 문자열이 없으면 해당 브랜드에서 제외한다.
const COMPANY_RULES = {
  // 글리아티린(대웅제약) ≠ 종근당글리아티린
  글리아티린: { requireCompany: '종근당' },
  // 사이폴-엔연질캡슐50mg((주)다산제약)은 동명 타사 품목이므로 제외한다.
  사이폴: { requireCompany: '종근당' },
};

// ---------------------------------------------------------------- 파일 탐색

// data/source 는 worktree 가 아니라 본 저장소에 있을 수 있으므로 상위로 거슬러 찾는다.
function findDir(relative) {
  let dir = process.cwd();
  for (let depth = 0; depth < 6; depth += 1) {
    const candidate = path.join(dir, relative);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

// ---------------------------------------------------------------- CSV (CP949)

function readCsv(filePath) {
  const buffer = fs.readFileSync(filePath);
  const text = new TextDecoder('euc-kr').decode(buffer);
  const rows = [];
  let field = '';
  let record = [];
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 1; } else { quoted = false; }
      } else field += char;
      continue;
    }
    if (char === '"') { quoted = true; continue; }
    if (char === ',') { record.push(field); field = ''; continue; }
    if (char === '\n') {
      record.push(field.replace(/\r$/, ''));
      rows.push(record);
      record = []; field = '';
      continue;
    }
    field += char;
  }
  if (field || record.length) { record.push(field.replace(/\r$/, '')); rows.push(record); }
  const header = rows.shift().map((name) => name.trim());
  return rows.filter((row) => row.length >= header.length - 1).map((row) => {
    const entry = {};
    header.forEach((name, index) => { entry[name] = (row[index] ?? '').trim(); });
    return entry;
  });
}

// ---------------------------------------------------------------- XLSX (zip + OOXML)
// openpyxl / SheetJS 같은 외부 의존성 없이 순수 Node 로 읽는다.

function readZip(file) {
  const buf = fs.readFileSync(file);
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 22 - 65536; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error(`zip EOCD 미발견: ${file}`);
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let n = 0; n < count; n += 1) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error('zip central directory 손상');
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    entries.set(buf.toString('utf8', off + 46, off + 46 + nameLen), { method, compSize, localOff });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return { buf, entries };
}

function unzipEntry(zip, name) {
  const entry = zip.entries.get(name);
  if (!entry) throw new Error(`zip 항목 없음: ${name}`);
  const b = zip.buf;
  const o = entry.localOff;
  if (b.readUInt32LE(o) !== 0x04034b50) throw new Error(`zip local header 손상: ${name}`);
  const start = o + 30 + b.readUInt16LE(o + 26) + b.readUInt16LE(o + 28);
  const raw = b.subarray(start, start + entry.compSize);
  return entry.method === 0 ? raw : zlib.inflateRawSync(raw);
}

function decodeXmlEntities(text) {
  return text.replace(/&(amp|lt|gt|quot|apos|#x?[0-9A-Fa-f]+);/g, (match, body) => {
    if (body === 'amp') return '&';
    if (body === 'lt') return '<';
    if (body === 'gt') return '>';
    if (body === 'quot') return '"';
    if (body === 'apos') return "'";
    if (body[0] === '#') {
      const hex = body[1] === 'x' || body[1] === 'X';
      return String.fromCodePoint(hex ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10));
    }
    return match;
  });
}

function parseSharedStrings(xml) {
  const out = [];
  const siRe = /<si>([\s\S]*?)<\/si>/g;
  let si;
  while ((si = siRe.exec(xml))) {
    let text = '';
    const tRe = /<t[^>]*>([\s\S]*?)<\/t>|<t[^>]*\/>/g;
    let t;
    while ((t = tRe.exec(si[1]))) text += t[1] === undefined ? '' : t[1];
    out.push(decodeXmlEntities(text));
  }
  return out;
}

function columnIndex(ref) {
  let n = 0;
  for (let i = 0; i < ref.length; i += 1) {
    const code = ref.charCodeAt(i);
    if (code >= 65 && code <= 90) n = n * 26 + (code - 64); else break;
  }
  return n - 1;
}

function parseSheet(xml, sharedStrings, width) {
  const rows = [];
  const rowRe = /<row[^>]*>([\s\S]*?)<\/row>/g;
  let row;
  while ((row = rowRe.exec(xml))) {
    const cells = new Array(width).fill('');
    const cellRe = /<c r="([A-Z]+\d+)"([^>]*)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let cell;
    while ((cell = cellRe.exec(row[1]))) {
      const index = columnIndex(cell[1]);
      if (index < 0 || index >= width) continue;
      const attrs = cell[2] || '';
      const body = cell[3] || '';
      const type = /t="([^"]+)"/.exec(attrs)?.[1] ?? 'n';
      let value = '';
      if (type === 's') {
        const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
        value = v === undefined ? '' : (sharedStrings[Number(v)] ?? '');
      } else if (type === 'inlineStr') {
        const t = /<t[^>]*>([\s\S]*?)<\/t>/.exec(body)?.[1];
        value = t === undefined ? '' : decodeXmlEntities(t);
      } else {
        const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
        value = v === undefined ? '' : decodeXmlEntities(v);
      }
      cells[index] = value.trim();
    }
    rows.push(cells);
  }
  return rows;
}

// 보험코드는 9자리다. 약가마스터 '제품코드(개정후)'는 선행 0 이 떨어진 8자리로 들어오는 행이 있다.
// (예: 프롤리아 052300041 → 52300041) 조인 전에 반드시 9자리로 맞춘다.
function normalizeEdiCode(raw) {
  const value = (raw ?? '').trim();
  if (!value) return null;
  if (/^\d{1,9}$/.test(value)) return value.padStart(9, '0');
  return value;
}

// 약제급여목록표 컬럼(0-based)
const NOTICE = {
  route: 1, classNo: 2, mainIngredientCode: 5, ingredientName: 7,
  productCode: 8, productName: 9, company: 10, spec: 11, unit: 12,
  maxPrice: 13, rxClass: 14, note: 15,
};

function readNotice(filePath) {
  const zip = readZip(filePath);
  const sharedStrings = parseSharedStrings(unzipEntry(zip, 'xl/sharedStrings.xml').toString('utf8'));
  const rows = parseSheet(unzipEntry(zip, 'xl/worksheets/sheet1.xml').toString('utf8'), sharedStrings, 16);
  const data = rows.slice(1).filter((cells) => cells[NOTICE.productCode]);
  for (const cells of data) cells[NOTICE.productCode] = normalizeEdiCode(cells[NOTICE.productCode]);
  return data;
}

// ---------------------------------------------------------------- 입력 로드

const sourceDir = findDir(path.join('data', 'source'));
if (!sourceDir) {
  console.error('data/source 폴더를 찾지 못했습니다. 심평원 원본 파일을 data/source/ 에 넣으세요.');
  process.exit(1);
}

function pickSource(pattern, extension) {
  const match = fs.readdirSync(sourceDir)
    .filter((name) => name.includes(pattern) && name.toLowerCase().endsWith(extension))
    .sort().pop();
  if (!match) {
    console.error(`data/source 에 '${pattern}${extension}' 파일이 없습니다.`);
    process.exit(1);
  }
  return path.join(sourceDir, match);
}

const stdFile = pickSource('의약품표준코드', '.csv');
const ingredientFile = pickSource('의약품주성분', '.csv');
const noticeFile = pickSource('약제급여목록', '.xlsx');

const requested = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
const shouldWrite = process.argv.includes('--write');

const baseBrands = requested.length
  ? CORE_BRANDS.filter((brand) => requested.includes(brand.name))
  : CORE_BRANDS;
if (requested.length && baseBrands.length !== requested.length) {
  const unknown = requested.filter((name) => !CORE_BRANDS.some((brand) => brand.name === name));
  console.error(`CORE_BRANDS 에 없는 브랜드: ${unknown.join(', ')}`);
  process.exit(1);
}
const splitBrands = SPLIT_BRANDS.filter((split) => baseBrands.some((brand) => brand.name === split.splitFrom));
// 긴 이름 우선 매칭 — '리피로우젯' 이 '리피로우' 보다 먼저 잡혀야 한다.
const brandMatchers = [...baseBrands, ...splitBrands].sort((a, b) => b.name.length - a.name.length);

console.log(`표준코드 : ${path.basename(stdFile)}`);
console.log(`주성분   : ${path.basename(ingredientFile)}`);
console.log(`급여목록 : ${path.basename(noticeFile)}`);
console.log(`대상 브랜드: ${baseBrands.length}개 (+ 분리 브랜드 ${splitBrands.length}개)\n`);

const ingredientByCode = new Map(readCsv(ingredientFile).map((row) => [row['일반명코드'], row]));
const stdRows = readCsv(stdFile);
const noticeRows = readNotice(noticeFile);
const noticeByCode = new Map();
for (const cells of noticeRows) {
  if (!noticeByCode.has(cells[NOTICE.productCode])) noticeByCode.set(cells[NOTICE.productCode], cells);
}

// ---------------------------------------------------------------- 품목 조립

const warnings = [];
const excludedByCompany = [];

function resolveBrand(itemName) {
  return brandMatchers.find((brand) => itemName.includes(brand.name)) ?? null;
}

const items = new Map();
for (const row of stdRows) {
  const itemName = row['한글상품명'];
  const itemSeq = row['품목기준코드'];
  if (!itemName || !itemSeq) continue;
  const brand = resolveBrand(itemName);
  if (!brand) continue;

  const rule = COMPANY_RULES[brand.name];
  const company = row['업체명'];
  if (rule?.requireCompany && !company.includes(rule.requireCompany)) {
    excludedByCompany.push({ brand: brand.name, itemName, company, itemSeq, rule: `업체명에 '${rule.requireCompany}' 필요` });
    continue;
  }

  const itemKey = `${itemSeq}::${company}`;
  if (!items.has(itemKey)) {
    items.set(itemKey, {
      itemKey,
      itemSeq,
      brandId: brand.brandId,
      brandNameRaw: brand.name,
      itemName,
      company,
      isCkd: company.includes('종근당'),
      strengthLabel: null,
      rxClass: null,
      approvalDate: null,
      cancelDate: null,
      atcCode: null,
      ingredientCode: null,
      ingredientNameEn: null,
      dosageForm: null,
      route: null,
      classNo: null,
      representativeCode: null,
      packages: [],
      _masterEdiCodes: new Set(),
      _names: new Set(),
    });
  }
  const item = items.get(itemKey);
  item._names.add(itemName);
  // 대표행(제품총수량 0)은 약품규격이 '없음'인 경우가 있어 실포장 행 값을 우선한다.
  const spec = row['약품규격'];
  if (!item.strengthLabel && spec && spec !== '없음') item.strengthLabel = spec;
  if (!item.rxClass && row['전문일반구분']) item.rxClass = row['전문일반구분'];
  if (!item.approvalDate && row['품목허가일자']) item.approvalDate = row['품목허가일자'];
  if (!item.cancelDate && row['취소일자']) item.cancelDate = row['취소일자'];
  if (!item.atcCode && row['국제표준코드(ATC코드)']) item.atcCode = row['국제표준코드(ATC코드)'];
  if (!item.representativeCode && row['대표코드']) item.representativeCode = row['대표코드'];
  // 보험코드·일반명코드는 대표행에만 있는 경우가 있다. 품목 단위로 모아 둔 뒤 조인한다.
  if (!item.ingredientCode && row['일반명코드(성분명코드)']) item.ingredientCode = row['일반명코드(성분명코드)'];
  const masterEdi = normalizeEdiCode(row['제품코드(개정후)']);
  if (masterEdi) item._masterEdiCodes.add(masterEdi);
  if (row['표준코드'] && !item.packages.some((pkg) => pkg.kdCode === row['표준코드'])) {
    item.packages.push({
      kdCode: row['표준코드'],
      quantity: Number(row['제품총수량']) || 0,
      dosageForm: row['제형구분'] || null,
      packageType: row['포장형태'] || null,
    });
  }
}

// ---------------------------------------------------------------- 급여 조인

const billing = [];
const usedNoticeCodes = new Set();
const joinFailures = [];
const noticeRowByItemKey = new Map();

for (const item of items.values()) {
  const masterCodes = [...item._masterEdiCodes];
  if (masterCodes.length > 1) {
    warnings.push(`ediCode 다중: ${item.itemKey} → ${masterCodes.join(', ')}`);
  }
  const hit = masterCodes.find((code) => noticeByCode.has(code)) ?? null;
  const notice = hit ? noticeByCode.get(hit) : null;
  if (notice) { usedNoticeCodes.add(hit); noticeRowByItemKey.set(item.itemKey, notice); }

  if (!notice) {
    joinFailures.push({
      itemKey: item.itemKey,
      itemName: item.itemName,
      company: item.company,
      masterEdiCode: masterCodes[0] ?? null,
      cancelDate: item.cancelDate,
      reason: masterCodes.length === 0
        ? '약가마스터에 제품코드(개정후) 없음 — 보험코드 미부여'
        : '급여목록표(2026.9.1.)에 해당 제품코드 없음',
    });
  }

  const maxPriceRaw = notice ? notice[NOTICE.maxPrice] : '';
  const maxPrice = maxPriceRaw === '' ? null : Number(maxPriceRaw);
  if (notice && (maxPrice === null || Number.isNaN(maxPrice))) {
    warnings.push(`상한금액 파싱 실패: ${item.itemKey} → '${maxPriceRaw}'`);
  }

  billing.push({
    itemKey: item.itemKey,
    // 급여목록표에 없으면 약가마스터의 제품코드(개정후)를 그대로 둔다(코드 역검색용).
    // 코드 존재 여부와 급여 여부는 별개다 — 판단은 benefitStatus 로만 한다.
    ediCode: notice ? notice[NOTICE.productCode] : (masterCodes[0] ?? null),
    benefitStatus: notice ? 'listed' : 'not-listed',
    maxPrice: notice ? maxPrice : null,
    priceUnit: notice ? `${notice[NOTICE.spec]}${notice[NOTICE.unit]}` || null : null,
    noticeProductName: notice ? (notice[NOTICE.productName] || null) : null,
    mainIngredientCode: notice ? (notice[NOTICE.mainIngredientCode] || null) : null,
    classNo: notice ? (notice[NOTICE.classNo] || null) : null,
    rxClass: notice ? (notice[NOTICE.rxClass] || null) : null,
  });
}

const billingByKey = new Map(billing.map((entry) => [entry.itemKey, entry]));

// 급여목록표에는 있는데 약가마스터 품목으로 연결되지 않은 행(대상 브랜드 한정)
const noticeOnly = [];
for (const cells of noticeRows) {
  const name = cells[NOTICE.productName];
  if (!name) continue;
  const brand = resolveBrand(name);
  if (!brand) continue;
  const rule = COMPANY_RULES[brand.name];
  if (rule?.requireCompany && !cells[NOTICE.company].includes(rule.requireCompany)) continue;
  if (usedNoticeCodes.has(cells[NOTICE.productCode])) continue;
  noticeOnly.push({
    brand: brand.name,
    ediCode: cells[NOTICE.productCode],
    noticeProductName: name,
    company: cells[NOTICE.company],
    maxPrice: cells[NOTICE.maxPrice] === '' ? null : Number(cells[NOTICE.maxPrice]),
  });
}

// ---------------------------------------------------------------- 주성분 보강

for (const item of items.values()) {
  const billingEntry = billingByKey.get(item.itemKey);
  // 약가마스터의 일반명코드가 비면 급여목록표의 주성분코드로 대체한다. 둘 다 없으면 null 유지.
  const code = item.ingredientCode ?? billingEntry?.mainIngredientCode ?? null;
  const ingredient = code ? ingredientByCode.get(code) : null;
  if (code && !item.ingredientCode && ingredient) item.ingredientCode = code;
  const notice = noticeRowByItemKey.get(item.itemKey) ?? null;
  item.ingredientNameEn = ingredient?.['일반명']?.trim() || null;
  item.dosageForm = ingredient?.['제형']?.trim() || null;
  item.route = ingredient?.['투여']?.trim() || notice?.[NOTICE.route] || null;
  item.classNo = ingredient?.['분류번호']?.trim() || billingEntry?.classNo || null;
  item.packages.sort((a, b) => a.quantity - b.quantity || a.kdCode.localeCompare(b.kdCode));
}

// ---------------------------------------------------------------- 정리 · 리포트

const itemList = [...items.values()]
  .map(({ _masterEdiCodes, _names, ...rest }) => rest)
  .sort((a, b) => (a.brandNameRaw.localeCompare(b.brandNameRaw, 'ko'))
    || a.itemName.localeCompare(b.itemName, 'ko')
    || a.company.localeCompare(b.company, 'ko'));

const byBrand = new Map();
for (const item of itemList) {
  if (!byBrand.has(item.brandNameRaw)) byBrand.set(item.brandNameRaw, []);
  byBrand.get(item.brandNameRaw).push(item);
}

const brandStats = [];
for (const matcher of brandMatchers.slice().sort((a, b) => a.name.localeCompare(b.name, 'ko'))) {
  const list = byBrand.get(matcher.name) ?? [];
  const active = list.filter((item) => !item.cancelDate);
  const listed = list.filter((item) => billingByKey.get(item.itemKey).benefitStatus === 'listed');
  brandStats.push({
    brandId: matcher.brandId,
    brandNameRaw: matcher.name,
    splitFrom: matcher.splitFrom ?? null,
    items: list.length,
    active: active.length,
    cancelled: list.length - active.length,
    listed: listed.length,
    notListed: list.length - listed.length,
    packages: list.reduce((sum, item) => sum + item.packages.length, 0),
    companies: [...new Set(list.map((item) => item.company))].sort(),
  });
}

console.log('브랜드 | brandId | 품목 | 유효 | 취소 | listed | not-listed | 포장 | 업체');
for (const stat of brandStats) {
  console.log([
    stat.brandNameRaw,
    stat.brandId ?? `(null·${stat.splitFrom}에서 분리)`,
    stat.items, stat.active, stat.cancelled, stat.listed, stat.notListed, stat.packages,
    stat.companies.join(' / ') || '-',
  ].join(' | '));
}

const listedTotal = billing.filter((entry) => entry.benefitStatus === 'listed').length;
console.log(`\n합계: 품목 ${itemList.length}건 · listed ${listedTotal} · not-listed ${billing.length - listedTotal} · 포장 ${itemList.reduce((s, i) => s + i.packages.length, 0)}건`);

if (excludedByCompany.length) {
  console.log(`\n## 업체명 규칙으로 제외 (${excludedByCompany.length}건)`);
  for (const row of excludedByCompany) console.log(`  ${row.brand} | ${row.itemName} | ${row.company} | ${row.itemSeq} | ${row.rule}`);
}

if (joinFailures.length) {
  console.log(`\n## 급여 조인 실패 (${joinFailures.length}건)`);
  for (const row of joinFailures) {
    console.log(`  ${row.itemName} | ${row.company} | 마스터코드 ${row.masterEdiCode ?? '-'} | ${row.cancelDate ? `취소 ${row.cancelDate}` : '유효'} | ${row.reason}`);
  }
}

if (noticeOnly.length) {
  console.log(`\n## 급여목록표에만 있는 행 (${noticeOnly.length}건)`);
  for (const row of noticeOnly) console.log(`  ${row.brand} | ${row.ediCode} | ${row.noticeProductName} | ${row.company} | ${row.maxPrice}`);
}

const nullBrand = itemList.filter((item) => item.brandId === null);
if (nullBrand.length) {
  console.log(`\n## products.json 에 id 가 없는 브랜드 (brandId: null) — ${nullBrand.length}건`);
  for (const name of [...new Set(nullBrand.map((item) => item.brandNameRaw))]) {
    console.log(`  ${name} — ${nullBrand.filter((item) => item.brandNameRaw === name).length}품목`);
  }
}

if (warnings.length) {
  console.log(`\n## 경고 (${warnings.length}건)`);
  for (const line of warnings) console.log(`  ${line}`);
}

// ---------------------------------------------------------------- 저장

if (!shouldWrite) {
  console.log('\n(--write 를 붙이면 items.json / billing.json / qa/runs/latest.json 을 갱신합니다)');
  process.exit(0);
}

const generatedOn = new Date().toISOString().slice(0, 10);
const publicDir = findDir(path.join('data', 'public')) ?? path.join(process.cwd(), 'data', 'public');
const runsDir = findDir(path.join('qa', 'runs')) ?? path.join(process.cwd(), 'qa', 'runs');

const itemsPayload = {
  schemaVersion: '0.2.0',
  generatedOn,
  source: {
    standardCode: path.basename(stdFile),
    ingredient: path.basename(ingredientFile),
  },
  items: itemList,
};

const billingPayload = {
  schemaVersion: '0.2.0',
  generatedOn,
  source: {
    noticeName: '약제 급여 목록 및 급여 상한금액표',
    effectiveDate: '2026-09-01',
    file: path.basename(noticeFile),
    url: 'https://www.hira.or.kr/bbsDummy.do?pgmid=HIRAA030014050000',
  },
  items: billing.sort((a, b) => a.itemKey.localeCompare(b.itemKey)),
};

fs.writeFileSync(path.join(publicDir, 'items.json'), `${JSON.stringify(itemsPayload, null, 2)}\n`, 'utf8');
fs.writeFileSync(path.join(publicDir, 'billing.json'), `${JSON.stringify(billingPayload, null, 2)}\n`, 'utf8');

const runPath = path.join(runsDir, 'latest.json');
const previousRun = fs.existsSync(runPath) ? JSON.parse(fs.readFileSync(runPath, 'utf8')) : {};
const runPayload = {
  ...previousRun,
  runId: `RUN-${generatedOn}-codebackbone-001`,
  runDate: generatedOn,
  status: joinFailures.length ? 'partial-success' : 'success',
  checks: [
    'JSON parse',
    'required product fields',
    'official-core coverage',
    'source URL https',
    'duplicate product id',
    'itemSeq/ediCode/kdCode 자릿수',
    'itemKey = 품목기준코드::업체명',
    'billing.itemKey → items.itemKey',
    'items.brandId → products.id',
    'benefitStatus enum',
    'maxPrice(listed 양의 정수 / not-listed null)',
    'itemKey·kdCode 중복',
    '고시 시행일 90일 stale 경고',
  ],
  summary: `핵심 ${baseBrands.length}개 브랜드 + 분리 브랜드 ${splitBrands.length}개를 약가마스터와 약제급여목록표(2026.9.1. 시행)로 조인해 품목 ${itemList.length}건, 포장 ${itemList.reduce((s, i) => s + i.packages.length, 0)}건을 생성했습니다. 급여 등재 ${listedTotal}건, 급여목록 미등재 ${billing.length - listedTotal}건입니다. 미등재는 비급여·수출용·취소·미등재가 모두 섞여 있어 단정하지 않습니다.`,
  codeBackbone: {
    generatedOn,
    sources: {
      standardCode: path.basename(stdFile),
      ingredient: path.basename(ingredientFile),
      notice: path.basename(noticeFile),
      noticeEffectiveDate: '2026-09-01',
    },
    brandsRequested: baseBrands.length,
    brandsSplit: splitBrands.length,
    brandsWithoutProductId: [...new Set(nullBrand.map((item) => item.brandNameRaw))],
    itemsTotal: itemList.length,
    itemsActive: itemList.filter((item) => !item.cancelDate).length,
    itemsCancelled: itemList.filter((item) => item.cancelDate).length,
    packagesTotal: itemList.reduce((sum, item) => sum + item.packages.length, 0),
    benefitListed: listedTotal,
    benefitNotListed: billing.length - listedTotal,
    byBrand: brandStats,
    joinFailures,
    noticeOnlyRows: noticeOnly,
    excludedByCompanyRule: excludedByCompany,
    warnings,
  },
};
fs.writeFileSync(runPath, `${JSON.stringify(runPayload, null, 2)}\n`, 'utf8');

console.log(`\n저장: ${path.join(publicDir, 'items.json')}`);
console.log(`저장: ${path.join(publicDir, 'billing.json')}`);
console.log(`저장: ${runPath}`);
