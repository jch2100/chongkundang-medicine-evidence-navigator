# 종근당 의약품 근거 탐색 허브

종근당 주요 의약품을 대상으로, 제품명·성분명·질환명·**처방 코드**로 공식 원문과 관련 연구를 찾는 공개 참고 도구입니다.

**공개 사이트: https://jch2100.github.io/chongkundang-medicine-evidence-navigator/**

> 이 저장소는 **학습·파일럿 목적**으로 만들어졌습니다. 종근당의 공식 자료가 아니며, 의료진의 전문적 판단·제품설명서 원문·허가사항·의료기관 지침을 대체하지 않습니다. 문헌 요약 62건은 AI가 작성하고 AI가 검증한 것으로 임상 전문가 검토를 거치지 않았습니다.

---

## 현재 상태 (2026-09-23)

이 문서가 **현재 구현 상태의 단일 출처**입니다. 루트의 다른 계획 문서(`PLAN.md`, `FINAL_WEB_PLAN.md` 등)는 설계 당시의 기록이며 현재 상태를 나타내지 않습니다.

| 층 | 내용 | 상태 |
|---|---|---|
| 제품 | 44개 브랜드 (ETC·OTC) | 공개 36 / 검토 8 |
| 허가 | 품목 99건, 포장 311건 — 함량·제형별 코드 | 완료 |
| 급여 | 보험코드·표준코드·상한금액 — 등재 71 / 미등재 28 | 완료 |
| 상병코드 | 19개 브랜드, 블록 51개, 완전코드 889개 | **전체 사람 검토 전** |
| 급여기준 | 글리아티린·큐시미아 2건 | 나머지 미확인 |
| 문헌 | 69건 / 21개 브랜드 (AI 검증 62, 미기록 7) | **임상 검토 전** |
| 검색식 | 성분 20종, 재현 가능한 PubMed 쿼리 | 완료 |

운영 현황 수치는 `qa/runs/latest.json`에 있고 `scripts/build-run-log.mjs`가 데이터에서 다시 만듭니다.

### 알려진 미해결 항목

- 상병코드 매핑 전체가 `reviewStatus: candidate`
- 급여 기준 미확인 브랜드가 대부분 — 미확인은 화면에 아예 표시하지 않음
- 사이클로스포린·미코페놀레이트는 허가 적응증(장기이식) 문헌 미확보. 적응증이 넓어 검색식 재작성 필요
- 텔미누보에스 3품목은 전량 허가취소라 브랜드를 만들지 않음 (검증 경고 3건은 의도된 상태)

---

## 설계 원칙

**허가 ≠ 급여 ≠ 청구.** 세 가지는 근거 문서가 다르므로 한 필드에 합치지 않습니다.

- 상병코드는 **완전코드만** 복사 대상으로 제시합니다. `I10`·`M81` 같은 불완전코드는 단독 청구가 불가능하므로 분류 헤더로만 씁니다.
- 급여 기준이 확인되지 않으면 화면에 **영역 자체를 그리지 않습니다.** 빈 값이 "제한 없음"으로 읽히면 안 됩니다.
- 공동판매 품목은 허가권자와 판매사를 분리 표시합니다. 프롤리아처럼 종근당 명의 코드가 없는 경우도 있습니다.
- 검토 전 문헌은 공개 데이터에 넣지 않습니다. 대신 검색식과 PubMed 바로가기를 제공합니다.
- 문헌 요약은 **누가 검토했는지**를 카드에 표시합니다(전문가 검토 / AI 작성·AI 검증 / 검토 주체 미기록).
- 적응증·성분·부작용·투약 판단을 임의로 생성하지 않습니다.

---

## 데이터 출처

| 자료 | 용도 | 출처 |
|---|---|---|
| 심평원 약가마스터(표준코드·주성분) | 보험코드·표준코드·ATC | [data.go.kr/15067462](https://www.data.go.kr/data/15067462/fileData.do) |
| 심평원 상병마스터 | KCD 상병코드 검증 | [data.go.kr/15067467](https://www.data.go.kr/data/15067467/fileData.do) |
| 약제 급여 목록 및 급여 상한금액표 | 상한금액·급여 등재 | [HIRA](https://www.hira.or.kr/bbsDummy.do?pgmid=HIRAA030014050000) |
| 식약처 의약품 제품 허가정보 API | 적응증·용법·주의사항 원문 | [data.go.kr/15095677](https://www.data.go.kr/data/15095677/openapi.do) |
| 식약처 DUR API | 병용·연령·임부 금기 (S3 예정) | [data.go.kr/15059486](https://www.data.go.kr/data/15059486/openapi.do) |
| PubMed E-utilities | 성분별 문헌 검색 | [PubMed](https://pubmed.ncbi.nlm.nih.gov/) |
| DART 2025 사업보고서 | 제품 선정 우선순위 | [DART](https://dart.fss.or.kr/) |
| 종근당 공식 제품 페이지 | 제품 매핑·제품소식 | [ckdpharm.com](https://www.ckdpharm.com/product/productList.do) |

원본 CSV·XLSX는 `data/source/`에 두며 저장소에 커밋하지 않습니다(`.gitignore`).

---

## 실행

```powershell
python -m http.server 8765
```

`http://localhost:8765/` 를 엽니다. `data/public/items.json`이 없으면 `data/public/fixtures/`의 샘플로 폴백합니다(로컬 개발용이며 배포본에는 포함되지 않습니다).

### 데이터 재생성

원본 파일이 `data/source/`에 있어야 합니다.

```powershell
node .\scripts\build-items.mjs --write        # 허가·급여 코드 백본
node .\scripts\build-indications.mjs --write  # 적응증 → 상병코드
node .\scripts\collect-pubmed.mjs --write     # 성분별 PubMed 검색
node .\scripts\fetch-abstracts.mjs            # 초록 캐시 (검토용)
node .\scripts\merge-drafts.mjs --write       # 문헌 초안 병합·형식 점검
node .\scripts\verify-drafts.mjs              # 초안을 원 초록과 대조 검증
node .\scripts\promote-drafts.mjs --write     # 검증된 초안을 공개 데이터로
node .\scripts\build-run-log.mjs --write      # 운영 현황 갱신
node .\scripts\validate-data.mjs              # 전체 검증 (배포 게이트)
```

공공데이터포털 인증키가 필요한 스크립트는 `.env.local`을 읽습니다. 발급 절차는 `docs/OPENAPI_KEY_SETUP.md`에 있습니다.

```powershell
node .\scripts\check-api-key.mjs
```

---

## 배포

`main`에 푸시하면 `.github/workflows/pages.yml`이 동작합니다.

1. `validate-data.mjs` — **실패하면 배포하지 않습니다**
2. 공개 대상만 `_site/`로 수집 (`index.html`, `app.js`, `styles.css`, `favicon.svg`, `data/public/*.json`, `qa/runs/latest.json`)
3. GitHub Pages 배포

원본 데이터·스크립트·설계 문서·검토용 초안은 배포되지 않습니다.

외부 링크 검사(`validate.yml`)는 리포트 전용입니다. 식약처·심평원·종근당 사이트가 GitHub 러너(해외 IP)에 302·500·타임아웃을 반환해 차단 게이트로 쓸 수 없습니다.

---

## 문서

| 문서 | 내용 |
|---|---|
| `docs/DATA_DICTIONARY.md` | 데이터 계약 — 스키마·조인 규칙·해석 규칙 |
| `docs/KCD_MAPPING.md` | 상병코드 매핑 규칙 — 완전/불완전코드 구분 |
| `docs/OPENAPI_KEY_SETUP.md` | 공공데이터포털 인증키 발급 |
| `UPDATE_PLAN_V2.md` | 현행 개선 계획 (S0~S5) |
| `qa/corrections.md` | 데이터 교정 기록 |
| `qa/audit-2026-09-22-itemseq.md` | 품목 매핑 감사 |
| `PLAN.md` · `FINAL_WEB_PLAN.md` · `RESEARCH.md` · `UI_UX_PLAN.md` · `LITERATURE_PLAN.md` · `LOOP_ENGINEERING_PLAN.md` | 초기 설계 기록 (현재 상태 아님) |

---

## 라이선스

코드와 화면은 MIT License입니다. 외부 기관·제조사·학술 사이트의 원문과 상표권은 각 권리자에게 있습니다. 원문을 복제하지 않고 링크로 연결합니다.
