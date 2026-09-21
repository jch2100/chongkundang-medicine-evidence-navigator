# 종근당 의약품 근거 탐색 허브

종근당 ETC 주요 의약품을 대상으로, 영업사원과 HCP가 제품명·질환명·분류를 기준으로 공식 원문을 찾도록 돕는 공개 파일럿입니다.

## MVP 범위

- DART 2025 사업보고서의 주요 제품 표를 기준으로 ETC 중심 20개 구성
- 종근당 공식 제품 페이지와의 매핑 상태 표시
- 제품 상세 상단에 성분·효능·분류·안전 확인 상태를 직접 표시
- 제품 목록 자체에 성분·효능을 미리 표시
- 제품별 현장 FAQ를 질문과 답변 형식으로 제공
- 최근 5년 허가 변경은 원문 링크 중심으로 기록
- PubMed 관련 연구는 사람 검토 전까지 공개하지 않고 검색 링크만 제공
- 적응증·성분·부작용·투약 판단을 임의로 생성하지 않음
- 공동판매 제품은 허가권자와 판매 주체가 다를 수 있으므로 별도 태그로 관리
- 검토 필요 항목과 실패 이력을 공개 운영 로그에 기록

핵심 공식값은 `data/public/official-core.json`으로 분리했습니다. 식약처 품목정보와 종근당 제품 페이지의 1:1 매핑이 끝난 값만 확정 상태로 표시하고, 품목이 다른 검색 후보는 검토 상태로 표시합니다. `data/public/faq-templates.json`은 현장 질문만 남기지 않고 효능·성분·안전·용법·변경·연구에 대한 답변을 함께 제공하도록 관리합니다. 안전·이상반응은 최신 허가 원문 기준 확인 영역으로 노출하되 환자별 해석이나 처방 권고는 제공하지 않습니다.

## 실행

정적 파일이므로 프로젝트 루트에서 로컬 서버를 실행합니다.

```powershell
python -m http.server 8765
```

브라우저에서 `http://localhost:8765/`를 엽니다.

데이터 검증:

```powershell
node .\scripts\validate-data.mjs
```

## 출처 원칙

- [DART 2025 사업보고서 주요 제품 및 서비스](https://dart.fss.or.kr/report/viewer.do?rcpNo=20260318001376&dcmNo=11142292&eleId=11&offset=114659&length=28069&dtd=dart4.xsd)
- [종근당 공식 제품](https://www.ckdpharm.com/product/productList.do)
- [종근당 공식 제품소식](https://www.ckdpharm.com/product/newsList.do)
- [의약품안전나라](https://nedrug.mfds.go.kr/)
- [PubMed](https://pubmed.ncbi.nlm.nih.gov/)

이 프로젝트는 의료진의 전문적 판단, 제품설명서 원문, 허가사항 및 의료기관의 지침을 대체하지 않습니다. 공개 전 데이터는 원문 확인과 사람 검토를 거쳐야 합니다.

## 루프 운영

`발견 → 수집 → 정규화 → 자동검증 → 사람 검토 → 공개 → 오류 관찰 → 규칙 개선 → 재실행`

- 실행 요약: `qa/runs/latest.json`
- 실패·검토 큐: `qa/failures.jsonl`
- 교정 원칙: `qa/corrections.md`
- 자동 검증: `.github/workflows/validate.yml`
- 교정 요청: `.github/ISSUE_TEMPLATE/data-correction.yml`

## 라이선스

코드와 화면은 MIT License로 공개할 수 있으나, 외부 기관·제조사·학술 사이트의 원문과 상표권은 각 권리자에게 있습니다. 원문을 복제하지 않고 링크로 연결합니다.
