// 적응증 ↔ 상병코드(KCD) 매핑을 생성한다.
// 사용법: node scripts/build-indications.mjs [--write]
//
// 입력: data/mapping/kcd-blocks.json                      (사람이 작성한 블록 후보)
//       data/source/건강보험심사평가원_상병마스터_*.csv      (CP949)
// 출력: data/public/indications.json
//
// 규칙 (docs/KCD_MAPPING.md):
//   - 블록(불완전코드)은 분류 헤더로만 쓰고, 제시는 하위 완전코드로 한다.
//   - 완전코드 = 상병마스터의 '완전코드구분' 이 빈값인 코드.
//   - 급여 기준은 kcd-blocks.json 에 확인된 것만 적고, 근거 고시·확인일·출처유형을 함께 남긴다.
//     확인 전에는 null 로 두어 빈 값이 '제한 없음'으로 읽히지 않게 한다.
//   - reviewStatus 는 candidate. 사람 검토 전에는 공개 화면에서 급여 문구를 붙이지 않는다.

import fs from 'node:fs';
import path from 'node:path';

function findDir(relative) {
  let dir = process.cwd();
  for (let d = 0; d < 6; d += 1) {
    const c = path.join(dir, relative);
    if (fs.existsSync(c)) return c;
    const p = path.dirname(dir);
    if (p === dir) break;
    dir = p;
  }
  return null;
}

function readCsv(filePath) {
  const text = new TextDecoder('euc-kr').decode(fs.readFileSync(filePath));
  const rows = [];
  let field = '', record = [], quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i += 1; } else quoted = false; }
      else field += ch;
      continue;
    }
    if (ch === '"') { quoted = true; continue; }
    if (ch === ',') { record.push(field); field = ''; continue; }
    if (ch === '\n') { record.push(field.replace(/\r$/, '')); rows.push(record); record = []; field = ''; continue; }
    field += ch;
  }
  if (field || record.length) { record.push(field.replace(/\r$/, '')); rows.push(record); }
  const header = rows.shift().map((h) => h.trim());
  return rows.filter((r) => r.length >= header.length - 1).map((r) => {
    const o = {};
    header.forEach((h, i) => { o[h] = (r[i] ?? '').trim(); });
    return o;
  });
}

const root = process.cwd();
const sourceDir = findDir(path.join('data', 'source'));
if (!sourceDir) {
  console.error('data/source 폴더를 찾지 못했습니다. 상병마스터 CSV 가 필요합니다.');
  process.exit(1);
}
const masterFile = fs.readdirSync(sourceDir).filter((n) => n.includes('상병마스터') && n.endsWith('.csv')).sort().pop();
if (!masterFile) {
  console.error('data/source 에 상병마스터 CSV 가 없습니다.');
  process.exit(1);
}

// 상병마스터 '성별구분'은 염색체 관례를 따른다 (X=여성, Y=남성).
// 근거: C61 전립선 악성신생물=Y, N40 전립선증식증=Y / D251 자궁근종=X, O000 복강임신=X, M8100 폐경후골다공증=X
const SEX_LABEL = { X: '여성', Y: '남성' };

// 상병마스터: 한 코드에 동의어 행이 여럿 붙으므로 코드 단위로 첫 행만 남긴다.
const master = new Map();
for (const row of readCsv(path.join(sourceDir, masterFile))) {
  const code = row['상병기호'];
  if (!code || master.has(code)) continue;
  master.set(code, {
    nameKo: row['한글명'],
    complete: !row['완전코드구분'],
    sex: row['성별구분'] || null,
    sexLabel: SEX_LABEL[row['성별구분']] || null,
    ageMin: row['하한연령'] || null,
    ageMax: row['상한연령'] || null,
  });
}

const mappingPath = path.join(root, 'data', 'mapping', 'kcd-blocks.json');
const mapping = JSON.parse(fs.readFileSync(mappingPath, 'utf8'));
const products = [
  ...JSON.parse(fs.readFileSync(path.join(root, 'data/public/products.json'), 'utf8')).products,
  ...JSON.parse(fs.readFileSync(path.join(root, 'data/public/additional-products.json'), 'utf8')).products,
];
const productIds = new Set(products.map((p) => p.id));

const out = [];
const problems = [];
let codeTotal = 0;

for (const brand of mapping.brands) {
  if (!productIds.has(brand.brandId)) problems.push(`brandId 없음: ${brand.brandId}`);
  const blocks = [];
  for (const b of brand.blocks) {
    const entry = master.get(b.block);
    if (!entry) { problems.push(`${brand.brandId}: 블록 ${b.block} 이 상병마스터에 없음`); continue; }
    // 블록 자신이 완전코드면 그 자체가 유일한 코드다 (예: Z940 신장이식상태).
    const codes = [];
    if (b.only) {
      // 허가 적응증이 블록 전체가 아니라 일부 코드에만 해당할 때 명시적으로 좁힌다.
      // 예: 타크로벨은 신·간 이식만 허가되어 있어 T86 전체(골수·심장 거부 포함)를 쓰면 범위를 넘는다.
      for (const code of b.only) {
        const info = master.get(code);
        if (!info) { problems.push(`${brand.brandId}: only 코드 ${code} 가 상병마스터에 없음`); continue; }
        if (!info.complete) { problems.push(`${brand.brandId}: only 코드 ${code} 는 불완전코드`); continue; }
        codes.push({ code, nameKo: info.nameKo, sex: info.sex, sexLabel: info.sexLabel, ageMin: info.ageMin, ageMax: info.ageMax });
      }
    } else if (entry.complete) {
      codes.push({ code: b.block, nameKo: entry.nameKo, sex: entry.sex, sexLabel: entry.sexLabel, ageMin: entry.ageMin, ageMax: entry.ageMax });
    } else {
      for (const [code, info] of master) {
        if (code === b.block || !code.startsWith(b.block) || !info.complete) continue;
        codes.push({ code, nameKo: info.nameKo, sex: info.sex, sexLabel: info.sexLabel, ageMin: info.ageMin, ageMax: info.ageMax });
      }
      codes.sort((x, y) => x.code.localeCompare(y.code));
    }
    if (!codes.length) problems.push(`${brand.brandId}: 블록 ${b.block} 아래 완전코드가 없음`);
    codeTotal += codes.length;
    blocks.push({
      block: b.block,
      blockName: entry.nameKo,
      blockComplete: entry.complete,
      restricted: Boolean(b.only),
      indicationLabel: b.for,
      note: b.note ?? null,
      codes,
    });
  }
  out.push({
    brandId: brand.brandId,
    sourceItemSeq: brand.sourceItemSeq,
    labelSourceUrl: `https://nedrug.mfds.go.kr/pbp/CCBBB01/getItemDetail?itemSeq=${brand.sourceItemSeq}`,
    indicationLabels: brand.indicationLabels,
    blocks,
    note: brand.note ?? null,
    // 급여 기준은 확인된 것만 싣는다. 확인 전에는 null 로 두고, 빈 값을 '제한 없음'으로 읽히게 하지 않는다.
    reimbursementScope: brand.reimbursement?.scope ?? null,
    reimbursementDetails: brand.reimbursement?.details ?? null,
    reimbursementCodes: brand.reimbursement?.codes ?? null,
    noticeRef: brand.reimbursement?.noticeRef ?? null,
    noticeUrl: brand.reimbursement?.noticeUrl ?? null,
    reimbursementCheckedOn: brand.reimbursement?.checkedOn ?? null,
    reimbursementSourceType: brand.reimbursement?.sourceType ?? null,
    reviewStatus: 'candidate',
    mappedBy: null,
    mappedOn: null,
  });
}

console.log(`상병마스터: ${masterFile}`);
console.log(`브랜드 ${out.length}개 · 블록 ${out.reduce((n, b) => n + b.blocks.length, 0)}개 · 완전코드 ${codeTotal}개`);
for (const b of out) {
  const codes = b.blocks.reduce((n, x) => n + x.codes.length, 0);
  console.log(`  ${b.brandId.padEnd(16)} 블록 ${String(b.blocks.length).padStart(2)}개 · 코드 ${String(codes).padStart(4)}개  ${b.blocks.map((x) => x.block).join(', ')}`);
}
if (problems.length) {
  console.log('\n확인 필요:');
  problems.forEach((p) => console.log(`  ! ${p}`));
}

if (process.argv.includes('--write')) {
  const payload = {
    schemaVersion: '0.2.0',
    generatedOn: new Date().toISOString().slice(0, 10),
    source: { diseaseMaster: masterFile, mapping: 'data/mapping/kcd-blocks.json' },
    policy: mapping.policy,
    disclaimer: '상병코드는 허가 적응증에 대응하는 참고 매핑입니다. 실제 청구 상병은 환자 상태와 심평원 고시 기준에 따라 의료진이 판단합니다.',
    items: out,
  };
  const outPath = path.join(root, 'data', 'public', 'indications.json');
  fs.writeFileSync(outPath, JSON.stringify(payload, null, 2), 'utf8');
  console.log(`\n저장: ${outPath}`);
}
