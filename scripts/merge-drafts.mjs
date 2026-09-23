// 문헌 검토 초안 배치를 하나로 합치고 커버리지를 점검한다.
// 사용법: node scripts/merge-drafts.mjs [--write]
//
// 입력: data/review/drafts/batch-*.json
// 출력: data/review/literature-drafts.json  (검토용. data/public 이 아니다)
//
// 초안은 공개 데이터가 아니다. 검토자가 승인해야 data/public/literature.json 으로 승격된다.

import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const draftsDir = path.join(root, 'data', 'review', 'drafts');
const outPath = path.join(root, 'data', 'review', 'literature-drafts.json');
const shouldWrite = process.argv.includes('--write');

const RELATION = new Set(['direct-product', 'same-ingredient', 'disease-context', 'safety', 'mechanism']);
const LEVEL = new Set(['guideline', 'meta-analysis', 'rct', 'observational', 'review', 'preclinical', 'registry']);
const REQUIRED = ['pmid', 'title', 'journal', 'publicationDate', 'url', 'ingredientKey', 'appliesToBrands',
  'relationType', 'evidenceLevel', 'studyDesign', 'population', 'intervention', 'comparator',
  'keyOutcomes', 'hcpSummary', 'limitations', 'relationToLabel', 'searchId'];

const products = [
  ...JSON.parse(fs.readFileSync(path.join(root, 'data/public/products.json'), 'utf8')).products,
  ...JSON.parse(fs.readFileSync(path.join(root, 'data/public/additional-products.json'), 'utf8')).products,
];
const productIds = new Set(products.map((p) => p.id));
const searches = JSON.parse(fs.readFileSync(path.join(root, 'data/public/searches.json'), 'utf8')).searches;

const drafts = [];
const excluded = [];
const notes = [];
const problems = [];
const seen = new Map();

for (const file of fs.readdirSync(draftsDir).filter((f) => /^batch-.*\.json$/.test(f)).sort()) {
  const batch = JSON.parse(fs.readFileSync(path.join(draftsDir, file), 'utf8'));
  for (const note of batch.notes || []) notes.push({ batch: batch.batch, note });
  for (const ex of batch.excluded || []) excluded.push({ batch: batch.batch, ...ex });
  for (const d of batch.drafts || []) {
    for (const field of REQUIRED) {
      if (d[field] === undefined || d[field] === null || d[field] === '') problems.push(`${file} ${d.pmid}: ${field} 누락`);
    }
    if (!RELATION.has(d.relationType)) problems.push(`${file} ${d.pmid}: relationType 값 오류 (${d.relationType})`);
    if (!LEVEL.has(d.evidenceLevel)) problems.push(`${file} ${d.pmid}: evidenceLevel 값 오류 (${d.evidenceLevel})`);
    if (d.status !== 'draft') problems.push(`${file} ${d.pmid}: status 는 draft 여야 합니다`);
    if (d.reviewer || d.reviewedOn) problems.push(`${file} ${d.pmid}: 검토 전 초안에 reviewer/reviewedOn 이 채워져 있습니다`);
    if (!/^https:\/\/pubmed\.ncbi\.nlm\.nih\.gov\/\d+\/$/.test(d.url || '')) problems.push(`${file} ${d.pmid}: url 형식 오류`);
    for (const b of d.appliesToBrands || []) {
      if (!productIds.has(b)) problems.push(`${file} ${d.pmid}: 알 수 없는 brandId ${b}`);
    }
    if (seen.has(d.pmid)) problems.push(`${file} ${d.pmid}: 다른 배치(${seen.get(d.pmid)})와 중복`);
    seen.set(d.pmid, batch.batch);
    drafts.push(d);
  }
}

// 브랜드별 커버리지
const byBrand = new Map();
for (const d of drafts) for (const b of d.appliesToBrands) byBrand.set(b, (byBrand.get(b) || 0) + 1);
const searchBrands = new Set(searches.flatMap((s) => s.appliesToBrands));

console.log(`초안 ${drafts.length}건 · 제외 기록 ${excluded.length}건 · 배치 메모 ${notes.length}건\n`);
console.log('브랜드별 초안 수');
for (const b of [...searchBrands].sort()) {
  const n = byBrand.get(b) || 0;
  const mark = n === 0 ? '  ← 초안 없음' : n < 2 ? '  ← 보강 검토' : '';
  console.log(`  ${b.padEnd(18)} ${String(n).padStart(2)}건${mark}`);
}
const levels = drafts.reduce((acc, d) => (acc[d.evidenceLevel] = (acc[d.evidenceLevel] || 0) + 1, acc), {});
console.log('\n근거 수준:', Object.entries(levels).map(([k, v]) => `${k} ${v}`).join(' · '));
const rel = drafts.reduce((acc, d) => (acc[d.relationType] = (acc[d.relationType] || 0) + 1, acc), {});
console.log('관계 유형:', Object.entries(rel).map(([k, v]) => `${k} ${v}`).join(' · '));

if (problems.length) {
  console.log(`\n확인 필요 ${problems.length}건`);
  problems.forEach((p) => console.log(`  ! ${p}`));
} else {
  console.log('\n형식 점검 통과');
}

if (shouldWrite) {
  const payload = {
    schemaVersion: '0.1.0',
    status: 'draft',
    generatedOn: new Date().toISOString().slice(0, 10),
    policy: 'AI가 초록을 읽고 작성한 초안이다. 사람 검토를 거쳐야 data/public/literature.json 으로 승격된다. 승격 전에는 공개 화면에 노출하지 않는다.',
    reviewChecklist: [
      '연구대상·용량·기간·비교군을 초록에서 확인했는가',
      '주요 결과와 한계를 함께 적었는가',
      '허가사항과 연구 결과를 분리했는가',
      '우월성·처방 권고로 읽힐 문장이 없는가',
      '국내 급여 인정 범위와 연구 대상이 다른 경우 그 점을 적었는가',
      'PMID·링크가 정상인가',
    ],
    counts: { drafts: drafts.length, byBrand: Object.fromEntries([...byBrand].sort()) },
    batchNotes: notes,
    excluded,
    drafts,
  };
  fs.writeFileSync(outPath, JSON.stringify(payload, null, 2), 'utf8');
  console.log(`\n저장: ${outPath}`);
}
process.exit(problems.length ? 1 : 0);
