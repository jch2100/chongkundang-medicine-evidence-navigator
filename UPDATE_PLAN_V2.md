# UPDATE PLAN v2 — 처방코드·상병코드·연구 레이어 보강

작성일: 2026-09-22
대상: `chongkundang-medicine-evidence-navigator` (현재 MVP: 제품 40개 / 변경 4건 / 문헌 7건)
목적: "제품을 찾는 화면"에서 **"처방·청구·근거를 확인하는 화면"**으로 올린다.

---

## 1. 현행 진단 — 무엇이 비어 있나

기록(`qa/runs/latest.json`, `qa/failures.jsonl`, `qa/corrections.md`, 각 PLAN 문서)과 실제 데이터를 대조한 결과입니다.

### 1-1. 구조 문제: 제품이 1계층이라 함량을 표현할 수 없다

| 확인된 사실 | 위치 |
|---|---|
| `ingredient`, `formStrength`가 사실상 비어 있음 (40개 중 대부분 `null`) | `data/public/products.json` |
| 성분·효능은 `official-core.json`에 따로 있어 같은 정보가 두 파일로 갈라짐 | `official-core.json` / `additional-core.json` |
| 한 브랜드의 여러 함량이 대표 1개로 뭉개짐 (예: 딜라트렌 → "딜라트렌SR정 16mg" 하나) | `products.json` |

딜라트렌·리피로우·텔미누보·타크로벨은 **함량·제형별로 품목이 다르고 보험코드·약가가 전부 다릅니다.** 현재 구조로는 "16mg 코드 뭐예요"에 답할 수 없습니다. 이게 찬훈님이 지적하신 "중량별로 정리되어 있지 않다"의 구조적 원인입니다.

### 1-2. 처방·청구 코드가 0개

현재 데이터에 존재하지 않는 값:

- 보험코드(EDI 청구코드, 9자리) — 실제 청구 단위
- 의약품 표준코드(KD코드, 13자리) — 바코드·유통 단위
- 품목기준코드(식약처 허가 단위 식별자)
- ATC 코드, 약효분류번호
- 상한금액(약가), 급여구분(급여/선별급여/비급여), 본인부담률
- 상병코드(KCD-8) 연결 — 질환이 `dartCategory`의 자유 텍스트("고혈압 치료제")뿐

`RESEARCH.md` §3에는 `insurance_code`가 스키마로 적혀 있는데 구현에는 반영되지 않았습니다. 설계만 있고 데이터가 없는 상태입니다.

### 1-3. 처방 실무 자료 부재

MR·HCP가 실제로 묻는데 지금 답이 없는 항목:

- 급여 인정 기준 (투여 대상·기간·사전승인, 고시 근거)
- 본인부담 특례 — 선별급여·본인부담 차등 품목 (예: 콜린알포세레이트 계열은 급여 범위 이슈가 있는 성분군이므로 **반드시 현행 고시로 확인** 후 표시)
- DUR — 병용금기·임부금기·연령금기·용량주의·투여기간주의·효능군중복·서방정 분할주의
- 마약류/향정 관리 대상 여부 (큐시미아 등 식욕억제제)
- 신·간기능 저하 시 용량조절 위치, 분할·분쇄 가능 여부

### 1-4. 연구(리서치) 레이어가 얇다

| 지표 | 현재 |
|---|---|
| 공개 문헌 | 7건 |
| 문헌이 붙은 제품 | 40개 중 5개 (12.5%) |
| 저장된 검색식 | 0개 — 재현 불가 |
| 국내 근거(학회 진료지침·KoreaMed) | 0건 |
| 임상시험 레지스트리 | 0건 |

`LITERATURE_PLAN.md` §4가 정의한 필드(`study_population`, `comparator`, `key_outcomes`, `relation_to_label`, `search_query_id`, `full_text_url`, `reviewer`)가 실제 `literature.json`에는 절반도 들어가 있지 않습니다. `relationType`도 `"주성분·치료영역"` 같은 자유 텍스트라 필터링이 안 됩니다.

또한 문헌이 **브랜드 단위**로 붙어 있어 같은 성분의 다른 브랜드가 근거를 공유하지 못합니다. 타크로리무스 문헌 2건이 `tacrolimus`에만 붙고 `tacrobell`(같은 성분)에는 붙지 않은 상태입니다.

### 1-5. 변경이력이 사실상 링크 모음

4건 전부 `status: "source-indexed"`이고, **무엇이 어떻게 바뀌었는지가 없습니다.** "변경대비표를 원문에서 확인하세요"만 반복됩니다. 최근 5년 변경 추적이라는 목표 대비 실질 정보량이 0에 가깝습니다.

### 1-6. 검증기가 품질이 아니라 숫자를 검사한다

`scripts/validate-data.mjs`의 구조적 문제:

```js
if (allProducts.length !== 40) errors.push(...)        // 제품을 추가하면 무조건 실패
if (run.productsTotal !== allProducts.length) ...       // 로그 숫자 맞추기 강제
if (product.status === 'review' && product.sources.ckd) // 검토 품목을 채우면 실패
```

세 번째 규칙이 특히 문제입니다. **검토 중인 품목의 정보를 보강하면 검증이 깨지도록** 되어 있어, 개선을 막는 규칙입니다. 검증기는 "데이터가 정확한가"가 아니라 "숫자가 고정값과 같은가"를 보고 있습니다.

### 1-7. 문서와 구현의 불일치

- `FINAL_WEB_PLAN.md`가 명시한 `sources.json`, `docs/DATA_DICTIONARY.md`, `docs/UPDATE_GUIDE.md`, `scripts/collect-pubmed.*`, `build-search-index.*` — **전부 없음**
- `FINAL_WEB_PLAN.md` §12는 "아직 웹앱을 개발하지 않는다"인데 웹앱은 이미 배포 상태
- `PLAN.md`는 20개 기준, 실제는 40개

---

## 2. 재설계 원칙

1. **허가 ≠ 급여 ≠ 청구를 절대 한 필드에 합치지 않는다.** 허가 적응증, 급여 인정 상병, 실제 청구 상병은 각각 다른 근거 문서를 가진다. 섞으면 이 프로젝트는 컴플라이언스 사고가 된다.
2. **코드는 "참고 매핑"으로만 제공한다.** 청구 판단은 심평원 고시 원문 기준. 화면에 코드 출처 파일명·고시 버전·기준일을 함께 박는다.
3. **문헌은 성분 단위로 붙이고 브랜드가 상속한다.** 브랜드 40개에 각각 채우는 대신, 성분 약 25종에 3~5건이면 커버리지가 한 번에 올라간다.
4. **검증기는 숫자가 아니라 형식·참조 무결성·최신성을 본다.** 데이터가 늘어날수록 통과가 쉬워야 정상이다.
5. **깊이 > 개수.** 40개를 얕게 유지하는 대신 핵심 품목을 완성형으로 만든다.

---

## 3. 데이터 모델 재설계 — 3계층

현재 1계층(제품)을 **브랜드 → 품목 → 청구단위** 3계층으로 분리합니다. 이것이 "함량별 정리"의 유일한 해법입니다.

```text
brands.json          브랜드(영업·검색의 단위)
  brandId, nameKo, nameEn, ckdCategory, ckdProductCode, ckdUrl,
  commercialStatus(자체/공동판매), mah(허가권자), manufacturer,
  dartRank, dartSales, ingredientKeys[]

items.json           품목 = 허가 단위 (함량·제형마다 1행)  ★신규
  itemSeq(품목기준코드), brandId, itemNameKo(허가명 그대로),
  ingredientEn, ingredientKo, strength, dosageForm, route,
  rxClass(전문/일반), atcCode, approvalDate, mfdsUrl, itemStatus

billing.json         청구 단위                              ★신규
  itemSeq, ediCode(보험코드 9자리), kdCode(표준코드 13자리),
  maxPrice(상한금액), benefitType(급여/선별급여/비급여),
  copayRate, effectiveDate, noticeRef(고시명·번호), sourceFile

indications.json     적응증 ↔ 상병코드                      ★신규
  itemSeq | brandId, labelIndicationText(원문 위치 포인터),
  kcdCandidates[{code, nameKo, level}], kcdSource,
  reimbursementScope(급여 인정 상병 범위), noticeRef, mappingNote,
  mappedBy, mappedOn

prescribing.json     처방 실무                              ★신규
  itemSeq, dur{병용금기[], 임부금기, 연령금기, 용량주의,
  투여기간주의, 노인주의, 효능군중복, 서방정분할주의},
  narcoticClass(마약/향정/해당없음), nimsReporting,
  renalAdjustRef, hepaticAdjustRef, storage, crushSplit,
  durCheckedOn

ingredients.json     성분 마스터 (문헌 연결 키)              ★신규
  ingredientKey, nameEn, nameKo, atcCode, synonyms[],
  meshTerms[], diseaseTerms[]

literature.json      문헌 — 성분 단위로 재구성              ★재구성
searches.json        검색식 로그 (재현성)                    ★신규
changes.json         변경이력 — 전/후 필드 추가              ★보강
sources.json         출처 레지스트리 (문서·기준일·해시)      ★신규
```

기존 `products.json` + `additional-products.json` + `official-core.json` + `additional-core.json` 4파일 이중구조는 `brands.json` + `items.json`으로 통합합니다. (중복 제거 = 단순화)

### 화면에 나올 결과

```text
딜라트렌
├ 성분 Carvedilol · 전문의약품 · 순환기계용약 · ATC C07AG02
├ 함량별 품목                                       [코드 복사]
│  ┌────────────┬──────┬───────────┬───────────────┬────────┬──────┐
│  │ 품목명     │ 함량 │ 보험코드  │ 표준코드      │ 상한가 │ 급여 │
│  ├────────────┼──────┼───────────┼───────────────┼────────┼──────┤
│  │ 딜라트렌정 │ 6.25 │ XXXXXXXXX │ 8806xxxxxxxxx │  XXX원 │ 급여 │
│  │ 딜라트렌정 │ 12.5 │ ...       │ ...           │        │      │
│  │ 딜라트렌SR │ 16   │ ...       │ ...           │        │      │
│  └────────────┴──────┴───────────┴───────────────┴────────┴──────┘
│  기준: 약제급여목록표 2026-XX-XX 고시 · 확인일 2026-XX-XX
├ 관련 상병코드(참고)  I10, I50.x … ※급여 인정 범위는 고시 원문 확인
├ DUR  병용금기 N건 / 임부금기 / 연령금기        (식약처 DUR 기준일)
└ 관련 연구  Carvedilol 성분 문헌 4건
```

---

## 4. 데이터 출처 — 실제로 받을 수 있는 곳

전부 공개 데이터이며 확인 완료했습니다.

### 4-1. 코드 백본 (파일데이터, 월 1회 갱신 권장)

| 데이터 | 얻는 값 | 출처 |
|---|---|---|
| 심평원 약가마스터_의약품표준코드 | 보험코드·표준코드·상한금액 | [data.go.kr/15067462](https://www.data.go.kr/data/15067462/fileData.do) |
| 심평원 약가마스터_의약품주성분 | 주성분코드·성분·제형·투여경로 | [data.go.kr/15067461](https://www.data.go.kr/data/15067461/fileData.do) |
| 심평원 상병마스터 | KCD 상병기호·한글명·청구 부가정보 | [data.go.kr/15067467](https://www.data.go.kr/data/15067467/fileData.do) |
| 약제급여목록 및 급여 상한금액표(고시) | 급여 목록·상한금액 원문 근거 | [HIRA 약제급여목록표](https://www.hira.or.kr/bbsDummy.do?pgmid=HIRAA030014050000) · [국가법령정보센터](https://www.law.go.kr/LSW/admRulLsInfoP.do?admRulSeq=2100000185786) |

### 4-2. 허가·안전 (OpenAPI, 수시)

| 데이터 | 얻는 값 | 출처 |
|---|---|---|
| 식약처 의약품 제품 허가정보 | 품목기준코드·허가명·성분·제형·포장·허가일 | [data.go.kr/15095677](https://www.data.go.kr/data/15095677/openapi.do) |
| 식약처 DUR 품목정보 | 병용금기·임부금기·연령금기·용량주의 등 | [data.go.kr/15059486](https://www.data.go.kr/data/15059486/openapi.do) |
| 식약처 DUR 성분정보 | 성분 단위 금기 | [data.go.kr/15056780](https://www.data.go.kr/data/15056780/openapi.do) |
| 식약처 낱알식별 | 품목기준코드·식별표기 | [data.go.kr/15057639](https://www.data.go.kr/data/15057639/openapi.do) |
| 의약품안전나라 | 허가사항 원문(적응증·용법·주의) | [nedrug.mfds.go.kr](https://nedrug.mfds.go.kr/) |

### 4-3. 급여기준·상병

- 심평원 보험인정기준: [hira.or.kr 보험인정기준](https://www.hira.or.kr/rc/insu/insuadtcrtr/InsuAdtCrtrList.do?pgmid=HIRAA030069000400)
- KCD 상병코드 조회: [koicd.kr](https://www.koicd.kr/mobile/kcd/list.do) (조회 보조) → **확정 값은 심평원 상병마스터로 검증**

### 4-4. 연구 레이어

| 소스 | 역할 |
|---|---|
| PubMed / E-utilities | 국제 문헌 후보 수집, PMID·DOI |
| 대한의학회 임상진료지침정보센터 [guideline.or.kr](https://www.guideline.or.kr/) | 국내 진료지침 ★신규 |
| KoreaMed / KMbase | 국내 문헌·한국인 대상 연구 ★신규 |
| ClinicalTrials.gov · 식약처 임상시험 승인현황 | 진행 중 연구(허가 근거 아님 배지) ★신규 |

---

## 5. 상병코드 매핑 규칙 (가장 위험한 부분)

3단 분리를 데이터·화면 양쪽에서 강제합니다.

```text
① 허가 적응증      식약처 허가사항 원문 문구           → labelIndicationText
② 관련 상병코드    ①에 대응하는 KCD 코드 후보          → kcdCandidates[]  (참고)
③ 급여 인정 범위   심평원 고시상 급여 조건·상병 제한   → reimbursementScope
```

매핑 절차:

1. 허가사항 적응증 문구 확보 (의약품안전나라 원문)
2. KCD 3단위 블록 후보 선정 — **사람이 선택** (자동 매핑 금지)
3. 심평원 상병마스터로 코드 존재·한글명 검증 (없는 코드는 즉시 실패 처리)
4. 급여 고시에 상병 제한 문구가 있으면 `reimbursementScope`에 고시명·번호·시행일과 함께 기록
5. `mappedBy` / `mappedOn` 기록

화면 고정 문구:

> 상병코드는 허가 적응증에 대응하는 **참고 매핑**입니다. 실제 청구 상병은 환자 상태와 심평원 고시 기준에 따라 의료진이 판단합니다. 이 도구는 청구 적정성을 보증하지 않습니다.

---

## 6. 연구 레이어 재구축

### 6-1. 성분 단위로 전환

`literature.items[].productId` → `ingredientKey` + `appliesToBrands[]`. 타크로리무스 문헌이 타크로벨·라파로벨 등에 자동 연결됩니다.

### 6-2. 필드 강제 (published 조건)

`LITERATURE_PLAN.md` §4를 실제 검증 규칙으로 승격합니다.

```text
필수: title, pmid, journal, publicationDate, studyDesign, population(N 포함),
      intervention, comparator, keyOutcomes, limitations, relationToLabel,
      relationType(enum), evidenceLevel(enum), searchQueryId, reviewer, reviewedOn, url
```

### 6-3. enum 고정

```text
relationType  : direct-product | same-ingredient | disease-context | safety | mechanism
evidenceLevel : guideline | meta-analysis | rct | observational | review | preclinical | registry
```

배지를 2축(연구유형 × 관계유형)으로 표시해 "질환 맥락 리뷰"가 "제품 직접 근거"처럼 보이지 않게 합니다.

### 6-4. 검색식 저장 (재현성)

```json
// searches.json
{ "searchId": "carvedilol-hf-2026q3",
  "ingredientKey": "carvedilol",
  "query": "carvedilol AND (heart failure) AND ...",
  "filters": {"years": 5, "types": ["RCT","Meta-Analysis"]},
  "runOn": "2026-09-2X", "hits": 00,
  "selected": ["PMID..."], "rejected": [{"pmid":"...","reason":"..."}] }
```

`scripts/collect-pubmed.mjs`가 E-utilities로 후보를 뽑아 `candidate` 상태로 적재 → 사람 검토 → `published`. NCBI tool/email 식별자와 요청 간격 준수.

### 6-5. 목표치

| 항목 | 현재 | 목표 |
|---|---|---|
| 문헌 건수 | 7 | 60~80 |
| 성분 커버리지 | 5 브랜드 | 핵심 성분 15종 × 3~5건 |
| 국내 진료지침 | 0 | 주요 질환 6개 영역 |
| 저장된 검색식 | 0 | 성분별 1개 이상 |

---

## 7. 검증기 개편

삭제할 규칙: 제품 40개 고정, run 카운트 일치, `review` 품목의 ckd 링크 금지.

신규 규칙:

```text
형식      보험코드 9자리 숫자 / 표준코드 13자리(체크디지트) / 품목기준코드 형식
참조      billing.itemSeq → items / items.brandId → brands / literature.ingredientKey → ingredients
상병      kcdCandidates[].code 가 상병마스터에 존재
enum      benefitType, relationType, evidenceLevel, narcoticClass
문헌      published 문헌의 필수 15개 필드 전부 존재
최신성    약가·급여 데이터 기준일 90일 초과 → stale 경고 (fail 아님)
출처      모든 source URL https + 확인일 존재
```

---

## 8. 실행 단계

각 단계는 `validator 0 fail` + 사람 검토 체크리스트 통과가 게이트입니다.

| 단계 | 내용 | 산출물 |
|---|---|---|
| **S0** | 스키마·코드체계 문서화 | `docs/DATA_DICTIONARY.md`, `docs/CODE_SYSTEMS.md` |
| **S1** | 코드 백본 — 브랜드→품목 전개, 함량별 코드·약가 | `items.json`, `billing.json`, `scripts/build-items.mjs` |
| **S2** | 상병코드 매핑 + 급여기준 | `indications.json` |
| **S3** | 처방 실무 — DUR·마약류·용량조절 | `prescribing.json`, `scripts/collect-dur.mjs` |
| **S4** | 연구 레이어 재구축 | `ingredients.json`, `literature.json` 재구성, `searches.json`, `scripts/collect-pubmed.mjs` |
| **S5** | 화면·검증·문서 정합 | 함량별 표 UI, 코드 복사, 코드 역검색, validator 개편, 문서 동기화 |

### 파일럿 우선순위 (S1~S3는 5개 브랜드부터)

딜라트렌(함량 다수) · 리피로우(함량 다수) · 텔미누보(복합제 조합) · 자누비아(공동판매) · 글리아티린(급여 이슈 성분)

이 5개가 통과하면 나머지는 같은 스크립트로 확장됩니다.

---

## 9. 화면에 추가할 것

- 제품 상세 **처방·청구 섹션** — 함량별 표, 코드 복사 버튼(현장에서 EDI 코드를 바로 복사)
- **코드 역검색** — 보험코드·표준코드·KCD 코드로 제품 찾기
- FAQ 추가 — "이 약은 어떤 상병에 급여되나요", "함량별 코드가 어떻게 되나요", "병용금기가 있나요"
- 모든 코드 옆 **기준일 배지**, 90일 경과 시 `확인 필요` 표시

---

## 10. 리스크

| 리스크 | 대응 |
|---|---|
| 약가·급여는 수시 개정 → 오래된 값이 청구 오류로 이어짐 | 기준일 필수 표시 + 90일 stale 배지 + 고시 버전 명기 |
| 상병코드를 "이 코드로 청구하면 된다"로 오해 | 참고 매핑 고정 문구 + 급여 범위 필드 분리 |
| 자동 매핑이 만든 오류가 조용히 공개됨 | 코드 매핑은 사람 확정 필수, `mappedBy` 기록 |
| 공공데이터 재배포 조건 | 출처 표시·원본 파일명·기준일 명기, 원문은 링크 |
| 검증 장치 자체의 버그 (과거 사례 있음) | validator 개편 시 고의 오류 데이터로 통과/실패 확인 |

---

## 11. 확정된 운영 결정 (2026-09-22)

| # | 항목 | 결정 |
|---|---|---|
| 1 | 수집 방식 | **하이브리드** — 코드 백본(약가마스터·상병마스터)은 파일데이터 월 1회 수동 갱신, DUR·허가정보는 OpenAPI 자동 수집 |
| 2 | 범위 | **핵심 15개 완성형 + 나머지 25개는 코드 백본만** |
| 3 | 문헌 검토자 | 1인 검토 + `reviewer`·`reviewedOn` 명시 (2인 검토 규칙 폐기 — 지킬 수 없는 규칙은 규칙이 아님) |

### 11-1. 완성형 15개 (DART ETC 상위 기준)

프롤리아 · 아토젯 · 글리아티린 · 펙수클루 · 자누비아 · 고덱스 · 딜라트렌 · 텔미누보 · 타크로벨 · 리피로우 · 큐시미아 · 사이폴 · 이베니티 · 텔미트렌 · 마이렙트

제외 사유: 이모튼(일반의약품), 타크로리무스(DART 집계 단위 이슈 — 품목 확정 후 재검토).
2차 편입 후보: 프리그렐 · 케렌디아 · 잘라탄 · 뉴로만틴.

### 11-2. 찬훈님이 직접 해주셔야 하는 것

공공데이터포털(data.go.kr) 로그인 후 아래 3건 활용신청 → 인증키 발급 (보통 즉시~1일):

- 식품의약품안전처_의약품 제품 허가정보 (15095677)
- 식품의약품안전처_DUR 품목정보 (15059486)
- 식품의약품안전처_DUR 성분정보 (15056780)

키는 저장소에 넣지 않고 로컬 환경변수(`.env.local`, gitignore)로만 씁니다.

---

## 12. 이 계획이 하지 않는 것

- 처방 추천·환자별 판단·제품 우월성 서술
- 청구 적정성 보증
- 허가 외 효능의 영업 메시지화
- 검토 전 데이터의 공개
