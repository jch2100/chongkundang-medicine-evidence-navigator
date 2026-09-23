// 검증을 마친 초안을 공개 문헌 데이터로 승격한다.
// 사용법: node scripts/promote-drafts.mjs [--write]
//
// 입력: data/review/literature-drafts.json
// 출력: data/public/literature.json
//
// 검토 주체를 사실대로 기록한다. 이 프로젝트에서 AI가 작성하고 AI가 검증한 요약은
// 임상 전문가 검토를 거친 자료와 같지 않다. reviewType 으로 구분하고 화면에도 표시한다.
//   human-reviewed : 의학·허가 담당자가 읽고 승인
//   ai-verified    : AI가 초록과 대조해 서지정보·수치·표현을 검증. 임상적 해석은 미검증
//
// 문헌은 성분 단위로 작성하고 브랜드가 상속하므로, 브랜드별 항목으로 펼쳐 저장한다.

import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const shouldWrite = process.argv.includes('--write');
const today = new Date().toISOString().slice(0, 10);

const draftFile = JSON.parse(fs.readFileSync(path.join(root, 'data/review/literature-drafts.json'), 'utf8'));
const current = JSON.parse(fs.readFileSync(path.join(root, 'data/public/literature.json'), 'utf8'));

/* 기존 항목은 이번 작업 이전에 등록된 것으로, 검토 주체가 기록되어 있지 않다.
   사실과 다르게 채우지 않고 unspecified 로 남긴다. */
const kept = (current.items || []).map((item) => ({
  ...item,
  reviewType: item.reviewType || 'unspecified',
}));
const keptKeys = new Set(kept.map((i) => `${i.pmid}::${i.productId}`));

const promoted = [];
for (const d of draftFile.drafts) {
  for (const brandId of d.appliesToBrands) {
    const key = `${d.pmid}::${brandId}`;
    if (keptKeys.has(key)) continue;
    promoted.push({
      productId: brandId,
      pmid: d.pmid,
      title: d.title,
      journal: d.journal,
      publicationDate: d.publicationDate,
      url: d.url,
      ingredientKey: d.ingredientKey,
      relationType: d.relationType,
      evidenceLevel: d.evidenceLevel,
      studyDesign: d.studyDesign,
      population: d.population,
      intervention: d.intervention,
      comparator: d.comparator,
      keyOutcomes: d.keyOutcomes,
      hcpSummary: d.hcpSummary,
      limitations: d.limitations,
      relationToLabel: d.relationToLabel,
      searchId: d.searchId,
      sourceType: 'PubMed',
      status: 'published',
      reviewType: 'ai-verified',
      draftedBy: d.draftedBy,
      reviewer: 'claude-opus-5',
      reviewedOn: today,
      verification: 'scripts/verify-drafts.mjs — 서지정보·수치·표현 대조 통과',
    });
  }
}

const items = [...kept, ...promoted];
const byType = items.reduce((acc, i) => (acc[i.reviewType] = (acc[i.reviewType] || 0) + 1, acc), {});
const byBrand = items.reduce((acc, i) => (acc[i.productId] = (acc[i.productId] || 0) + 1, acc), {});

console.log(`기존 ${kept.length}건 + 승격 ${promoted.length}건 = ${items.length}건`);
console.log('검토 유형:', Object.entries(byType).map(([k, v]) => `${k} ${v}`).join(' · '));
console.log(`브랜드 ${Object.keys(byBrand).length}개 · 브랜드당 평균 ${(items.length / Object.keys(byBrand).length).toFixed(1)}건`);

if (shouldWrite) {
  const payload = {
    schemaVersion: '0.2.0',
    generatedOn: today,
    policy: current.policy,
    reviewTypes: {
      'human-reviewed': '의학·허가 담당자가 읽고 승인한 요약',
      'ai-verified': 'AI가 작성하고 AI가 초록과 대조해 검증한 요약. 임상적 해석은 전문가 검토를 거치지 않았다',
      unspecified: '검토 주체가 기록되지 않은 기존 항목',
    },
    disclaimer: '연구 요약은 공개 문헌 탐색을 위한 참고정보입니다. 연구 결과가 국내 허가사항, 처방 판단 또는 특정 제품의 우월성을 의미하지 않습니다.',
    items,
  };
  fs.writeFileSync(path.join(root, 'data/public/literature.json'), JSON.stringify(payload, null, 2), 'utf8');
  console.log('\n저장: data/public/literature.json');
}
