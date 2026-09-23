// 문헌 초안을 원 초록과 대조해 검증한다.
// 사용법: node scripts/verify-drafts.mjs
//
// 사람이 눈으로 읽는 검토를 대신하지 않는다. 기계가 확인할 수 있는 것만 확인한다.
//   - 서지정보(제목·학술지·연도)가 PubMed 원본과 일치하는가
//   - 요약에 적은 숫자가 초록에 실제로 있는가  ← 가장 흔한 오류 유형
//   - 우월성·권고로 읽힐 표현이 들어갔는가
//   - PMID·URL 형식이 맞는가
//
// 입력: data/review/literature-drafts.json
//       data/source/cache/pubmed/abstracts.json   (gitignore 대상)

import fs from 'node:fs';
import path from 'node:path';

function findPath(relative) {
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

const root = process.cwd();
const drafts = JSON.parse(fs.readFileSync(path.join(root, 'data/review/literature-drafts.json'), 'utf8')).drafts;
const absPath = findPath(path.join('data', 'source', 'cache', 'pubmed', 'abstracts.json'));
if (!absPath) {
  console.error('초록 캐시가 없습니다. node scripts/fetch-abstracts.mjs 를 먼저 실행하세요.');
  process.exit(1);
}
const abstracts = JSON.parse(fs.readFileSync(absPath, 'utf8'));

/* 우월성·처방 권고로 읽힐 수 있는 표현. 프로젝트 규칙상 금지된다. */
const BANNED = [
  '우월', '더 좋', '더 우수', '가장 효과적', '최선의 선택', '권장한다', '처방하라',
  '부작용이 적다', '안전하다고 할 수 있', '1차 선택약',
];

/* 비교·인용 맥락에서 정당한 사용은 예외로 둔다. */
const ALLOWED_CONTEXT = ['우월성', '우월로', '우세했다고', '우수한지'];

const norm = (s) => (s || '').replace(/[\s ]+/g, ' ').replace(/[.,;:]$/g, '').trim().toLowerCase();
const numbersIn = (s) => [...String(s || '').matchAll(/\d+(?:[.,]\d+)?/g)].map((m) => m[0].replace(',', ''));

let issues = 0;
const report = [];

for (const d of drafts) {
  const found = [];
  const meta = abstracts[d.pmid];
  if (!meta) {
    found.push('초록 캐시에 없음 — 원문 대조 불가');
  } else {
    // 서지정보 대조
    const year = String(d.publicationDate).slice(0, 4);
    if (meta.year && meta.year !== year) found.push(`발행연도 불일치: 초안 ${year} / PubMed ${meta.year}`);
    if (meta.journal && norm(meta.journal) !== norm(d.journal)) {
      // 약어·정식명 차이는 흔하므로 앞 8글자만 비교해 명백한 오기만 잡는다.
      const a = norm(meta.journal).slice(0, 8);
      const b = norm(d.journal).slice(0, 8);
      if (a !== b) found.push(`학술지명 확인: 초안 "${d.journal}" / PubMed "${meta.journal}"`);
    }
    // 숫자 대조 — 요약·결과에 적은 수치가 초록에 있는지
    if (meta.abstract) {
      const hay = meta.abstract.replace(/,/g, '');
      for (const field of ['keyOutcomes', 'hcpSummary', 'population']) {
        for (const n of numbersIn(d[field])) {
          if (n.length < 2) continue;               // 한 자리 수는 오탐이 많다
          if (/^(19|20)\d{2}$/.test(n)) continue;   // 연도는 별도 확인
          if (!hay.includes(n)) found.push(`${field}의 숫자 "${n}" 이 초록에 없음`);
        }
      }
    }
  }
  // 금지 표현
  for (const word of BANNED) {
    for (const field of ['hcpSummary', 'keyOutcomes', 'relationToLabel', 'limitations']) {
      const text = d[field] || '';
      if (!text.includes(word)) continue;
      if (ALLOWED_CONTEXT.some((ok) => text.includes(ok))) continue;
      found.push(`${field}에 금지 표현 "${word}"`);
    }
  }
  // 링크
  if (!d.url.endsWith(`/${d.pmid}/`)) found.push('url 과 pmid 불일치');

  if (found.length) {
    issues += found.length;
    report.push({ pmid: d.pmid, brands: d.appliesToBrands.join(','), found });
  }
}

console.log(`초안 ${drafts.length}건 검증 · 지적 ${issues}건\n`);
for (const r of report) {
  console.log(`[${r.pmid}] ${r.brands}`);
  r.found.forEach((f) => console.log(`   - ${f}`));
}
if (!report.length) console.log('기계 검증에서 지적 사항 없음');
console.log('\n이 검증은 서지정보·수치·표현만 확인한다. 임상적 해석의 타당성은 사람이 읽어야 한다.');
