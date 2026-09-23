// 검토 큐에 있는 후보 문헌의 초록을 받아 로컬 캐시에 저장한다.
// 사용법: node scripts/fetch-abstracts.mjs [성분키 ...]
//
// 입력: data/source/cache/pubmed/_review-queue.json
// 출력: data/source/cache/pubmed/abstracts.json   (gitignore 대상)
//
// 초록은 검토자가 읽기 위한 작업 자료다. 공개 데이터에 복제하지 않는다
// (LITERATURE_PLAN: 초록 전문 대신 자체 요약과 원문 링크를 제공한다).

import fs from 'node:fs';
import path from 'node:path';

const EUTILS = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils';
const TOOL = 'ckd-medicine-evidence-navigator';

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

function ncbiContact() {
  const envPath = findPath('.env.local');
  if (!envPath) return {};
  const out = {};
  for (const row of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const i = row.indexOf('=');
    if (i < 0) continue;
    const k = row.slice(0, i).trim();
    if (k === 'NCBI_EMAIL' || k === 'NCBI_API_KEY') out[k] = row.slice(i + 1).trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

const queuePath = findPath(path.join('data', 'source', 'cache', 'pubmed', '_review-queue.json'));
if (!queuePath) {
  console.error('검토 큐가 없습니다. 먼저 node scripts/collect-pubmed.mjs --write 를 실행하세요.');
  process.exit(1);
}
const queue = JSON.parse(fs.readFileSync(queuePath, 'utf8'));
const wanted = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const contact = ncbiContact();

const pmids = [];
for (const search of queue.searches) {
  if (wanted.length && !wanted.includes(search.ingredientKey)) continue;
  for (const c of search.candidates) if (!pmids.includes(c.pmid)) pmids.push(c.pmid);
}
console.log(`초록 대상 ${pmids.length}건`);

const outPath = path.join(path.dirname(queuePath), 'abstracts.json');
const store = fs.existsSync(outPath) ? JSON.parse(fs.readFileSync(outPath, 'utf8')) : {};
const todo = pmids.filter((id) => !store[id]);
console.log(`캐시됨 ${pmids.length - todo.length}건 · 새로 받을 ${todo.length}건\n`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chunk = (arr, n) => arr.reduce((acc, v, i) => (i % n ? acc[acc.length - 1].push(v) : acc.push([v]), acc), []);

/* efetch 는 XML 로만 초록을 준다. 필요한 필드만 뽑는다. */
function parseArticles(xml) {
  const out = {};
  for (const block of xml.split('<PubmedArticle>').slice(1)) {
    const pmid = /<PMID[^>]*>(\d+)<\/PMID>/.exec(block)?.[1];
    if (!pmid) continue;
    const texts = [...block.matchAll(/<AbstractText([^>]*)>([\s\S]*?)<\/AbstractText>/g)].map((m) => {
      const label = /Label="([^"]*)"/.exec(m[1])?.[1];
      const body = m[2].replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
      return label ? `${label}: ${body}` : body;
    });
    out[pmid] = {
      abstract: texts.join('\n') || null,
      journal: /<Title>([\s\S]*?)<\/Title>/.exec(block)?.[1]?.replace(/\s+/g, ' ').trim() || null,
      year: /<PubDate>[\s\S]*?<Year>(\d{4})<\/Year>/.exec(block)?.[1] || null,
      types: [...block.matchAll(/<PublicationType[^>]*>([^<]+)<\/PublicationType>/g)].map((m) => m[1]),
    };
  }
  return out;
}

for (const group of chunk(todo, 20)) {
  const url = new URL(`${EUTILS}/efetch.fcgi`);
  url.searchParams.set('db', 'pubmed');
  url.searchParams.set('id', group.join(','));
  url.searchParams.set('retmode', 'xml');
  url.searchParams.set('tool', TOOL);
  if (contact.NCBI_EMAIL) url.searchParams.set('email', contact.NCBI_EMAIL);
  if (contact.NCBI_API_KEY) url.searchParams.set('api_key', contact.NCBI_API_KEY);
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(40000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    Object.assign(store, parseArticles(await res.text()));
    console.log(`  ${group.length}건 수신 (누적 ${Object.keys(store).length}건)`);
  } catch (error) {
    console.log(`  [ERR] ${group[0]}… ${error.message}`);
  }
  await sleep(600);
}

fs.writeFileSync(outPath, JSON.stringify(store, null, 2), 'utf8');
const withAbstract = Object.values(store).filter((v) => v.abstract).length;
console.log(`\n저장: ${outPath}`);
console.log(`총 ${Object.keys(store).length}건 · 초록 있음 ${withAbstract}건 · 초록 없음 ${Object.keys(store).length - withAbstract}건`);
