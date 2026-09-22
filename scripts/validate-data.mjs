// 공개 데이터 검증기 v2 — DATA_DICTIONARY §6
// 사용법: node scripts/validate-data.mjs [--root <디렉터리>]
//   --root 는 검증 대상 트리를 바꾼다(검증기 자체를 테스트할 때 사용).
//
// 삭제된 규칙(의도적):
//   - 제품 40개 고정 검사        → 데이터가 늘수록 통과가 쉬워야 한다
//   - qa/runs/latest.json 카운트 일치 검사 → 리포트가 데이터를 막으면 안 된다
//   - status === 'review' && sources.ckd 실패 → 검토 품목 정보를 보강하면 깨지는 잘못된 규칙
//
// 실패(errors)는 종료코드 1, 경고(warnings)는 출력만 하고 통과시킨다.

import fs from 'node:fs';
import path from 'node:path';

const rootFlag = process.argv.indexOf('--root');
const root = rootFlag >= 0 ? path.resolve(process.argv[rootFlag + 1]) : process.cwd();

const errors = [];
const warnings = [];

const readJson = (relative, { required = true } = {}) => {
  const file = path.join(root, relative);
  if (!fs.existsSync(file)) {
    if (required) errors.push(`${relative}: 파일이 없습니다`);
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    errors.push(`${relative}: JSON 파싱 실패 — ${error.message}`);
    return null;
  }
};

const products = readJson('data/public/products.json');
const additions = readJson('data/public/additional-products.json');
const changes = readJson('data/public/changes.json');
const literature = readJson('data/public/literature.json');
const core = readJson('data/public/official-core.json');
const additionalCore = readJson('data/public/additional-core.json');
const faq = readJson('data/public/faq-templates.json');
const items = readJson('data/public/items.json');
const billing = readJson('data/public/billing.json');

if (errors.length) {
  console.error(`VALIDATION FAILED (${errors.length})`);
  errors.forEach((error) => console.error(`- ${error}`));
  process.exit(1);
}

const isHttps = (url) => typeof url === 'string' && /^https:\/\//.test(url);
const isDate = (value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);

// ---------------------------------------------------------------- 제품 층

const allProducts = [...(products.products || []), ...(additions.products || [])];
const allCore = { ...(core.items || {}), ...(additionalCore.items || {}) };
const productIds = new Set();

for (const product of allProducts) {
  const label = `product:${product.id || 'unknown'}`;
  for (const field of ['id', 'name', 'dartCategory', 'status', 'sources']) {
    if (product[field] === undefined || product[field] === null || product[field] === '') errors.push(`${label} missing ${field}`);
  }
  if (productIds.has(product.id)) errors.push(`duplicate product id: ${product.id}`);
  productIds.add(product.id);
  if (!isHttps(product.sources?.dart)) errors.push(`${label} DART source must be https`);
  if (product.sources?.ckd && !isHttps(product.sources.ckd)) errors.push(`${label} CKD source must be https`);
  if (product.status === 'published' && !product.sources?.ckd) errors.push(`${label} published product needs CKD source`);
  if (!allCore[product.id]) errors.push(`${label} missing official-core record`);
  if (product.scope && !['ETC', 'OTC'].includes(product.scope)) errors.push(`${label} invalid scope`);
}

for (const [id, item] of Object.entries(allCore)) {
  if (!productIds.has(id)) errors.push(`official-core:${id} references unknown product`);
  if (!isHttps(item.source)) errors.push(`official-core:${id} source must be https`);
}

// ---------------------------------------------------------------- FAQ

const faqKeys = new Set(['efficacy', 'ingredient', 'safety', 'dosing', 'changes', 'research']);
if (!Array.isArray(faq.items) || faq.items.length < 5) errors.push('faq-templates.json: at least 5 FAQ templates required');
for (const item of faq.items || []) {
  if (!item.id || !item.question || !faqKeys.has(item.answerKey)) errors.push(`faq:${item.id || 'unknown'} incomplete or unsupported answerKey`);
}

// ---------------------------------------------------------------- 변경 이력 · 문헌

for (const change of changes.changes || []) {
  if (!change.productId || !productIds.has(change.productId)) errors.push(`change:${change.id} references unknown product`);
  if (!isDate(change.date)) errors.push(`change:${change.id} invalid date`);
  if (!isHttps(change.source)) errors.push(`change:${change.id} source must be https`);
}

for (const item of literature.items || []) {
  if (!item.productId || !productIds.has(item.productId)) errors.push(`literature:${item.pmid} references unknown product`);
  if (item.status === 'published' && (!item.title || !item.hcpSummary || !item.url)) errors.push(`literature:${item.pmid} published item incomplete`);
  if (item.url && !isHttps(item.url)) errors.push(`literature:${item.pmid} url must be https`);
}

// ---------------------------------------------------------------- 허가 층 (items.json)

const itemKeys = new Set();
const kdCodes = new Map();

if (!Array.isArray(items.items)) errors.push('items.json: items 배열이 없습니다');
if (!isDate(items.generatedOn)) errors.push('items.json: generatedOn 은 YYYY-MM-DD 여야 합니다');
for (const [key, value] of Object.entries(items.source || {})) {
  if (key.toLowerCase().includes('url') && !isHttps(value)) errors.push(`items.json: source.${key} must be https`);
}

for (const item of items.items || []) {
  const label = `item:${item.itemKey || 'unknown'}`;
  if (!item.itemKey) { errors.push('items.json: itemKey 누락'); continue; }
  if (itemKeys.has(item.itemKey)) errors.push(`duplicate itemKey: ${item.itemKey}`);
  itemKeys.add(item.itemKey);

  if (!/^\d{9}$/.test(item.itemSeq || '')) errors.push(`${label} itemSeq must be 9 digits`);
  if (item.itemKey !== `${item.itemSeq}::${item.company}`) errors.push(`${label} itemKey must be '품목기준코드::업체명'`);
  if (!item.itemName) errors.push(`${label} missing itemName`);
  if (!item.company) errors.push(`${label} missing company`);
  if (item.isCkd !== item.company?.includes('종근당')) errors.push(`${label} isCkd must match company`);
  if (item.cancelDate !== null && !isDate(item.cancelDate)) errors.push(`${label} invalid cancelDate`);
  if (item.approvalDate !== null && !isDate(item.approvalDate)) errors.push(`${label} invalid approvalDate`);
  if (item.representativeCode && !/^\d{13}$/.test(item.representativeCode)) errors.push(`${label} representativeCode must be 13 digits`);

  if (item.brandId === null) {
    warnings.push(`${label} brandId 가 null 입니다 (brandNameRaw: ${item.brandNameRaw ?? '?'}) — products.json 에 브랜드 추가 검토 필요`);
    if (!item.brandNameRaw) errors.push(`${label} brandId 가 null 이면 brandNameRaw 가 필요합니다`);
  } else if (!productIds.has(item.brandId)) {
    errors.push(`${label} brandId '${item.brandId}' references unknown product`);
  }

  if (!Array.isArray(item.packages)) { errors.push(`${label} packages must be an array`); continue; }
  for (const pkg of item.packages) {
    if (!/^\d{13}$/.test(pkg.kdCode || '')) errors.push(`${label} kdCode must be 13 digits: ${pkg.kdCode}`);
    if (!Number.isInteger(pkg.quantity) || pkg.quantity < 0) errors.push(`${label} package quantity must be a non-negative integer: ${pkg.quantity}`);
    if (kdCodes.has(pkg.kdCode)) errors.push(`duplicate kdCode ${pkg.kdCode}: ${kdCodes.get(pkg.kdCode)} vs ${item.itemKey}`);
    else kdCodes.set(pkg.kdCode, item.itemKey);
  }
}

// ---------------------------------------------------------------- 급여 층 (billing.json)

const BENEFIT_STATUS = new Set(['listed', 'not-listed']);
const billingKeys = new Set();

if (!Array.isArray(billing.items)) errors.push('billing.json: items 배열이 없습니다');
if (!isDate(billing.generatedOn)) errors.push('billing.json: generatedOn 은 YYYY-MM-DD 여야 합니다');
if (!isDate(billing.source?.effectiveDate)) errors.push('billing.json: source.effectiveDate 는 YYYY-MM-DD 여야 합니다');
if (!isHttps(billing.source?.url)) errors.push('billing.json: source.url must be https');
if (!billing.source?.noticeName) errors.push('billing.json: source.noticeName 누락 — 화면에 출처 고시명을 표시해야 합니다');

for (const entry of billing.items || []) {
  const label = `billing:${entry.itemKey || 'unknown'}`;
  if (!entry.itemKey) { errors.push('billing.json: itemKey 누락'); continue; }
  if (billingKeys.has(entry.itemKey)) errors.push(`duplicate billing itemKey: ${entry.itemKey}`);
  billingKeys.add(entry.itemKey);
  if (!itemKeys.has(entry.itemKey)) errors.push(`${label} references unknown itemKey`);

  if (!BENEFIT_STATUS.has(entry.benefitStatus)) {
    errors.push(`${label} invalid benefitStatus: ${entry.benefitStatus}`);
    continue;
  }
  if (entry.ediCode !== null && !/^\d{9}$/.test(entry.ediCode || '')) errors.push(`${label} ediCode must be 9 digits: ${entry.ediCode}`);

  if (entry.benefitStatus === 'listed') {
    if (!Number.isInteger(entry.maxPrice) || entry.maxPrice <= 0) errors.push(`${label} listed item needs a positive integer maxPrice, got ${entry.maxPrice}`);
    if (!entry.ediCode) errors.push(`${label} listed item needs an ediCode`);
    if (!entry.priceUnit) errors.push(`${label} listed item needs a priceUnit`);
    if (!entry.noticeProductName) errors.push(`${label} listed item needs a noticeProductName`);
  } else {
    if (entry.maxPrice !== null) errors.push(`${label} not-listed item must have maxPrice null, got ${entry.maxPrice}`);
  }
}

for (const key of itemKeys) {
  if (!billingKeys.has(key)) errors.push(`item:${key} has no billing record — 급여 여부를 표시할 수 없습니다`);
}

// ---------------------------------------------------------------- 상병코드 층 (indications.json)
// docs/KCD_MAPPING.md — 불완전코드를 청구 코드처럼 제시하면 틀린 안내가 된다.

const indications = readJson('data/public/indications.json', { required: false });
if (indications) {
  const REVIEW_STATUS = new Set(['candidate', 'reviewed']);
  const seenBrands = new Set();
  for (const entry of indications.items || []) {
    const id = entry.brandId || '(unknown)';
    if (!entry.brandId || !productIds.has(entry.brandId)) errors.push(`indications:${id} 알 수 없는 brandId`);
    if (seenBrands.has(entry.brandId)) errors.push(`indications:${id} brandId 중복`);
    seenBrands.add(entry.brandId);
    if (!isHttps(entry.labelSourceUrl)) errors.push(`indications:${id} labelSourceUrl 은 https 여야 합니다`);
    if (!Array.isArray(entry.indicationLabels) || !entry.indicationLabels.length) errors.push(`indications:${id} indicationLabels 가 비어 있습니다`);
    if (!REVIEW_STATUS.has(entry.reviewStatus)) errors.push(`indications:${id} reviewStatus 값이 잘못되었습니다`);
    if (entry.reviewStatus === 'reviewed' && (!entry.mappedBy || !isDate(entry.mappedOn))) {
      errors.push(`indications:${id} reviewed 상태는 mappedBy 와 mappedOn 이 필요합니다`);
    }
    // 급여 인정 상병은 고시 확인 없이 채우지 않는다.
    if (entry.reimbursementScope) {
      if (!entry.noticeRef) errors.push(`indications:${id} reimbursementScope 에는 noticeRef 가 필요합니다`);
      if (!isDate(entry.reimbursementCheckedOn)) errors.push(`indications:${id} 급여 정보에는 확인일(reimbursementCheckedOn)이 필요합니다`);
      if (!['primary', 'secondary'].includes(entry.reimbursementSourceType)) {
        errors.push(`indications:${id} reimbursementSourceType 은 primary 또는 secondary 여야 합니다`);
      }
      if (entry.noticeUrl && !isHttps(entry.noticeUrl)) errors.push(`indications:${id} noticeUrl 은 https 여야 합니다`);
      for (const code of entry.reimbursementCodes || []) {
        if (!/^[A-Z]\d{2,5}$/.test(code)) errors.push(`indications:${id} 급여 상병코드 형식 오류: ${code}`);
      }
    }
    // 급여 근거 없이 상세 문구만 남으면 출처 없는 급여 안내가 된다.
    if (!entry.reimbursementScope && (entry.reimbursementDetails || entry.reimbursementCodes)) {
      errors.push(`indications:${id} reimbursementScope 없이 급여 상세만 존재합니다`);
    }
    for (const block of entry.blocks || []) {
      if (!block.codes || !block.codes.length) errors.push(`indications:${id}/${block.block} 완전코드가 없습니다`);
      for (const code of block.codes || []) {
        if (!/^[A-Z]\d{2,5}$/.test(code.code || '')) errors.push(`indications:${id}/${block.block} 상병코드 형식 오류: ${code.code}`);
        if (!code.nameKo) errors.push(`indications:${id}/${block.block} ${code.code} 한글명 누락`);
      }
      // 블록 자신이 불완전코드인데 코드 목록에 그대로 들어가면 청구 불가 코드를 제시하게 된다.
      if (block.blockComplete === false && (block.codes || []).some((c) => c.code === block.block)) {
        errors.push(`indications:${id}/${block.block} 불완전코드가 제시 목록에 포함되었습니다`);
      }
    }
  }
}

// ---------------------------------------------------------------- 최신성 (경고)

const staleDays = (dateText) => Math.floor((Date.now() - Date.parse(`${dateText}T00:00:00Z`)) / 86400000);
if (isDate(billing.source?.effectiveDate)) {
  const days = staleDays(billing.source.effectiveDate);
  if (days > 90) warnings.push(`billing.json: 고시 시행일 ${billing.source.effectiveDate} 기준 ${days}일 경과 — 약가·급여 개정본 확인 필요`);
}
if (isDate(items.generatedOn)) {
  const days = staleDays(items.generatedOn);
  if (days > 90) warnings.push(`items.json: 생성일 ${items.generatedOn} 기준 ${days}일 경과 — 재생성 필요`);
}

// ---------------------------------------------------------------- 결과

if (warnings.length) {
  console.warn(`WARNINGS (${warnings.length})`);
  warnings.forEach((warning) => console.warn(`! ${warning}`));
}
if (errors.length) {
  console.error(`VALIDATION FAILED (${errors.length})`);
  errors.forEach((error) => console.error(`- ${error}`));
  process.exit(1);
}

const listed = (billing.items || []).filter((entry) => entry.benefitStatus === 'listed').length;
console.log([
  'VALIDATION PASSED',
  `products=${allProducts.length}`,
  `items=${(items.items || []).length}`,
  `packages=${kdCodes.size}`,
  `listed=${listed}`,
  `not-listed=${(billing.items || []).length - listed}`,
  `changes=${(changes.changes || []).length}`,
  `literature=${(literature.items || []).length}`,
  `warnings=${warnings.length}`,
].join(' · '));
