import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const readJson = (relative) => JSON.parse(fs.readFileSync(path.join(root, relative), 'utf8'));
const products = readJson('data/public/products.json');
const additions = readJson('data/public/additional-products.json');
const changes = readJson('data/public/changes.json');
const literature = readJson('data/public/literature.json');
const core = readJson('data/public/official-core.json');
const additionalCore = readJson('data/public/additional-core.json');
const faq = readJson('data/public/faq-templates.json');
const run = readJson('qa/runs/latest.json');
const errors = [];

const allProducts = [...(products.products || []), ...(additions.products || [])];
const allCore = { ...(core.items || {}), ...(additionalCore.items || {}) };
if (allProducts.length !== 40) errors.push(`product datasets: expected 40 total products, got ${allProducts.length}`);
const ids = new Set();
const faqKeys = new Set(['efficacy', 'ingredient', 'safety', 'dosing', 'changes', 'research']);
if (!Array.isArray(faq.items) || faq.items.length < 5) errors.push('faq-templates.json: at least 5 FAQ templates required');
for (const item of faq.items || []) {
  if (!item.id || !item.question || !faqKeys.has(item.answerKey)) errors.push(`faq:${item.id || 'unknown'} incomplete or unsupported answerKey`);
}
for (const product of allProducts) {
  for (const field of ['id', 'name', 'dartCategory', 'status', 'sources']) {
    if (product[field] === undefined || product[field] === null || product[field] === '') errors.push(`product:${product.id || 'unknown'} missing ${field}`);
  }
  if (ids.has(product.id)) errors.push(`duplicate product id: ${product.id}`);
  ids.add(product.id);
  if (!/^https:\/\//.test(product.sources.dart)) errors.push(`product:${product.id} DART source must be https`);
  if (product.status === 'published' && !product.sources.ckd) errors.push(`product:${product.id} published product needs CKD source`);
  if (product.status === 'review' && product.sources.ckd) errors.push(`product:${product.id} review item unexpectedly has CKD source`);
  if (!allCore[product.id]) errors.push(`product:${product.id} missing official-core record`);
  if (product.scope && !['ETC', 'OTC'].includes(product.scope)) errors.push(`product:${product.id} invalid scope`);
}
for (const [id, item] of Object.entries(allCore)) {
  if (!ids.has(id)) errors.push(`official-core:${id} references unknown product`);
  if (!item.source || !/^https:\/\//.test(item.source)) errors.push(`official-core:${id} source must be https`);
}
for (const change of changes.changes || []) {
  if (!change.productId || !ids.has(change.productId)) errors.push(`change:${change.id} references unknown product`);
  if (!/^20(21|22|23|24|25|26)-\d{2}-\d{2}$/.test(change.date)) errors.push(`change:${change.id} invalid date`);
  if (!/^https:\/\//.test(change.source)) errors.push(`change:${change.id} source must be https`);
}
for (const item of literature.items || []) {
  if (!item.productId || !ids.has(item.productId)) errors.push(`literature:${item.pmid} references unknown product`);
  if (item.status === 'published' && (!item.title || !item.hcpSummary || !item.url)) errors.push(`literature:${item.pmid} published item incomplete`);
}
if (run.productsTotal !== allProducts.length) errors.push('latest run product count mismatch');
if (run.changesPublished !== changes.changes.length) errors.push('latest run change count mismatch');
if (run.literaturePublished !== literature.items.filter((item) => item.status === 'published').length) errors.push('latest run literature count mismatch');

if (errors.length) {
  console.error(`VALIDATION FAILED (${errors.length})`);
  errors.forEach((error) => console.error(`- ${error}`));
  process.exit(1);
}
console.log(`VALIDATION PASSED · products=${allProducts.length} · changes=${changes.changes.length} · literature=${literature.items.length} · reviewQueue=${run.failures.length}`);
