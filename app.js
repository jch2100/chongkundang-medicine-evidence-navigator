/* 종근당 의약품 근거 탐색 허브 — 화면 로직
   데이터 계약: docs/DATA_DICTIONARY.md
   원칙: 데이터에 있는 값만 표시한다. 허가사항·적응증·부작용 문구를 생성하지 않는다. */

const RX_DISCLAIMER = '코드와 금액은 참고용입니다. 실제 청구는 심평원 고시 원문과 의료진 판단을 따릅니다.';
const NOT_LISTED_LABEL = '급여목록 미등재 (비급여 여부는 별도 확인)';
const KCD_DISCLAIMER = '상병코드는 허가 적응증에 대응하는 참고 매핑입니다. 실제 청구 상병은 환자 상태와 심평원 고시 기준에 따라 의료진이 판단합니다.';
/* 코드가 이보다 많으면 블록을 모두 접은 채로 연다 (사이폴은 300개 가까이 된다). */
const KCD_AUTO_OPEN_LIMIT = 20;

const state = {
  products: [],
  changes: [],
  literature: [],
  faqTemplates: [],
  core: {},
  run: null,
  items: [],
  itemsByBrand: new Map(),
  billingByKey: new Map(),
  billingSource: null,
  itemsSource: null,
  usingFixtures: [],
  indications: null,
  indicationsPromise: null,
  indicationsFailed: false,
  kcdQuery: '',
  query: '',
  category: 'all',
  flags: new Set(),
  categoryMoreOpen: false,
  showCancelled: false,
  selected: null
};

const $ = (selector) => document.querySelector(selector);
const escapeHtml = (value) => String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
const safeUrl = (value) => (/^https?:\/\//i.test(value || '') ? value : '#');
const isMobile = () => window.matchMedia('(max-width: 900px)').matches;

async function loadJson(path) {
  const response = await fetch(path, { cache: 'no-store' });
  if (!response.ok) throw new Error(`${path} (${response.status})`);
  return response.json();
}

/* 백엔드 산출물(items.json / billing.json)이 나오기 전까지는 픽스처로 폴백한다.
   items.json 한 번만 탐색해 404 요청 수를 최소화한다. 두 파일은 같이 생성된다. */
async function loadRxData() {
  try {
    const items = await loadJson('./data/public/items.json');
    const billing = await loadJson('./data/public/billing.json').catch(() => null);
    return { items, billing };
  } catch (error) {
    state.usingFixtures.push('items', 'billing');
    const [items, billing] = await Promise.all([
      loadJson('./data/public/fixtures/items.sample.json').catch(() => null),
      loadJson('./data/public/fixtures/billing.sample.json').catch(() => null)
    ]);
    return { items, billing };
  }
}

/* ---------- 파생 값 ---------- */

/* 함량 표기는 itemName 기준 (DATA_DICTIONARY §2). 약가마스터 규격은 업체마다 기준이 달라 신뢰하지 않는다. */
const STRENGTH_UNIT = '(?:mg|밀리그램|㎎|mcg|마이크로그램|㎍|g|그램|mL|ml|밀리리터|IU|단위|%)';
/* 복합제는 앞 성분에 단위가 생략된다: '텔미트렌에스정40/10밀리그램' → '40/10밀리그램'.
   단위 앞의 '숫자/숫자…' 묶음을 함께 잡지 않으면 앞 성분 함량이 통째로 잘린다. */
const STRENGTH_RE = new RegExp(`\\d[\\d.,]*(?:\\s*\\/\\s*\\d[\\d.,]*)*\\s*${STRENGTH_UNIT}(?:\\s*\\/\\s*\\d[\\d.,]*\\s*${STRENGTH_UNIT})*`, 'i');

function strengthCell(item) {
  const match = STRENGTH_RE.exec(item.itemName || '');
  if (match) return escapeHtml(match[0].replace(/\s+/g, ''));
  /* 품목명에 함량 표기가 없을 때만 약가마스터 규격을 쓰고, 출처가 다름을 명시한다. */
  if (item.strengthLabel) return `${escapeHtml(item.strengthLabel)}<span class="strength-src">약가마스터 규격</span>`;
  return '<span class="code-empty">—</span>';
}

function realPackages(item) {
  return (item.packages || []).filter((pkg) => pkg.kdCode && Number(pkg.quantity) > 0);
}

function brandItems(brandId, { includeCancelled = state.showCancelled } = {}) {
  const items = state.itemsByBrand.get(brandId) || [];
  return includeCancelled ? items : items.filter((item) => !item.cancelDate);
}

function searchIndex(product) {
  const items = brandItems(product.id, { includeCancelled: true });
  return [
    product.name, product.displayName, product.ingredient, product.dartCategory,
    product.ckdCategory, product.searchTerms, state.core?.[product.id]?.ingredient,
    ...items.map((item) => `${item.itemName} ${item.company} ${item.ingredientNameEn || ''} ${item.atcCode || ''}`)
  ].join(' ').toLowerCase();
}

/* 코드 역검색: 숫자만 입력했을 때 보험코드·표준코드·품목기준코드를 모두 훑는다. */
function codeHits(product, digits) {
  const hits = [];
  brandItems(product.id, { includeCancelled: true }).forEach((item) => {
    const billing = state.billingByKey.get(item.itemKey) || {};
    if (billing.ediCode && billing.ediCode.includes(digits)) hits.push({ kind: '보험코드', code: billing.ediCode, item });
    if (item.representativeCode && item.representativeCode.includes(digits)) hits.push({ kind: '표준코드', code: item.representativeCode, item });
    realPackages(item).forEach((pkg) => {
      if (pkg.kdCode.includes(digits)) hits.push({ kind: '표준코드', code: pkg.kdCode, item });
    });
    if (item.itemSeq && item.itemSeq.includes(digits)) hits.push({ kind: '품목기준코드', code: item.itemSeq, item });
  });
  return hits;
}

function queryDigits(query) {
  const digits = query.replace(/[^0-9]/g, '');
  return /^[0-9\s-]+$/.test(query) && digits.length >= 4 ? digits : null;
}

function hasChanges(product) {
  return state.changes.some((change) => change.productId === product.id);
}

function scopeOf(product) {
  return product.scope || 'ETC';
}

function ownershipOf(product) {
  const items = brandItems(product.id, { includeCancelled: true });
  const ckd = items.filter((item) => item.isCkd);
  return {
    total: items.length,
    hasCkdItem: ckd.length > 0,
    companies: [...new Set(items.map((item) => item.company))]
  };
}

/* ---------- 목록 ---------- */

function matchedProducts() {
  const query = state.query.trim().toLowerCase();
  const digits = queryDigits(state.query.trim());
  return state.products
    .map((product) => {
      const hits = digits ? codeHits(product, digits) : [];
      const textMatch = !query || searchIndex(product).includes(query);
      const matched = digits ? hits.length > 0 : textMatch;
      return { product, hits, matched };
    })
    .filter((entry) => {
      if (!entry.matched) return false;
      const product = entry.product;
      if (state.category !== 'all' && product.ckdCategory !== state.category) return false;
      for (const flag of state.flags) {
        if (flag === 'ETC' && scopeOf(product) !== 'ETC') return false;
        if (flag === 'OTC' && scopeOf(product) !== 'OTC') return false;
        if (flag === '공동판매' && product.ownershipTag !== '공동판매') return false;
        if (flag === '변경' && !hasChanges(product)) return false;
        if (flag === '코드' && brandItems(product.id).length === 0) return false;
      }
      return true;
    });
}

function resultCardHtml({ product, hits }) {
  const core = state.core[product.id] || {};
  const ingredient = core.ingredient || product.ingredient;
  const items = brandItems(product.id);
  const listed = items.filter((item) => (state.billingByKey.get(item.itemKey) || {}).benefitStatus === 'listed').length;
  const codeLine = items.length
    ? `함량·품목 ${items.length}건${listed ? ` · 급여코드 ${listed}건` : ''}`
    : '처방·청구 데이터 준비 중';
  const hit = hits[0];
  return `
    <button class="result-card${state.selected === product.id ? ' selected' : ''}" data-product-id="${escapeHtml(product.id)}" type="button" aria-pressed="${state.selected === product.id}">
      <span class="result-name">${escapeHtml(product.name)}</span>
      <span class="result-sub">${escapeHtml(ingredient || product.dartCategory || '성분 확인 필요')}</span>
      <span class="result-tags">
        ${product.ckdCategory ? `<span class="chip">${escapeHtml(product.ckdCategory)}</span>` : ''}
        <span class="chip">${escapeHtml(scopeOf(product) === 'OTC' ? '일반' : '전문')}</span>
        ${product.ownershipTag === '공동판매' ? '<span class="chip chip-alt">공동판매</span>' : ''}
        ${hasChanges(product) ? '<span class="chip chip-alt">변경 이력</span>' : ''}
      </span>
      <span class="result-codes${items.length ? '' : ' muted'}">${escapeHtml(codeLine)}</span>
      ${hit ? `<span class="result-hit">${escapeHtml(hit.kind)} ${escapeHtml(hit.code)} 일치 · ${escapeHtml(hit.item.itemName)}</span>` : ''}
    </button>`;
}

function renderResults() {
  const entries = matchedProducts();
  const list = $('#resultList');
  $('#resultCount').textContent = `${entries.length}개`;
  $('#resultLive').textContent = `검색 결과 ${entries.length}개`;
  if (!entries.length) {
    list.innerHTML = '<p class="no-results">조건에 맞는 제품이 없습니다.<br>제품명·성분명·보험코드(9자리)·표준코드(13자리)를 확인해 주세요.</p>';
    return;
  }
  list.innerHTML = entries.map(resultCardHtml).join('');
  list.querySelectorAll('[data-product-id]').forEach((button) => {
    button.addEventListener('click', () => selectProduct(button.dataset.productId));
  });
}

/* ---------- 처방·청구 ---------- */

function copyButton(code, kind) {
  if (!code) return '<span class="code-empty">—</span>';
  return `<button class="copy-btn" type="button" data-copy="${escapeHtml(code)}" data-kind="${escapeHtml(kind)}" aria-label="${escapeHtml(kind)} ${escapeHtml(code)} 복사">
      <span class="code-text">${escapeHtml(code)}</span><span class="copy-tag" aria-hidden="true">복사</span>
    </button>`;
}

function priceCell(billing, effectiveDate) {
  if (!billing || billing.benefitStatus !== 'listed' || billing.maxPrice == null) return '<span class="code-empty">—</span>';
  return `<span class="price">${Number(billing.maxPrice).toLocaleString('ko-KR')}원</span>
    <span class="price-unit">${escapeHtml(billing.priceUnit || '')}</span>
    ${effectiveDate ? `<span class="price-date">${escapeHtml(effectiveDate)} 시행</span>` : ''}`;
}

function benefitCell(billing) {
  if (!billing) return '<span class="badge badge-wait">급여 정보 미연결</span>';
  if (billing.benefitStatus === 'listed') return '<span class="badge badge-listed">급여</span>';
  return `<span class="badge badge-unlisted">${escapeHtml(NOT_LISTED_LABEL)}</span>`;
}

function packageList(item) {
  const packages = realPackages(item);
  if (!packages.length) return '';
  return `<details class="pack-details">
      <summary>포장별 표준코드 ${packages.length}종</summary>
      <ul class="pack-list">
        ${packages.map((pkg) => `<li><span class="pack-qty">${escapeHtml(String(pkg.quantity))}${escapeHtml(pkg.dosageForm || '')}${pkg.packageType ? ` ${escapeHtml(pkg.packageType)}` : ''}</span>${copyButton(pkg.kdCode, '표준코드')}</li>`).join('')}
      </ul>
    </details>`;
}

function rxRow(item, effectiveDate) {
  const billing = state.billingByKey.get(item.itemKey);
  return `<tr role="row"${item.cancelDate ? ' class="row-cancelled"' : ''}>
      <td role="cell" data-label="품목명">
        <span class="item-name">${escapeHtml(item.itemName)}</span>
        ${item.cancelDate ? `<span class="badge badge-cancel">허가취소 ${escapeHtml(item.cancelDate)}</span>` : ''}
      </td>
      <td role="cell" data-label="함량">${strengthCell(item)}</td>
      <td role="cell" data-label="보험코드">${copyButton(billing && billing.ediCode, '보험코드')}</td>
      <td role="cell" data-label="표준코드">
        ${copyButton(item.representativeCode, '표준코드')}
        ${packageList(item)}
      </td>
      <td role="cell" data-label="상한금액">${priceCell(billing, effectiveDate)}</td>
      <td role="cell" data-label="급여구분">${benefitCell(billing)}</td>
    </tr>`;
}

function rxTable(items, effectiveDate) {
  return `<div class="rx-table-wrap">
    <table class="rx-table" role="table">
      <thead>
        <tr role="row">
          <th role="columnheader" scope="col">품목명</th>
          <th role="columnheader" scope="col">함량</th>
          <th role="columnheader" scope="col">보험코드</th>
          <th role="columnheader" scope="col">표준코드</th>
          <th role="columnheader" scope="col">상한금액</th>
          <th role="columnheader" scope="col">급여구분</th>
        </tr>
      </thead>
      <tbody>${items.map((item) => rxRow(item, effectiveDate)).join('')}</tbody>
    </table>
  </div>`;
}

function rxSection(product) {
  const all = brandItems(product.id, { includeCancelled: true });
  const items = brandItems(product.id);
  const cancelledCount = all.length - all.filter((item) => !item.cancelDate).length;
  const effectiveDate = state.billingSource ? state.billingSource.effectiveDate : null;
  const ownership = ownershipOf(product);

  if (!all.length) {
    return `<section class="detail-section" id="rx">
      <h3>처방·청구</h3>
      <p class="notice">${product.ownershipTag === '공동판매' ? '공동판매 품목입니다. <strong>허가권자와 판매사가 다릅니다.</strong><br>' : ''}이 브랜드의 품목 코드(보험코드·표준코드)는 아직 데이터에 연결되지 않았습니다. 확정 전 값을 추정하지 않습니다.</p>
      <p class="rx-disclaimer">${escapeHtml(RX_DISCLAIMER)}</p>
    </section>`;
  }

  /* 공동판매·타사 허가 품목은 명의별로 나눠 표시한다 (DATA_DICTIONARY §7). */
  const groups = [];
  items.forEach((item) => {
    let group = groups.find((entry) => entry.company === item.company);
    if (!group) { group = { company: item.company, isCkd: item.isCkd, items: [] }; groups.push(group); }
    group.items.push(item);
  });
  groups.sort((a, b) => Number(b.isCkd) - Number(a.isCkd));

  const notices = [];
  if (!ownership.hasCkdItem) {
    notices.push('이 브랜드에는 <strong>종근당 명의의 품목 코드가 없습니다.</strong> 아래 코드는 허가권자 명의 기준입니다.');
  } else if (groups.length > 1) {
    notices.push('허가(품목기준코드)는 공유하고 표준코드는 명의별로 다릅니다. <strong>보험코드가 한쪽에만 부여</strong>될 수 있습니다.');
  }
  if (product.ownershipTag === '공동판매') {
    notices.push('공동판매 품목입니다. <strong>허가권자와 판매사가 다릅니다.</strong>');
  }

  const showGroupHeads = groups.length > 1 || !groups[0].isCkd;

  return `<section class="detail-section rx-section" id="rx">
    <div class="rx-head">
      <h3>처방·청구</h3>
      ${effectiveDate ? `<span class="rx-basis">고시 시행일 ${escapeHtml(effectiveDate)}</span>` : ''}
    </div>
    ${notices.length ? `<div class="notice">${notices.join('<br>')}</div>` : ''}
    ${groups.map((group) => `
      ${showGroupHeads ? `<h4 class="rx-group">${escapeHtml(group.company)} <span>${group.isCkd ? '종근당 명의' : '허가권자·타사 명의'}</span></h4>` : ''}
      ${rxTable(group.items, effectiveDate)}
    `).join('')}
    ${cancelledCount ? `<button class="link-button" type="button" id="toggleCancelled">${state.showCancelled ? '허가취소 품목 숨기기' : `허가취소 품목 ${cancelledCount}건 보기`}</button>` : ''}
    <p class="rx-source">${escapeHtml(state.billingSource ? state.billingSource.noticeName : '약제 급여 목록 및 급여 상한금액표')} · ${escapeHtml(state.itemsSource ? state.itemsSource.standardCode : '약가마스터 의약품표준코드')}</p>
    ${hasReimbursement(product) ? '<p class="rx-crosslink"><a class="inline-link" href="#reimb">이 브랜드의 급여 기준 보기 ↓</a></p>' : ''}
    <p class="rx-disclaimer">${escapeHtml(RX_DISCLAIMER)}</p>
  </section>`;
}

/* ---------- FAQ (기존 템플릿 유지) ---------- */

function buildFaqAnswer(answerKey, product, core, changes) {
  if (answerKey === 'efficacy') {
    return core.status === 'confirmed'
      ? `${core.efficacy}로 식약처 품목정보에 표시되어 있습니다. 실제 적용 환자군과 세부 적응증은 해당 품목의 최신 허가사항을 기준으로 확인합니다.`
      : `현재는 DART 사업보고서의 제품군 표기인 “${product.dartCategory}”만 확인된 상태입니다. 종근당 제품과 식약처 품목의 1:1 매핑이 끝나면 허가된 적응증과 환자군을 확정합니다.`;
  }
  if (answerKey === 'ingredient') {
    return `${core.ingredient || '공식 품목 매핑 필요'}${product.formStrength ? ` · 화면에 연결된 표시 제품: ${product.formStrength}` : ''}. 제형별 품목이 다를 수 있어, 확정 상태가 아닌 값은 검토 중으로 표시했습니다.`;
  }
  if (answerKey === 'safety') {
    return '공식 허가 원문의 이상반응·금기·주의사항을 기준으로 확인해야 합니다. 이 화면은 환자별 위험도를 단정하거나 처방을 권고하지 않습니다.';
  }
  if (answerKey === 'dosing') {
    return `${product.formStrength ? `현재 연결된 표시 제품은 ${product.formStrength}입니다. ` : ''}정확한 투여 횟수·간격·용량은 제형과 환자 상태에 따라 달라지므로 최신 품목 허가사항의 용법·용량을 기준으로 확인합니다.`;
  }
  if (answerKey === 'changes') {
    return changes.length
      ? `본 MVP가 공식 게시물로 기록한 변경 확인 항목은 ${changes.map((item) => item.date).join(', ')}입니다. 변경 전·후 문구와 적용일은 게시 원문 기준으로 확인합니다.`
      : '사람 검토를 마쳐 공개한 최근 5년 변경 기록이 없습니다. 변경이 없다는 뜻이 아니라 원문 확인 전 항목을 확정하지 않았다는 뜻입니다.';
  }
  if (answerKey === 'research') {
    const reviewed = state.literature.filter((item) => item.productId === product.id && item.status === 'published').length;
    return reviewed
      ? `사람 검토를 마친 관련 연구 ${reviewed}건이 등록되어 있습니다.`
      : '사람이 확인해 공개한 논문은 아직 없습니다. PubMed 검색 링크에서 후보 논문을 찾은 뒤 검토합니다.';
  }
  return '공식 근거 확인 필요';
}

/* ---------- 상병코드(KCD) · 급여 기준 ----------
   200KB가 넘어 초기 로드에 넣지 않는다. 상세를 처음 열 때 한 번만 받아 캐시한다. */

function loadIndications() {
  if (state.indications || state.indicationsFailed) return null;
  if (state.indicationsPromise) return state.indicationsPromise;
  state.indicationsPromise = loadJson('./data/public/indications.json')
    .then((data) => {
      state.indications = new Map((data.items || []).map((item) => [item.brandId, item]));
      state.indicationsMeta = { source: data.source || null, generatedOn: data.generatedOn || null };
      return state.indications;
    })
    .catch(() => {
      state.indicationsFailed = true;
      return null;
    })
    .finally(() => { state.indicationsPromise = null; });
  return state.indicationsPromise;
}

/* 성별구분·하한연령·상한연령은 상병마스터 원본 값이다.
   sexLabel 은 생성 단계에서 해석한 값이며(X=여성, Y=남성), 원본값은 title 에 남긴다. */
function codeBadges(code) {
  const badges = [];
  if (code.sex) {
    const label = code.sexLabel ? `${escapeHtml(code.sexLabel)} 한정` : '성별 제한';
    badges.push(`<span class="kcd-badge" title="상병마스터 성별구분 값: ${escapeHtml(code.sex)}">${label}</span>`);
  }
  if (code.ageMin) badges.push(`<span class="kcd-badge">하한연령 ${escapeHtml(code.ageMin)}세</span>`);
  if (code.ageMax) badges.push(`<span class="kcd-badge">상한연령 ${escapeHtml(code.ageMax)}세</span>`);
  return badges.join('');
}

function codeMatchesKcdQuery(code, query) {
  if (!query) return true;
  return code.code.toLowerCase().includes(query) || (code.nameKo || '').toLowerCase().includes(query);
}

function kcdBlockHtml(block, query, autoOpen) {
  const codes = (block.codes || []).filter((code) => codeMatchesKcdQuery(code, query));
  if (query && !codes.length) return '';
  const open = query ? true : autoOpen;
  return `<details class="kcd-block"${open ? ' open' : ''}>
      <summary>
        <span class="kcd-block-code">${escapeHtml(block.block)}</span>
        <span class="kcd-block-name">${escapeHtml(block.blockName || '')}</span>
        <span class="kcd-block-meta">
          ${block.restricted ? '<span class="kcd-flag restricted">허가 범위로 축소</span>' : ''}
          ${block.blockComplete
            ? '<span class="kcd-flag complete">완전코드</span>'
            : '<span class="kcd-flag header">분류 헤더 · 단독 청구 불가</span>'}
          <span class="kcd-count">${codes.length}${query ? `/${(block.codes || []).length}` : ''}개</span>
        </span>
        ${block.restricted && block.note ? `<span class="kcd-block-restrict">${escapeHtml(block.note)}</span>` : ''}
      </summary>
      ${block.indicationLabel ? `<p class="kcd-block-label">적응증 표제어: ${escapeHtml(block.indicationLabel)}</p>` : ''}
      ${block.note && !block.restricted ? `<p class="kcd-block-note">${escapeHtml(block.note)}</p>` : ''}
      <ul class="kcd-code-list">
        ${codes.map((code) => `<li>
          ${copyButton(code.code, '상병코드')}
          <span class="kcd-name">${escapeHtml(code.nameKo || '')}</span>
          ${codeBadges(code)}
        </li>`).join('')}
      </ul>
    </details>`;
}

function hasReimbursement(product) {
  const entry = state.indications && state.indications.get(product.id);
  return Boolean(entry && entry.reimbursementScope);
}

/* 급여 기준 패널.
   reimbursementScope 가 null 이면 이 영역을 통째로 그리지 않는다.
   "급여 정보 없음" 같은 문구도 남기지 않는다 — 빈 값이 '제한 없음'으로 읽히면 안 된다. */
function reimbursementPanel(entry) {
  if (!entry || !entry.reimbursementScope) return '';
  const secondary = entry.reimbursementSourceType === 'secondary';
  const codes = entry.reimbursementCodes || [];
  return `<div class="reimb-panel" id="reimb">
    <div class="reimb-head">
      <h4>급여 기준</h4>
      <span class="reimb-source ${secondary ? 'secondary' : 'primary'}">${secondary ? '2차 자료 · 고시 원문 확인 필요' : '고시 원문 확인'}</span>
    </div>
    <p class="reimb-scope">${escapeHtml(entry.reimbursementScope)}</p>
    ${codes.length ? `<div class="reimb-codes">
      <span class="reimb-codes-title">급여 인정 상병 (분류)</span>
      <div class="reimb-code-chips">${codes.map((code) => `<span class="reimb-code">${escapeHtml(code)}</span>`).join('')}</div>
      <p class="reimb-codes-note">급여 인정 <strong>범위</strong>를 나타내는 분류입니다. 하위 세분류를 포함하며 <strong>청구 코드가 아닙니다.</strong> 청구용 완전코드는 아래 상병코드 후보 목록에서 확인하세요.</p>
    </div>` : ''}
    ${(entry.reimbursementDetails || []).length ? `<ul class="reimb-details">${entry.reimbursementDetails.map((line) => `<li>${escapeHtml(line)}</li>`).join('')}</ul>` : ''}
    <p class="reimb-basis">
      ${entry.noticeRef ? `<span>근거: ${escapeHtml(entry.noticeRef)}</span>` : ''}
      ${entry.reimbursementCheckedOn ? `<span>확인일 ${escapeHtml(entry.reimbursementCheckedOn)}</span>` : ''}
      ${entry.noticeUrl ? `<a class="inline-link" href="${escapeHtml(safeUrl(entry.noticeUrl))}" target="_blank" rel="noreferrer">고시·기준 원문 ↗</a>` : ''}
    </p>
    ${secondary ? '<p class="reimb-warn">이 내용은 고시 원문이 아니라 2차 자료로 확인했습니다. 청구 전 고시 원문을 대조하세요.</p>' : ''}
    <p class="reimb-warn">급여 기준은 수시로 개정됩니다. 확인일 이후 변경 여부를 확인하세요.</p>
  </div>`;
}

function kcdSection(product) {
  const head = `<div class="rx-head"><h3>상병코드(KCD) 후보</h3><span class="rx-basis wait">사람 검토 전</span></div>`;

  if (state.indicationsFailed) {
    return `<section class="detail-section" id="kcd">${head}
      <p class="notice">상병코드 데이터를 불러오지 못했습니다.</p></section>`;
  }
  if (!state.indications) {
    return `<section class="detail-section" id="kcd">${head}
      <p class="kcd-loading">상병코드 매핑을 불러오는 중입니다…</p></section>`;
  }

  const entry = state.indications.get(product.id);
  if (!entry) {
    return `<section class="detail-section" id="kcd">${head}
      <p class="notice">이 브랜드의 상병코드 후보는 아직 매핑되지 않았습니다. 확정 전 값을 추정하지 않습니다.</p>
      <p class="rx-disclaimer">${escapeHtml(KCD_DISCLAIMER)}</p></section>`;
  }

  const blocks = entry.blocks || [];
  const total = blocks.reduce((sum, block) => sum + (block.codes || []).length, 0);
  const query = state.kcdQuery.trim().toLowerCase();
  const shown = blocks.reduce((sum, block) => sum + (block.codes || []).filter((code) => codeMatchesKcdQuery(code, query)).length, 0);
  const autoOpen = total <= KCD_AUTO_OPEN_LIMIT;
  const body = blocks.map((block) => kcdBlockHtml(block, query, autoOpen)).join('');

  return `<section class="detail-section kcd-section" id="kcd">
    ${head}
    <p class="kcd-intro">검토자·검토일이 아직 없습니다(<code>reviewStatus: candidate</code>).</p>

    ${reimbursementPanel(entry)}

    ${entry.note ? `<div class="notice">${escapeHtml(entry.note)}</div>` : ''}

    <div class="kcd-indication">
      <h4 class="kcd-subhead">허가 적응증 기준 상병코드 후보</h4>
      <p class="kcd-intro">식약처 허가 효능·효과 표제어를 근거로 선정한 <strong>블록 후보</strong>입니다.${entry.reimbursementScope ? ' <strong>급여 인정 범위와 다릅니다.</strong> 위 급여 기준을 함께 확인하세요.' : ''}</p>
    ${(entry.indicationLabels || []).length ? `<div class="kcd-labels"><span class="kcd-labels-title">허가 적응증 표제어</span><div class="tag-list">${entry.indicationLabels.map((label) => `<span>${escapeHtml(label)}</span>`).join('')}</div></div>` : ''}
    <div class="kcd-toolbar">
      <label class="kcd-search" for="kcdSearch">
        <span class="visually-hidden">상병코드 또는 상병명으로 좁히기</span>
        <input id="kcdSearch" type="search" autocomplete="off" placeholder="코드·상병명으로 좁히기" value="${escapeHtml(state.kcdQuery)}">
      </label>
      <span class="kcd-total">${query ? `${shown} / ${total}` : `${total}`}개 완전코드 · 블록 ${blocks.length}개</span>
    </div>
    ${total > KCD_AUTO_OPEN_LIMIT && !query ? '<p class="kcd-hint">코드가 많아 블록을 접어 두었습니다. 블록을 열거나 위에서 검색하세요.</p>' : ''}
    <div class="kcd-blocks">${body || '<p class="no-results">일치하는 상병코드가 없습니다.</p>'}</div>
    ${entry.labelSourceUrl ? `<p class="kcd-source"><a class="inline-link" href="${escapeHtml(safeUrl(entry.labelSourceUrl))}" target="_blank" rel="noreferrer">식약처 허가사항 원문 보기 ↗</a></p>` : ''}
    </div>
    <p class="kcd-legend">복사 버튼은 단독 청구가 가능한 완전코드에만 있습니다. 블록(분류 헤더)은 복사 대상이 아닙니다. 성별·연령 배지는 심평원 상병마스터에 제한 값이 있는 코드입니다.</p>
    <p class="rx-disclaimer">${escapeHtml(KCD_DISCLAIMER)}</p>
  </section>`;
}

/* ---------- 상세 ---------- */

function sourceLink(label, type, url) {
  return `<a class="source-link" href="${escapeHtml(safeUrl(url))}" target="_blank" rel="noreferrer"><span>${escapeHtml(label)}</span><span class="source-type">${escapeHtml(type)} ↗</span></a>`;
}

function renderDetail(product) {
  const changes = state.changes.filter((change) => change.productId === product.id).sort((a, b) => b.date.localeCompare(a.date));
  const literature = state.literature.filter((item) => item.productId === product.id && item.status === 'published');
  const core = state.core[product.id] || {};
  const ownership = ownershipOf(product);
  const pubmedUrl = `https://pubmed.ncbi.nlm.nih.gov/?term=${encodeURIComponent(product.searchTerms || product.name)}`;

  const sourceItems = [];
  if (product.sources.ckd) sourceItems.push(sourceLink(`${product.displayName || product.name} · 종근당 제품 페이지`, '제품 원문', product.sources.ckd));
  if (core.source) sourceItems.push(sourceLink(core.sourceLabel || '식약처 의약품안전나라 · 품목 상세', '허가 원문', core.source));
  sourceItems.push(sourceLink('의약품안전나라 · 품목 검색', '허가 원문', product.sources.mfds));
  if (state.billingSource) sourceItems.push(sourceLink(`${state.billingSource.noticeName} (${state.billingSource.effectiveDate} 시행)`, '급여 원문', state.billingSource.url));
  sourceItems.push(sourceLink('PubMed · 관련 연구 검색', '연구 원문', pubmedUrl));
  if (product.sources.ckdNews) sourceItems.push(sourceLink('종근당 제품소식 · 허가 변경 게시판', '변경 원문', product.sources.ckdNews));
  if (product.sources.dart) sourceItems.push(sourceLink(`DART 2025 사업보고서${product.dartRank ? ` · 주요 제품 ${product.dartRank}위` : ''}`, '매출 근거', product.sources.dart));

  const faqItems = state.faqTemplates.map((template) => ({ ...template, answer: buildFaqAnswer(template.answerKey, product, core, changes) }));

  $('#detailPanel').innerHTML = `<article class="detail-card">
    <div class="detail-hero">
      <button class="back-button" type="button" id="backToList">← 목록</button>
      <h2>${escapeHtml(product.name)}</h2>
      <p class="detail-sub">${escapeHtml(core.ingredient || product.ingredient || '성분 확인 필요')}</p>
      <div class="tag-row">
        ${product.ckdCategory ? `<span class="tag">${escapeHtml(product.ckdCategory)}</span>` : ''}
        <span class="tag">${escapeHtml(scopeOf(product) === 'OTC' ? '일반의약품' : '전문의약품')}</span>
        ${product.ownershipTag === '공동판매' ? '<span class="tag tag-alt">공동판매</span>' : ''}
        ${ownership.total && !ownership.hasCkdItem ? '<span class="tag tag-alt">종근당 명의 코드 없음</span>' : ''}
        ${product.status === 'review' ? '<span class="tag tag-review">공식 매핑 검토 필요</span>' : ''}
      </div>
      ${ownership.companies.length ? `<p class="detail-owner">허가권자·업체: ${escapeHtml(ownership.companies.join(' / '))}</p>` : ''}
    </div>

    <nav class="detail-nav" aria-label="상세 목차">
      <a href="#rx">처방·청구</a>
      <a href="#kcd">상병코드</a>
      ${hasReimbursement(product) ? '<a href="#reimb">급여 기준</a>' : ''}
      <a href="#core">핵심 정보</a>
      <a href="#faq">현장 FAQ</a>
      <a href="#changes">변경 이력</a>
      <a href="#lit">관련 연구</a>
      <a href="#sources">원문 출처</a>
    </nav>

    <div class="detail-body">
      ${rxSection(product)}

      ${kcdSection(product)}

      ${product.status === 'review' ? '<p class="notice">공개 데이터셋에서 DART 제품명과 종근당 공식 제품 페이지의 1:1 매핑을 확인하지 못했습니다. 성분·적응증·변경사항을 추정하지 않고 원문 검색 링크만 제공합니다.</p>' : ''}

      <section class="detail-section" id="core">
        <div class="rx-head">
          <h3>핵심 정보</h3>
          <span class="rx-basis ${core.status === 'confirmed' ? 'ok' : 'wait'}">${core.status === 'confirmed' ? '품목 원문 확인' : '품목 매핑 검토 중'}</span>
        </div>
        <dl class="core-grid">
          <div><dt>효능·효과</dt><dd>${escapeHtml(core.efficacy || `DART 표기: ${product.dartCategory || '확인 필요'}`)}</dd></div>
          <div><dt>주성분</dt><dd>${escapeHtml(core.ingredient || product.ingredient || '공식 품목 매핑 필요')}</dd></div>
          <div><dt>종근당 분류</dt><dd>${escapeHtml(product.ckdCategory || '확인 필요')}</dd></div>
          <div><dt>제형·함량</dt><dd>${escapeHtml(product.formStrength || '아래 처방·청구 표 참조')}</dd></div>
        </dl>
        <p class="section-note">용법·용량, 금기·이상반응은 이 화면에서 단정하지 않습니다. 원문 출처의 허가사항을 확인하세요.</p>
      </section>

      <section class="detail-section" id="faq">
        <h3>현장 FAQ</h3>
        <div class="faq-list">
          ${faqItems.map((item) => `<details class="faq-item"><summary>${escapeHtml(item.question)}</summary><p>${escapeHtml(item.answer)}</p></details>`).join('')}
        </div>
      </section>

      <section class="detail-section" id="changes">
        <h3>최근 5년 허가 변경 이력</h3>
        ${changes.length
          ? changes.map((change) => `<div class="record-item"><div class="record-head"><span>${escapeHtml(change.date)}</span><span>${escapeHtml(change.type)}</span></div><h4>${escapeHtml(change.title)}</h4><p>${escapeHtml(change.summary)} <a class="inline-link" href="${escapeHtml(safeUrl(change.source))}" target="_blank" rel="noreferrer">원문 보기 ↗</a></p></div>`).join('')
          : '<p class="notice">본 데이터셋에서 사람 검토를 마친 변경 기록이 없습니다. 변경이 없다는 뜻은 아닙니다.</p>'}
      </section>

      <section class="detail-section" id="lit">
        <h3>관련 최신 연구</h3>
        ${literature.length
          ? literature.map((item) => `<div class="record-item"><div class="record-head"><span>${escapeHtml(item.publicationDate)}</span><span>PMID ${escapeHtml(item.pmid)}</span></div><h4>${escapeHtml(item.title)}</h4><div class="tag-list">${[...(item.diseases || []), ...(item.hashtags || [])].map((tag) => `<span>${escapeHtml(tag)}</span>`).join('')}</div><p>${escapeHtml(item.hcpSummary)}</p><p class="record-limit">한계: ${escapeHtml(item.limitations || '원문 초록과 연구설계를 함께 확인하세요.')}</p><a class="inline-link" href="${escapeHtml(safeUrl(item.url))}" target="_blank" rel="noreferrer">PubMed 원문 보기 ↗</a></div>`).join('')
          : `<p class="notice">검토를 마쳐 공개한 논문이 없습니다. <a class="inline-link" href="${escapeHtml(pubmedUrl)}" target="_blank" rel="noreferrer">${escapeHtml(product.name)} PubMed 검색 열기 ↗</a></p>`}
      </section>

      <section class="detail-section" id="sources">
        <h3>원문 출처</h3>
        <div class="source-list">${sourceItems.join('')}</div>
      </section>
    </div>
  </article>`;

  const backButton = $('#backToList');
  if (backButton) backButton.addEventListener('click', closeDetail);
  const cancelToggle = $('#toggleCancelled');
  if (cancelToggle) {
    cancelToggle.addEventListener('click', () => {
      state.showCancelled = !state.showCancelled;
      renderDetail(product);
      renderResults();
      const target = $('#rx');
      if (target) target.scrollIntoView({ block: 'start' });
    });
  }

  const kcdSearch = $('#kcdSearch');
  if (kcdSearch) {
    kcdSearch.addEventListener('input', (event) => {
      state.kcdQuery = event.target.value;
      renderKcdOnly(product);
    });
  }

  /* 상병코드는 상세를 처음 열 때 받아온다. 도착하면 해당 섹션만 다시 그린다. */
  const pending = loadIndications();
  if (pending) pending.then(() => { if (state.selected === product.id) renderKcdOnly(product); });
}

/* 상세 전체를 다시 그리면 스크롤 위치와 열린 블록이 초기화되므로 섹션만 교체한다. */
function renderKcdOnly(product) {
  const current = $('#kcd');
  if (!current) return;
  const active = document.activeElement === $('#kcdSearch');
  const caret = active ? $('#kcdSearch').selectionStart : null;
  current.outerHTML = kcdSection(product);
  const input = $('#kcdSearch');
  if (input) {
    input.addEventListener('input', (event) => {
      state.kcdQuery = event.target.value;
      renderKcdOnly(product);
    });
    if (active) {
      input.focus();
      if (caret !== null) input.setSelectionRange(caret, caret);
    }
  }
}

/* ---------- 선택 ---------- */

function selectProduct(id, { updateHash = true, scroll = true } = {}) {
  const product = state.products.find((item) => item.id === id);
  if (!product) return;
  state.selected = id;
  state.showCancelled = false;
  state.kcdQuery = '';
  if (updateHash) history.replaceState(null, '', `#product=${encodeURIComponent(id)}`);
  renderResults();
  renderDetail(product);
  document.body.classList.add('detail-open');
  if (scroll && isMobile()) window.scrollTo({ top: 0, behavior: 'auto' });
}

function closeDetail() {
  document.body.classList.remove('detail-open');
  state.selected = null;
  history.replaceState(null, '', location.pathname + location.search);
  renderResults();
  $('#detailPanel').innerHTML = '<div class="empty-detail"><p>왼쪽 목록에서 제품을 선택하면<br>처방·청구 정보와 공식 근거가 열립니다.</p></div>';
  if (isMobile()) window.scrollTo({ top: 0, behavior: 'auto' });
}

/* ---------- 복사 ---------- */

async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (error) { /* execCommand 폴백으로 내려간다 */ }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.top = '-1000px';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  } catch (error) {
    return false;
  }
}

let toastTimer = null;
function showToast(message) {
  const toast = $('#copyToast');
  toast.textContent = message;
  toast.classList.add('visible');
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.classList.remove('visible'), 1800);
}

/* ---------- 필터 / 이벤트 ---------- */

/* 분류는 14개까지 늘어난다. 제품 수가 많은 순으로 앞쪽 5개만 상시 노출하고
   나머지는 '+N개'로 접는다. 선택 중인 분류는 접힌 쪽이어도 앞으로 끌어올린다. */
const CATEGORY_VISIBLE = 5;

function renderCategoryFilters() {
  const counts = new Map();
  state.products.forEach((product) => {
    if (product.ckdCategory) counts.set(product.ckdCategory, (counts.get(product.ckdCategory) || 0) + 1);
  });
  const ordered = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'ko'))
    .map(([name]) => name);

  let primary = ordered.slice(0, CATEGORY_VISIBLE);
  let secondary = ordered.slice(CATEGORY_VISIBLE);
  if (secondary.includes(state.category)) {
    primary = [state.category, ...primary.slice(0, CATEGORY_VISIBLE - 1)];
    secondary = ordered.filter((name) => !primary.includes(name));
  }

  const chip = (value, label) => `<button class="filter-chip${state.category === value ? ' active' : ''}" type="button" aria-pressed="${state.category === value}" data-category="${escapeHtml(value)}">${escapeHtml(label)}</button>`;

  $('#categoryFilters').innerHTML = [
    chip('all', '전체'),
    ...primary.map((name) => chip(name, name)),
    secondary.length
      ? `<details class="filter-more"${state.categoryMoreOpen ? ' open' : ''}>
           <summary class="filter-chip" aria-label="분류 ${secondary.length}개 더 보기">+${secondary.length}</summary>
           <div class="filter-more-panel">${secondary.map((name) => chip(name, name)).join('')}</div>
         </details>`
      : ''
  ].join('');

  const more = $('#categoryFilters .filter-more');
  if (more) {
    more.addEventListener('toggle', () => {
      state.categoryMoreOpen = more.open;
      /* 모바일 칩 줄은 overflow-x: auto 라 절대배치 패널이 잘린다. 열릴 때만 흐름 배치로 바꾼다. */
      document.body.classList.toggle('filter-more-open', more.open);
    });
  }
  document.body.classList.toggle('filter-more-open', Boolean(more && more.open));
  $('#categoryFilters').querySelectorAll('[data-category]').forEach((button) => {
    button.addEventListener('click', () => {
      state.category = button.dataset.category;
      state.categoryMoreOpen = false;
      if (isMobile()) document.body.classList.remove('detail-open');
      renderCategoryFilters();
      renderResults();
    });
  });
}

function setupEvents() {
  const input = $('#searchInput');
  input.addEventListener('input', (event) => {
    state.query = event.target.value;
    $('#clearSearch').hidden = !state.query;
    /* 모바일에서 상세가 열려 있으면 검색 결과가 가려진다. 검색을 시작하면 목록으로 되돌린다. */
    if (isMobile()) document.body.classList.remove('detail-open');
    renderResults();
  });
  $('#clearSearch').addEventListener('click', () => {
    state.query = '';
    input.value = '';
    $('#clearSearch').hidden = true;
    input.focus();
    renderResults();
  });

  $('#flagFilters').querySelectorAll('[data-flag]').forEach((button) => {
    button.addEventListener('click', () => {
      const flag = button.dataset.flag;
      if (state.flags.has(flag)) state.flags.delete(flag); else state.flags.add(flag);
      if (flag === 'ETC') state.flags.delete('OTC');
      if (flag === 'OTC') state.flags.delete('ETC');
      $('#flagFilters').querySelectorAll('[data-flag]').forEach((item) => {
        const on = state.flags.has(item.dataset.flag);
        item.classList.toggle('active', on);
        item.setAttribute('aria-pressed', String(on));
      });
      if (isMobile()) document.body.classList.remove('detail-open');
      renderResults();
    });
  });

  document.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      input.focus();
      input.select();
    }
    if (event.key === 'Escape' && document.activeElement === input && state.query) {
      state.query = '';
      input.value = '';
      $('#clearSearch').hidden = true;
      renderResults();
    }
  });

  /* 목차 앵커는 해시를 바꾸지 않고 스크롤만 한다 (#product= 해시 보존). */
  document.addEventListener('click', (event) => {
    const link = event.target.closest('.detail-nav a, .rx-crosslink a');
    if (!link) return;
    const target = document.querySelector(link.getAttribute('href'));
    if (!target) return;
    event.preventDefault();
    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    target.setAttribute('tabindex', '-1');
    target.focus({ preventScroll: true });
  });

  /* 복사 버튼은 상세가 매번 다시 그려지므로 위임으로 처리한다. */
  document.addEventListener('click', async (event) => {
    const button = event.target.closest('.copy-btn');
    if (!button) return;
    const ok = await copyText(button.dataset.copy);
    showToast(ok ? `${button.dataset.kind} ${button.dataset.copy} 복사됨` : '복사에 실패했습니다. 코드를 길게 눌러 직접 선택하세요.');
    button.classList.toggle('copied', ok);
    window.setTimeout(() => button.classList.remove('copied'), 1200);
  });
}

/* ---------- 운영 패널 ---------- */

function renderOps() {
  if (!state.run) return;
  const failures = state.run.failures || [];
  $('#loopMetrics').innerHTML = [
    ['제품 레코드', state.products.length],
    ['공식 매핑', state.products.filter((item) => item.status === 'published').length],
    ['품목 코드', state.items.length],
    ['변경 이력', state.changes.length]
  ].map(([label, value]) => `<div class="ops-metric"><strong>${value}</strong><span>${escapeHtml(label)}</span></div>`).join('');
  $('#runSummary').textContent = state.run.summary;
  $('#failureList').innerHTML = failures.length
    ? failures.map((failure) => `<div class="failure-item"><strong>${escapeHtml(failure.product)}</strong> · ${escapeHtml(failure.reason)}</div>`).join('')
    : '<div class="failure-item ok">검토 큐가 비어 있습니다.</div>';
}

function renderBasis() {
  const parts = [];
  if (state.billingSource) parts.push(`급여 고시 ${state.billingSource.effectiveDate} 시행`);
  if (state.run) parts.push(`검증 ${state.run.runDate}`);
  if (state.usingFixtures.length) parts.push('개발용 샘플 데이터 사용 중');
  $('#dataBasis').textContent = parts.join(' · ') || '데이터 기준일 미확인';
  $('#dataBasis').classList.toggle('warn', state.usingFixtures.length > 0 || isStale());
}

function isStale() {
  if (!state.billingSource || !state.billingSource.effectiveDate) return false;
  const days = (Date.now() - new Date(state.billingSource.effectiveDate).getTime()) / 86400000;
  return days > 90;
}

/* ---------- 초기화 ---------- */

async function init() {
  setupEvents();
  try {
    const [products, additions, changes, literature, core, additionalCore, faq, run] = await Promise.all([
      loadJson('./data/public/products.json'),
      loadJson('./data/public/additional-products.json'),
      loadJson('./data/public/changes.json'),
      loadJson('./data/public/literature.json'),
      loadJson('./data/public/official-core.json'),
      loadJson('./data/public/additional-core.json'),
      loadJson('./data/public/faq-templates.json'),
      loadJson('./qa/runs/latest.json')
    ]);
    state.products = [...products.products, ...additions.products];
    state.changes = changes.changes;
    state.literature = literature.items;
    state.core = { ...core.items, ...additionalCore.items };
    state.faqTemplates = faq.items;
    state.run = run;

    const { items, billing } = await loadRxData();
    if (items) {
      state.items = items.items || [];
      state.itemsSource = items.source || null;
      state.items.forEach((item) => {
        if (!state.itemsByBrand.has(item.brandId)) state.itemsByBrand.set(item.brandId, []);
        state.itemsByBrand.get(item.brandId).push(item);
      });
    }
    if (billing) {
      state.billingSource = billing.source || null;
      (billing.items || []).forEach((entry) => state.billingByKey.set(entry.itemKey, entry));
    }

    renderBasis();
    renderOps();
    renderCategoryFilters();
    renderResults();

    const hashId = new URLSearchParams(location.hash.replace('#', '')).get('product');
    if (hashId && state.products.some((item) => item.id === hashId)) {
      selectProduct(hashId, { updateHash: false, scroll: false });
    } else if (!isMobile() && state.products.length) {
      selectProduct(state.products[0].id, { updateHash: false, scroll: false });
    }
  } catch (error) {
    $('#resultList').innerHTML = `<p class="no-results">데이터를 불러오지 못했습니다.<br><small>${escapeHtml(error.message)}</small><br><br>프로젝트 루트에서 로컬 서버로 열어주세요.</p>`;
    $('#dataBasis').textContent = '데이터 오류';
  }
}

init();
