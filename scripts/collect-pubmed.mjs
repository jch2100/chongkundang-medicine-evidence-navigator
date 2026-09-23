// 성분별 PubMed 후보 문헌을 수집한다.
// 사용법: node scripts/collect-pubmed.mjs [성분키 ...] [--write] [--years 5] [--max 8]
//
// 입력: data/mapping/ingredients.json          (성분 마스터·검색어)
//       data/public/items.json                 (성분 → 브랜드 연결)
// 출력: data/public/searches.json              (검색식 로그 — 재현성)
//       data/source/cache/pubmed/<key>.json    (수집 원본 캐시, gitignore)
//
// 원칙 (LITERATURE_PLAN.md):
//   - 수집 결과는 전부 candidate 다. 사람 검토를 거쳐야 literature.json 으로 승격된다.
//   - 초록 전문을 공개 데이터로 복제하지 않는다. 서지정보·PMID·링크만 저장한다.
//   - 검색식·실행일·결과 수를 남겨 같은 검색을 재현할 수 있게 한다.
//   - NCBI E-utilities 이용 조건을 지킨다: tool/email 식별자, 요청 간격.

import fs from 'node:fs';
import path from 'node:path';

const TOOL = 'ckd-medicine-evidence-navigator';
const EUTILS = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils';

function findFile(relative) {
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

/* NCBI 는 연락처 이메일을 요구한다. 저장소에 넣지 않고 .env.local 에서 읽는다. */
function ncbiContact() {
  const envPath = findFile('.env.local');
  if (!envPath) return {};
  const out = {};
  for (const row of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const line = row.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i < 0) continue;
    const key = line.slice(0, i).trim();
    const value = line.slice(i + 1).trim().replace(/^["']|["']$/g, '');
    if (key === 'NCBI_EMAIL' || key === 'NCBI_API_KEY') out[key] = value;
  }
  return out;
}

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const root = process.cwd();
const years = Number(arg('years', 5));
const max = Number(arg('max', 8));
const shouldWrite = process.argv.includes('--write');
const wanted = process.argv.slice(2).filter((a) => !a.startsWith('--') && !/^\d+$/.test(a));

const master = JSON.parse(fs.readFileSync(path.join(root, 'data/mapping/ingredients.json'), 'utf8'));
const items = JSON.parse(fs.readFileSync(path.join(root, 'data/public/items.json'), 'utf8')).items;
const contact = ncbiContact();
if (!contact.NCBI_EMAIL) {
  console.warn('주의: .env.local 에 NCBI_EMAIL 이 없습니다. NCBI 이용 조건상 연락처를 넣는 것이 권장됩니다.\n');
}

/* 성분 → 브랜드 연결. items.json 의 ingredientNameEn 은 복합제에서 한 성분만 담기므로
   허가정보 원문(MAIN_INGR_ENG)을 캐시에서 읽어 보완한다. */
const cacheDir = findFile(path.join('data', 'source', 'cache', 'permission'));
function brandsFor(ingredient) {
  const hits = new Set();
  const needle = ingredient.nameEn.toLowerCase();
  for (const item of items) {
    // 허가취소 품목만 있는 브랜드(예: 텔미누보에스)는 판매 중이 아니므로 연결하지 않는다.
    if (item.cancelDate) continue;
    let text = (item.ingredientNameEn || '').toLowerCase();
    if (cacheDir) {
      const p = path.join(cacheDir, `${item.itemSeq}.json`);
      if (fs.existsSync(p)) {
        try {
          text += ' ' + (JSON.parse(fs.readFileSync(p, 'utf8')).MAIN_INGR_ENG || '').toLowerCase();
        } catch { /* 캐시 손상은 무시하고 items.json 값만 쓴다 */ }
      }
    }
    if (text.includes(needle)) hits.add(item.brandId || item.brandNameRaw);
  }
  return [...hits].filter(Boolean).sort();
}

function buildQuery(ing) {
  const name = ing.mesh ? `("${ing.mesh}"[MeSH Terms] OR "${ing.nameEn}"[Title/Abstract])` : `"${ing.nameEn}"[Title/Abstract]`;
  const disease = ing.diseaseTerms.length
    ? ` AND (${ing.diseaseTerms.map((t) => `"${t}"[Title/Abstract]`).join(' OR ')})`
    : '';
  const design = ' AND (randomized controlled trial[pt] OR meta-analysis[pt] OR systematic review[pt] OR practice guideline[pt])';
  const window = ` AND ("${new Date().getFullYear() - years}"[Date - Publication] : "3000"[Date - Publication])`;
  return `${name}${disease}${design}${window}`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function eutils(endpoint, params) {
  const url = new URL(`${EUTILS}/${endpoint}`);
  url.searchParams.set('tool', TOOL);
  if (contact.NCBI_EMAIL) url.searchParams.set('email', contact.NCBI_EMAIL);
  if (contact.NCBI_API_KEY) url.searchParams.set('api_key', contact.NCBI_API_KEY);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`${endpoint} HTTP ${res.status}`);
  return res.json();
}

const targets = master.ingredients.filter((i) => i.searchable && (!wanted.length || wanted.includes(i.key)));
console.log(`대상 성분 ${targets.length}개 · 최근 ${years}년 · 성분당 최대 ${max}건\n`);

const searches = [];
const outDir = findFile(path.join('data', 'source', 'cache')) || path.join(root, 'data', 'source', 'cache');
const pubmedDir = path.join(outDir, 'pubmed');
if (shouldWrite) fs.mkdirSync(pubmedDir, { recursive: true });

for (const ing of targets) {
  const query = buildQuery(ing);
  let search;
  try {
    search = await eutils('esearch.fcgi', { db: 'pubmed', term: query, retmax: String(max), retmode: 'json', sort: 'relevance' });
  } catch (error) {
    console.log(`[ERR ] ${ing.key} · ${error.message}`);
    await sleep(500);
    continue;
  }
  const ids = search?.esearchresult?.idlist || [];
  const total = Number(search?.esearchresult?.count || 0);
  let summaries = {};
  if (ids.length) {
    await sleep(400);
    try {
      const sum = await eutils('esummary.fcgi', { db: 'pubmed', id: ids.join(','), retmode: 'json' });
      summaries = sum?.result || {};
    } catch (error) {
      console.log(`[WARN] ${ing.key} 요약 실패 · ${error.message}`);
    }
  }
  const candidates = ids.map((id) => {
    const s = summaries[id] || {};
    return {
      pmid: id,
      title: s.title || null,
      journal: s.fulljournalname || s.source || null,
      publicationDate: s.pubdate || null,
      articleTypes: s.pubtype || [],
      doi: (s.articleids || []).find((a) => a.idtype === 'doi')?.value || null,
      url: `https://pubmed.ncbi.nlm.nih.gov/${id}/`,
      status: 'candidate',
    };
  });

  const brands = brandsFor(ing);
  searches.push({
    searchId: `${ing.key}-${new Date().toISOString().slice(0, 10)}`,
    ingredientKey: ing.key,
    ingredientNameEn: ing.nameEn,
    ingredientNameKo: ing.nameKo,
    ingredientNote: ing.note ?? null,
    appliesToBrands: brands,
    query,
    filters: { years, designs: ['RCT', 'meta-analysis', 'systematic review', 'practice guideline'], retmax: max, sort: 'relevance' },
    runOn: new Date().toISOString().slice(0, 10),
    totalHits: total,
    returned: candidates.length,
    candidates,
  });

  console.log(`  ${ing.key.padEnd(30)} 검색결과 ${String(total).padStart(5)}건 · 후보 ${String(candidates.length).padStart(2)}건 · 브랜드 ${brands.join(', ') || '-'}`);
  if (shouldWrite) {
    fs.writeFileSync(path.join(pubmedDir, `${ing.key}.json`), JSON.stringify(candidates, null, 2), 'utf8');
  }
  await sleep(500);
}

if (shouldWrite) {
  // 공개본에는 검토 전 문헌 목록을 넣지 않는다 (FINAL_WEB_PLAN: 검토 필요 상태 논문은 공개 화면에 노출하지 않음).
  // 대신 검색식과 PubMed 바로가기를 제공해 사용자가 원본에서 직접 확인하게 한다.
  const publicPayload = {
    schemaVersion: '0.1.0',
    generatedOn: new Date().toISOString().slice(0, 10),
    policy: master.searchPolicy,
    note: '이 화면은 문헌 목록이 아니라 검색 경로를 제공한다. 검토를 마친 문헌만 literature.json 에 실린다.',
    searches: searches.map((s) => ({
      searchId: s.searchId,
      ingredientKey: s.ingredientKey,
      ingredientNameEn: s.ingredientNameEn,
      ingredientNameKo: s.ingredientNameKo,
      ingredientNote: s.ingredientNote,
      appliesToBrands: s.appliesToBrands,
      query: s.query,
      filters: s.filters,
      runOn: s.runOn,
      totalHits: s.totalHits,
      pubmedUrl: `https://pubmed.ncbi.nlm.nih.gov/?term=${encodeURIComponent(s.query)}`,
      candidateCount: s.candidates.length,
      reviewedCount: 0,
    })),
  };
  const outPath = path.join(root, 'data', 'public', 'searches.json');
  fs.writeFileSync(outPath, JSON.stringify(publicPayload, null, 2), 'utf8');

  // 검토 작업용 전체 후보는 저장소 밖(gitignore 대상 캐시)에만 둔다.
  const queuePath = path.join(pubmedDir, '_review-queue.json');
  fs.writeFileSync(queuePath, JSON.stringify({ generatedOn: publicPayload.generatedOn, searches }, null, 2), 'utf8');

  console.log(`\n공개: ${outPath}  (검색식 ${searches.length}건 — 문헌 목록 없음)`);
  console.log(`검토 큐: ${queuePath}  (후보 ${searches.reduce((n, s) => n + s.candidates.length, 0)}건)`);
}
