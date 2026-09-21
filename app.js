const state = { products: [], changes: [], literature: [], faqTemplates: [], run: null, query: '', filter: 'all', selected: null };

const $ = (selector) => document.querySelector(selector);
const escapeHtml = (value) => String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
const safeUrl = (value) => /^https?:\/\//i.test(value || '') ? value : '#';
const formatMoney = (value) => value ? `${Number(value).toLocaleString('ko-KR')}백만원` : '추가 편입 품목';

async function loadJson(path) {
  const response = await fetch(path, { cache: 'no-store' });
  if (!response.ok) throw new Error(`${path} (${response.status})`);
  return response.json();
}

function filteredProducts() {
  const query = state.query.trim().toLowerCase();
  return state.products.filter((product) => {
    const searchable = [product.name, product.displayName, product.ingredient, product.dartCategory, product.ckdCategory, product.searchTerms].join(' ').toLowerCase();
    const queryMatch = !query || searchable.includes(query);
    const hasChange = state.changes.some((change) => change.productId === product.id);
    const filterMatch = state.filter === 'all'
      || (state.filter === '변경 이력' && hasChange)
      || (state.filter === '공동판매' && product.ownershipTag === '공동판매')
      || (state.filter === 'ETC' && (product.scope || 'ETC') === 'ETC')
      || (state.filter === 'OTC' && product.scope === 'OTC')
      || product.ckdCategory === state.filter;
    return queryMatch && filterMatch;
  });
}

function renderResults() {
  const list = $('#resultList');
  const products = filteredProducts();
  $('#resultCount').textContent = `${products.length}개`;
  if (!products.length) { list.innerHTML = '<div class="no-results">조건에 맞는 제품이 없습니다.<br>검색어 또는 분류를 바꿔보세요.</div>'; return; }
  list.innerHTML = products.map((product) => `
    <button class="result-card ${state.selected === product.id ? 'selected' : ''}" data-product-id="${escapeHtml(product.id)}" type="button">
      <div class="result-top"><span class="result-name">${escapeHtml(product.name)}</span><span class="rank">${product.dartRank ? `#${product.dartRank}` : escapeHtml(product.scope || '추가')}</span></div>
      <div class="result-meta">${escapeHtml(product.dartCategory)} · ${formatMoney(product.dartSales)}</div>
      <div class="result-fact"><span>성분</span><strong>${escapeHtml(state.core?.[product.id]?.ingredient || product.ingredient || '확인 필요')}</strong></div>
      <div class="result-fact"><span>효능</span><strong>${escapeHtml(state.core?.[product.id]?.efficacy || product.dartCategory)}</strong></div>
      <div class="result-research">관련 연구 ${state.literature.filter((item) => item.productId === product.id && item.status === 'published').length}건 · ${escapeHtml(product.scope || 'ETC')}</div>
      <span class="mini-status ${product.status === 'review' ? 'review' : ''}">${product.status === 'review' ? '공식 매핑 검토 필요' : '공식 원문 매핑'}</span>
    </button>`).join('');
  list.querySelectorAll('[data-product-id]').forEach((button) => button.addEventListener('click', () => selectProduct(button.dataset.productId)));
}

function sourceLink(label, type, url) {
  return `<a class="source-link" href="${escapeHtml(safeUrl(url))}" target="_blank" rel="noreferrer"><span>${escapeHtml(label)}</span><span class="source-type">${escapeHtml(type)} ↗</span></a>`;
}

function buildFaqAnswer(answerKey, product, core, changes, literature) {
  if (answerKey === 'efficacy') {
    return core.status === 'confirmed'
      ? `${core.efficacy}로 식약처 품목정보에 표시되어 있습니다. 실제 적용 환자군과 세부 적응증은 해당 품목의 최신 허가사항을 기준으로 확인합니다.`
      : `현재는 DART 사업보고서의 제품군 표기인 “${product.dartCategory}”만 확인된 상태입니다. 종근당 제품과 식약처 품목의 1:1 매핑이 끝나면 허가된 적응증과 환자군을 확정합니다.`;
  }
  if (answerKey === 'ingredient') {
    return `${core.ingredient || '공식 품목 매핑 필요'}${product.formStrength ? ` · 화면에 연결된 표시 제품: ${product.formStrength}` : ''}. 제품군·제형에 따라 품목이 달라질 수 있어, 확정 상태가 아닌 값은 검토 중으로 표시했습니다.`;
  }
  if (answerKey === 'safety') {
    return '공식 허가 원문의 이상반응·금기·주의사항을 기준으로 확인해야 합니다. 이 화면은 환자별 위험도를 단정하거나 처방을 권고하지 않으며, 의료진 질문에는 최신 품목 원문과 환자 상태를 함께 확인하는 방식으로 답변합니다.';
  }
  if (answerKey === 'dosing') {
    return `${product.formStrength ? `현재 연결된 표시 제품은 ${product.formStrength}입니다. ` : ''}정확한 투여 횟수·간격·용량은 제형과 환자 상태에 따라 달라질 수 있으므로 최신 품목 허가사항의 용법·용량을 기준으로 확인합니다.`;
  }
  if (answerKey === 'changes') {
    return changes.length ? `최근 5년 범위에서 본 MVP가 공식 게시물로 기록한 변경 확인 항목은 ${changes.map((item) => item.date).join(', ')}입니다. 변경 전·후의 세부 문구와 적용일은 게시 원문 기준으로 확인합니다.` : '현재 본 MVP에서 사람 검토를 마쳐 공개한 최근 5년 변경 기록은 없습니다. 이는 변경이 없다는 뜻이 아니라, 원문 확인 전 항목을 확정하지 않았다는 뜻입니다.';
  }
  if (answerKey === 'research') {
    const reviewed = literature.filter((item) => item.productId === product.id && item.status === 'published').length;
    return reviewed ? `사람 검토를 마친 관련 연구 ${reviewed}건이 등록되어 있습니다.` : '현재 사람 검토를 마쳐 공개한 논문은 없습니다. PubMed 검색 링크에서 후보 논문을 찾은 뒤, 질환 관련성·성분 관련성·HCP 요약을 검토하고 공개합니다.';
  }
  return '공식 근거 확인 필요';
}

function renderDetail(product) {
  const changes = state.changes.filter((change) => change.productId === product.id).sort((a, b) => b.date.localeCompare(a.date));
  const literature = state.literature.filter((item) => item.productId === product.id && item.status === 'published');
  const core = state.core[product.id] || {};
  const faqItems = state.faqTemplates.map((template) => ({ ...template, answer: buildFaqAnswer(template.answerKey, product, core, changes, state.literature) }));
  const pubmedUrl = `https://pubmed.ncbi.nlm.nih.gov/?term=${encodeURIComponent(product.searchTerms || product.name)}`;
  const sourceItems = [sourceLink(`DART 2025 사업보고서 · ${product.dartRank ? '주요 제품 및 서비스' : '참고 원문'}`, '매출 근거', product.sources.dart)];
  if (product.sources.ckd) sourceItems.push(sourceLink(`${product.displayName || product.name} · 종근당 공식 제품 페이지`, '제품 원문', product.sources.ckd));
  if (core.source) sourceItems.push(sourceLink(core.sourceLabel || '식약처 의약품안전나라 · 품목 상세', '허가 원문', core.source));
  sourceItems.push(sourceLink('의약품안전나라 · 식약처 공식 검색', '허가 원문', product.sources.mfds));
  sourceItems.push(sourceLink('PubMed · 관련 연구 검색', '연구 원문', pubmedUrl));
  if (product.sources.ckdNews) sourceItems.push(sourceLink('종근당 제품소식 · 허가 변경 게시판', '변경 원문', product.sources.ckdNews));

  $('#detailPanel').innerHTML = `<div class="detail-card">
    <div class="detail-hero">
      <p class="section-kicker">PRODUCT EVIDENCE CARD</p>
      <h2>${escapeHtml(product.name)}</h2>
      <p>${escapeHtml(product.dartCategory)} · ${product.dartRank ? `DART ${product.dartRank}위` : `${escapeHtml(product.scope || 'ETC')} 추가 편입`} · ${formatMoney(product.dartSales)}</p>
      <div class="tag-row"><span class="tag ${product.status === 'review' ? 'status-review' : 'status-ok'}">${product.status === 'review' ? '공식 매핑 검토 필요' : '공식 원문 확인 가능'}</span>${product.ownershipTag ? `<span class="tag">${escapeHtml(product.ownershipTag)}</span>` : ''}<span class="tag">최근 5년 변경 기준</span></div>
    </div>
    <div class="detail-body">
      <dl class="fact-grid">
        <div class="fact"><dt>DART 보고서 용도</dt><dd>${escapeHtml(product.dartCategory)}</dd></div>
        <div class="fact"><dt>종근당 분류</dt><dd>${escapeHtml(product.ckdCategory || '확인 필요')}</dd></div>
        <div class="fact"><dt>성분명</dt><dd>${escapeHtml(core.ingredient || product.ingredient || '공식 원문 확인')}</dd></div>
        <div class="fact"><dt>제형·함량</dt><dd>${escapeHtml(product.formStrength || '공식 원문 확인')}</dd></div>
      </dl>
      ${product.status === 'review' ? `<div class="notice" style="margin-top:1rem"><strong>검토 필요</strong>현재 공개 데이터셋에서는 DART 제품명과 종근당 공식 제품 페이지의 1:1 매핑을 확인하지 못했습니다. 성분·적응증·변경사항을 추정하지 않고 원문 검색 링크만 제공합니다.</div>` : ''}
      <section class="core-info-section" aria-label="핵심 의약품 정보">
        <div class="core-info-heading"><div><p class="section-kicker">AT A GLANCE</p><h3>핵심 정보</h3></div><span class="core-source-state ${core.status === 'confirmed' ? 'confirmed' : 'candidate'}">${core.status === 'confirmed' ? '품목 원문 확인' : '품목 매핑 검토 중'}</span></div>
        <div class="core-info-grid">
          <div class="core-info-card"><span>효능·효과</span><strong>${escapeHtml(core.efficacy || `DART 표기: ${product.dartCategory}`)}</strong><small>${core.status === 'confirmed' ? '식약처 품목정보 또는 종근당 제품 페이지 표기' : '허가 적응증 확정 전 · DART 분류와 구분'}</small></div>
          <div class="core-info-card"><span>주성분</span><strong>${escapeHtml(core.ingredient || '공식 품목 매핑 필요')}</strong><small>${core.status === 'confirmed' ? '식약처 품목정보 기준' : '동일명·제품군 혼동 방지를 위해 보류'}</small></div>
          <div class="core-info-card safety-card"><span>안전·이상반응</span><strong>허가 원문 기준 확인</strong><small>이상반응·금기·주의는 최신 식약처 품목 원문의 해당 항목을 기준으로 확인합니다. 환자별 해석은 의료진 판단 영역입니다.</small></div>
          <div class="core-info-card"><span>용법·용량</span><strong>허가 원문 기준 확인</strong><small>제형·함량별 용법이 다를 수 있어 제품 품목 단위로 확인하도록 설계했습니다.</small></div>
        </div>
        <p class="core-info-note">핵심값은 화면에 직접 표시하고, 원문 링크는 검증·업데이트를 위한 근거로 남깁니다. 현재 MVP는 공식 매핑이 끝난 값만 확정 표현합니다.</p>
      </section>
      <section class="detail-section"><div class="faq-heading"><div><p class="section-kicker">FIELD FAQ</p><h3>현장 질문과 공식 기준 답변</h3></div><span>답변 기준: ${core.status === 'confirmed' ? '품목 원문 확인' : '검토 중'}</span></div><p class="section-description">질문만 남기지 않고, 현재 확인된 공식 근거와 확인 한계를 함께 답합니다.</p><div class="faq-list">${faqItems.map((item) => `<div class="faq-item"><div class="faq-question"><span>Q</span><strong>${escapeHtml(item.question)}</strong></div><p><b>A.</b> ${escapeHtml(item.answer)}</p></div>`).join('')}</div></section>
      <section class="detail-section"><h3>허가·제품 확인 원문</h3><p class="section-description">아래 링크를 기준으로 확인하고, 비공식 해석은 별도 판단 영역으로 분리합니다.</p><div class="source-list">${sourceItems.join('')}</div></section>
      <section class="detail-section"><h3>최근 5년 허가 변경 이력</h3><p class="section-description">변경 전후의 세부 내용은 원문 변경대비표에서 확인하세요. 이 화면은 확인 경로와 게시 상태를 기록합니다.</p>${changes.length ? changes.map((change) => `<div class="change-item"><div class="change-head"><span>${escapeHtml(change.date)}</span><span>${escapeHtml(change.type)}</span></div><h4>${escapeHtml(change.title)}</h4><p>${escapeHtml(change.summary)} <a class="inline-link" href="${escapeHtml(safeUrl(change.source))}" target="_blank" rel="noreferrer">원문 보기 ↗</a></p></div>`).join('') : '<div class="notice"><strong>현재 게시된 이력 없음</strong>최근 5년 변경이 없다는 뜻이 아니라, 본 MVP 데이터셋에서 사람 검토를 마친 항목이 아직 없다는 뜻입니다.</div>'}</section>
      <section class="detail-section"><h3>관련 최신 연구</h3><p class="section-description">PubMed 검색 결과를 그대로 근거로 사용하지 않고, 논문별 검토 후 제목·질환·키워드·HCP 요약·원문 링크를 공개합니다.</p>${literature.length ? literature.map((item) => `<div class="literature-item"><div class="change-head"><span>${escapeHtml(item.publicationDate)}</span><span>PMID ${escapeHtml(item.pmid)}</span></div><h4>${escapeHtml(item.title)}</h4><div class="literature-tags">${(item.diseases || []).map((tag) => `<span>${escapeHtml(tag)}</span>`).join('')}${(item.hashtags || []).map((tag) => `<span>${escapeHtml(tag)}</span>`).join('')}</div><p>${escapeHtml(item.hcpSummary)}</p><small class="literature-limit">한계: ${escapeHtml(item.limitations || '원문 초록과 연구설계를 함께 확인하세요.')}</small><br><a class="inline-link" href="${escapeHtml(safeUrl(item.url))}" target="_blank" rel="noreferrer">PubMed 원문 보기 ↗</a></div>`).join('') : `<div class="notice"><strong>검토 완료 논문 0건</strong>아직 사람이 확인해 공개한 논문은 없습니다. 아래 PubMed 검색으로 최신 연구를 찾은 뒤, 문헌 검토 큐에 등록할 수 있습니다.<br><br><a class="inline-link" href="${escapeHtml(pubmedUrl)}" target="_blank" rel="noreferrer">${escapeHtml(product.name)} PubMed 검색 열기 ↗</a></div>`}</section>
    </div>
  </div>`;
}

function selectProduct(id, updateHash = true) {
  const product = state.products.find((item) => item.id === id);
  if (!product) return;
  state.selected = id;
  if (updateHash) history.replaceState(null, '', `#product=${encodeURIComponent(id)}`);
  renderResults(); renderDetail(product);
  if (window.innerWidth < 901) $('#detailPanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function renderLoop() {
  if (!state.run) return;
  const published = state.products.filter((item) => item.status === 'published').length;
  const failures = state.run.failures || [];
  $('#dataDate').textContent = `마지막 검증 ${state.run.runDate}`;
  $('#publishedTrack').style.width = `${Math.round((published / state.products.length) * 100)}%`;
  $('#coverageText').textContent = `${published}/${state.products.length}개 공식 매핑 확인 · ${failures.length}개 검토 큐`;
  $('#loopMetrics').innerHTML = [['제품 레코드', state.products.length], ['공식 매핑', published], ['변경 이력', state.changes.length], ['문헌 공개', state.literature.filter((item) => item.status === 'published').length]].map(([label, value]) => `<div class="loop-metric"><strong>${value}</strong><span>${label}</span></div>`).join('');
  $('#runSummary').textContent = state.run.summary;
  $('#failureList').innerHTML = failures.map((failure) => `<div class="failure-item"><strong>${escapeHtml(failure.product)}</strong> · ${escapeHtml(failure.reason)}</div>`).join('') || '<div class="failure-item" style="background:var(--teal-soft);color:#086a62">검토 큐가 비어 있습니다.</div>';
}

function setupEvents() {
  $('#searchInput').addEventListener('input', (event) => { state.query = event.target.value; renderResults(); });
  $('#searchButton').addEventListener('click', () => { state.query = $('#searchInput').value; renderResults(); });
  document.addEventListener('keydown', (event) => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); $('#searchInput').focus(); } });
  document.querySelectorAll('[data-filter]').forEach((button) => button.addEventListener('click', () => { document.querySelectorAll('[data-filter]').forEach((item) => item.classList.remove('active')); button.classList.add('active'); state.filter = button.dataset.filter; renderResults(); }));
  $('#toggleLoop').addEventListener('click', () => { $('#loopPanel').hidden = false; $('#loopPanel').scrollIntoView({ behavior: 'smooth', block: 'center' }); });
  $('#closeLoop').addEventListener('click', () => { $('#loopPanel').hidden = true; });
}

async function init() {
  setupEvents();
  try {
    const [products, additions, changes, literature, core, additionalCore, faq, run] = await Promise.all([loadJson('./data/public/products.json'), loadJson('./data/public/additional-products.json'), loadJson('./data/public/changes.json'), loadJson('./data/public/literature.json'), loadJson('./data/public/official-core.json'), loadJson('./data/public/additional-core.json'), loadJson('./data/public/faq-templates.json'), loadJson('./qa/runs/latest.json')]);
    state.products = [...products.products, ...additions.products]; state.changes = changes.changes; state.literature = literature.items; state.core = { ...core.items, ...additionalCore.items }; state.faqTemplates = faq.items; state.run = run;
    renderLoop(); renderResults();
    const hashId = new URLSearchParams(location.hash.replace('#', '')).get('product');
    selectProduct(state.products.some((item) => item.id === hashId) ? hashId : state.products[0].id, Boolean(hashId));
  } catch (error) {
    $('#resultList').innerHTML = `<div class="error-message">데이터를 불러오지 못했습니다.<br><small>${escapeHtml(error.message)}</small><br><br>프로젝트 루트에서 로컬 서버로 열어주세요.</div>`;
    $('#dataDate').textContent = '데이터 오류';
  }
}
init();
