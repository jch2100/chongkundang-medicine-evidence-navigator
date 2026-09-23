// 공개 데이터에서 운영 현황(qa/runs/latest.json)을 다시 만든다.
// 사용법: node scripts/build-run-log.mjs [--write]
//
// 숫자를 손으로 적지 않는다. 손으로 적은 숫자는 반드시 어긋난다.
// 각 층의 실제 파일에서 세어 기록하고, build-items.mjs 가 남긴 codeBackbone 은 보존한다.

import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = (rel, fallback = null) => {
  const p = path.join(root, rel);
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : fallback;
};

const products = [
  ...(read('data/public/products.json')?.products || []),
  ...(read('data/public/additional-products.json')?.products || []),
];
const items = read('data/public/items.json')?.items || [];
const billing = read('data/public/billing.json')?.items || [];
const changes = read('data/public/changes.json')?.changes || [];
const literature = read('data/public/literature.json')?.items || [];
const indications = read('data/public/indications.json')?.items || [];
const searches = read('data/public/searches.json')?.searches || [];
const previous = read('qa/runs/latest.json', {});

const count = (arr, fn) => arr.filter(fn).length;
const byReview = literature.reduce((acc, i) => (acc[i.reviewType || 'unspecified'] = (acc[i.reviewType || 'unspecified'] || 0) + 1, acc), {});
const litBrands = new Set(literature.map((i) => i.productId));
const kcdCodes = indications.reduce((n, e) => n + e.blocks.reduce((m, b) => m + b.codes.length, 0), 0);
const withReimbursement = count(indications, (e) => e.reimbursementScope);

const today = new Date().toISOString().slice(0, 10);
const run = {
  ...previous,
  runId: `RUN-${today}-status-001`,
  runDate: today,
  status: 'partial-success',
  summary: [
    `제품 ${products.length}개(공개 ${count(products, (p) => p.status === 'published')}개).`,
    `허가 품목 ${items.length}건, 포장 ${items.reduce((n, i) => n + (i.packages || []).length, 0)}건.`,
    `급여 등재 ${count(billing, (b) => b.benefitStatus === 'listed')}건, 미등재 ${count(billing, (b) => b.benefitStatus === 'not-listed')}건.`,
    `상병코드 매핑 ${indications.length}개 브랜드·완전코드 ${kcdCodes}개(모두 사람 검토 전).`,
    `급여 기준 확인 ${withReimbursement}개 브랜드.`,
    `문헌 ${literature.length}건 / 브랜드 ${litBrands.size}개, 검색식 ${searches.length}건.`,
  ].join(' '),
  productsTotal: products.length,
  productsPublished: count(products, (p) => p.status === 'published'),
  changesPublished: changes.length,
  literaturePublished: literature.length,
  literatureByReview: byReview,
  literatureBrands: litBrands.size,
  indications: { brands: indications.length, blocks: indications.reduce((n, e) => n + e.blocks.length, 0), codes: kcdCodes, reviewed: count(indications, (e) => e.reviewStatus === 'reviewed'), withReimbursement },
  searches: { count: searches.length, totalHits: searches.reduce((n, s) => n + (s.totalHits || 0), 0) },
  openItems: [
    '상병코드 매핑 전체가 reviewStatus: candidate — 사람 검토 전',
    '급여 기준은 글리아티린·큐시미아 2건만 확인. 나머지는 미확인이라 화면에 표시하지 않음',
    '문헌 요약 62건은 AI 작성·AI 검증. 임상 해석은 전문가 검토 전',
    '사이클로스포린·미코페놀레이트는 허가 적응증(장기이식) 문헌 미확보 — 검색식 재작성 필요',
    '텔미누보에스 3품목은 전량 허가취소로 브랜드를 만들지 않음(경고 3건은 의도된 상태)',
  ],
  checks: previous.checks || [],
};

console.log(run.summary.split('. ').join('.\n'));
console.log('\n검토 유형:', Object.entries(byReview).map(([k, v]) => `${k} ${v}`).join(' · '));
console.log('미해결 항목:', run.openItems.length, '건');

if (process.argv.includes('--write')) {
  fs.writeFileSync(path.join(root, 'qa/runs/latest.json'), JSON.stringify(run, null, 2), 'utf8');
  console.log('\n저장: qa/runs/latest.json');
}
