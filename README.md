# Supplier Hub Private Label Workflow MCP

쿠팡 Supplier Hub의 `Private Label 발주 리스트`를 조회하고, 신규 발주를 중복 없이 관리한 뒤 승인된 발주서 XLSX만 인쇄하는 로컬 MCP Apps 대시보드입니다.

## MCP 아이디어 워크플로 프로토타입

실제 자동화와 분리해, Private Label 발주 조회·확정·출력 10단계와 로젠택배·쉽먼트 처리 4단계로 구성한 총 14개 MCP 역할을 살펴보는 정적 HTML을 함께 제공합니다.

```text
http://127.0.0.1:4310/concept
```

`workflow-concept.html`에는 버튼, 체크 항목, 상태 저장, API 호출이 없습니다. 기존 운영 대시보드는 `http://127.0.0.1:4310/`에서 그대로 사용할 수 있습니다.

## 16단계 Fulfillment MCP

정적 콘셉트와 분리해, 같은 `/mcp` 서버에 다음 16개 단계 도구, 4단계 호환 별칭과 운영 도구를 구현했습니다.

```text
open_supplierhub → list_private_label_orders → compare_new_orders
→ select_orders_for_fulfillment → download_order_confirmation_template
→ prepare_order_confirmation_workbook → upload_and_confirm_private_label_orders
→ download_order_files → print_order_files → record_print_result → open_logen_login
→ open_logen_single_order_registration → register_logen_delivery_order
→ print_logen_waybill → register_supplierhub_shipment_tracking
→ print_supplierhub_shipment_documents
```

- `get_fulfillment_run`: 실행별 발주·카톤·송장·문서 결과 조회
- `run_fulfillment_workflow`: 16단계 전체 실행
- `select_orders_for_print`: `select_orders_for_fulfillment`의 호환용 별칭
- 브라우저 운영 화면: `http://127.0.0.1:4310/fulfillment`
- 2단계 조회: 기본 `입고예정일`, 선택 `발주일`. 시작·종료를 직접 지정하며 입고예정일 날짜를 비워두면 기존 다음 7일/30일 빠른 조회를 사용
- 고급 복구 옵션: 운영 화면 상단 설정 영역의 접힌 패널에서 과거 `scanId`·`runId`를 직접 지정
- 신규 상태 저장소: `data/fulfillment.db` (`node:sqlite`)
- 배송 관계: 발주+SKU 로젠 배치 → 카톤·송장번호 → 발주별 쉽먼트(FC·입고예정일·발주번호로 조회)
- 15단계 준비 테스트: 송장입력 XLSX 생성 → Supplier Hub 첨부·요약 확인 → 업로드 직전 중단
- 15단계 실제 등록: 준비된 XLSX 일괄등록 → 작업 결과 확인 → 쉽먼트 번호 연결
- 동일 실행을 다시 호출해도 로젠 등록·쿠팡 업로드·인쇄를 자동으로 반복하지 않음
- 발주서·쉽먼트 문서는 `SINDOH N600 Series PCL-8`, 로젠 송장은 설치된 `AllLive OLIVE-308B` 공유 프린터로 분리
- 담당 Agent: Supplier Hub 단계는 `Supplier Hub Agent`, 로젠 11~14단계는 `Logen Agent`, 로컬 판정·엑셀 작성·출력 기록은 `Fulfillment Coordinator`
- 로젠 연동방법: 실행별로 `api` 또는 `website_mcp`를 선택하며, 11단계에서 선택한 방식이 해당 `runId`에 고정됨

기본 데모 모드에서는 브라우저·물리 프린터를 사용하지 않고 전체 16단계를 실행할 수 있습니다. 실연동 모드에서는 Supplier Hub와 로젠의 전용 Chrome 프로필을 각각 사용합니다.

## 실연동 설정

`.env.example`을 참고해 로컬 `.env`를 구성합니다. 비밀번호와 API Secret Key는 SQLite에 저장되지 않으며 저장소에 커밋하지 않습니다.

실연동 전에 다음 값이 필요합니다.

- 송하인 주소·전화번호와 로젠 거래처코드
- SKU별 입수수량과 센터별 수취 주소·전화번호
- Supplier Hub 쉽먼트 화면 URL·셀렉터
- 쉽먼트 일괄등록 작업목록 URL, 라벨·내역서 PDF 요청 템플릿
- 로젠 주문등록·송장출력·송장조회 URL·셀렉터
- Supplier Hub 송장입력 원본 XLSX 경로

`FULFILLMENT_MASTER_DATA_FILE`에는 `products`, `centers`, `sender`를 가진 JSON 파일을 지정할 수 있습니다. `FULFILLMENT_SHIPMENT_WORKBOOK`을 지정하면 송장입력 준비본의 SKU·입수수량을 SQLite 상품 기준정보로 가져옵니다. `FULFILLMENT_SHIPMENT_UPLOAD_TEMPLATE`은 15단계에서 스타일을 보존한 채 카톤 행과 송장번호를 채우는 원본입니다.

로젠은 두 채널을 제공합니다.

- `website_mcp`: 로젠 기업전용시스템을 전용 Chrome 프로필로 조작합니다. 라이브 셀렉터가 비어 있으면 등록·인쇄 버튼을 누르지 않고 교정 필요 상태로 중단합니다.
- `api`: 공식 `registerOrderData`로 주문을 등록하고 `inquirySlipNoMulti`로 출력 송장번호를 조회합니다. `LOGEN_API_ENVIRONMENT=test|live`, `LOGEN_API_USER_ID`, `LOGEN_CUSTOMER_CODE`, `LOGEN_API_SECRET_KEY`가 필요합니다. 공식 송장 출력 API는 파일이 아니라 외부 출력 팝업을 제공하므로, 현재는 팝업 MCP 교정 전까지 14단계를 명시적으로 차단합니다.

기본 선택은 `LOGEN_INTEGRATION_METHOD=website_mcp`입니다. Open API는 아직 계약지점 연동 요청과 최종 신청 전이므로 첫 점검은 웹사이트 MCP로 진행하고, API 승인·TEST Key 발급 후 `api` 개발계부터 교정합니다.

전체 예약 실행은 기본적으로 꺼져 있습니다. 단계별 실연동 확인이 끝난 후 `FULFILLMENT_OPERATION_MODE=automatic`, `FULFILLMENT_SCHEDULE_ENABLED=true`를 설정하고 기존 대시보드의 예약 조회도 켜야 활성화됩니다. 실연동 `calibration` 모드에서는 예약 실행과 `run_fulfillment_workflow` 전체 실행이 모두 차단되고 개별 단계만 호출할 수 있습니다.

15단계는 발주별 쉽먼트 준비 상태를 나눠 처리합니다. 같은 FC·입고예정일이어도 발주번호가 다르면 별도 쉽먼트로 연결합니다. 발송일·시간은 MCP/화면 입력값, 해당 Run에 저장된 값, 당일 `16:00` 순서로 결정합니다. 허용 출고일이 아직 오지 않았거나 송장이 불명확한 발주 때문에 정상 발주까지 중단하지 않으며, 안전하게 재개할 수 있는 v3 미완료 발주는 다음 전체 실행에서 기존 `runId`로 이어서 처리합니다. 결과가 `unknown`인 확정·등록·업로드·인쇄는 자동 재시도하지 않습니다.

센터 수취 정보는 항상 SQLite 저장값을 먼저 사용하고, 저장값이 없을 때만 8단계에서 내려받은 발주서의 수취인명·주소·전화번호를 가져와 센터 기준정보로 저장합니다. 둘 다 없으면 해당 발주만 13단계에서 중단됩니다. 현재 제공된 `ShipmentsUpload_PARCEL_20260730_송장입력준비.xlsx`에는 물류센터명만 있고 센터 수취 주소·전화번호 열은 없으므로 이 파일만으로는 신규 센터 fallback이 작동하지 않습니다.

새 16단계 흐름은 일반 ZIP 항목 수, XLSX 구조, 해시, 발주번호 일치 검사를 하지 않습니다. 6단계는 작업에 꼭 필요한 발주번호·발주수량·확정수량 열과 선택 발주 행만 확인하고, ZIP을 받으면 경로 이탈만 막습니다. 기존 `print_batch` 검증 경로는 호환성을 위해 그대로 유지됩니다.

## 현재 제공되는 기능

- 브라우저에서 사용하는 HTML 운영 대시보드
- 16단계를 하나씩 실행하고 `scanId`·`runId` 결과를 확인하는 `/fulfillment` 운영 화면
- 같은 화면을 MCP Apps UI 리소스로 제공하는 `ui://supplierhub-workflow/dashboard-v1.html`
- 신규 발주 조회, 기준선 저장, 발주번호 중복 방지, 인쇄 배치 승인·보류·재시도
- 데모/실연동 모드 분리
- 전용 Chrome 프로필을 이용한 Supplier Hub 로그인 및 Private Label 리스트 조회
- 선택 발주 ZIP 다운로드, XLSX 개수·경로·워크북 구조·발주번호·SHA-256 검증
- Excel 2010 COM 인쇄와 Windows 기본 프린터 확인
- 평일 지정 시간대의 로컬 예약 조회

새 흐름의 7단계만 Supplier Hub `발주서 업로드`로 발주를 확정합니다. 기존 승인형 인쇄 흐름은 Supplier Hub 상태를 변경하지 않습니다.

## 가장 간단한 실행

[`start-dashboard.cmd`](./start-dashboard.cmd)를 실행하면 빌드 후 서버를 숨김 창으로 시작하고 `http://127.0.0.1:4310/`을 엽니다.

기본 설정은 안전한 **데모 모드**입니다. `지금 신규 발주 조회`를 누르면 기준선 2건과 신규 1건으로 전체 승인·인쇄 흐름을 실제 출력 없이 확인할 수 있습니다.

## Codex MCP 연결

대시보드를 실행한 상태에서 로컬 MCP 주소는 다음과 같습니다.

```text
http://127.0.0.1:4310/mcp
```

Codex에 연결할 때 사용할 예시는 다음과 같습니다.

```powershell
codex mcp add supplierhub-workflow --url http://127.0.0.1:4310/mcp
```

연결 후 `get_workflow_dashboard` 도구를 호출하면 같은 HTML 관리 화면이 MCP Apps UI로 표시됩니다.

## 16단계 실연동 전환 절차

1. `/fulfillment`에서 데모 모드로 1~16단계를 순서대로 실행합니다.
2. `/fulfillment`의 `로젠 연동방법`에서 `웹사이트 MCP` 또는 `공식 API 연동`을 선택합니다.
3. `.env`에 선택한 로젠 채널 설정과 Supplier Hub 화면 URL·교정한 셀렉터, PDF 요청 템플릿, XLSX 원본 경로를 입력합니다.
4. 기존 설정 화면에서 `live`로 전환하고 웹 채널을 쓸 때 각 전용 Chrome 프로필에 직접 로그인합니다.
5. `FULFILLMENT_OPERATION_MODE=calibration`과 예약 비활성 상태에서 통제된 발주 한 건을 6단계까지 실행하고 준비된 엑셀을 확인합니다.
6. 7단계 업로드·발주확정은 별도로 한 번 점검한 뒤 로젠 주문·송장, 쿠팡 쉽먼트 번호, 라벨·내역서 출력물을 확인합니다.
7. 16단계 교정이 끝난 뒤에만 `automatic`과 예약 실행을 활성화합니다.

## 기존 승인형 인쇄 흐름

1. 데모 모드에서 조회 → 배치 생성 → 승인 인쇄 흐름을 확인합니다.
2. 운영 설정에서 `실연동`으로 변경합니다. 데모 주문과 배치는 제거됩니다.
3. `로그인 창 열기`를 누르고 자동화 전용 Chrome 창에서 Supplier Hub에 직접 로그인합니다.
4. 첫 실연동 조회는 현재 발주번호를 기준선으로 저장하며 인쇄하지 않습니다.
5. 다음 조회부터 새로 발견된 발주만 선택·승인할 수 있습니다.
6. 실제 인쇄 전 `PRINT batch-...` 확인 문구를 정확히 입력해야 합니다.

실제 인쇄는 설정된 프린터가 Windows 기본 프린터와 같고 오프라인이 아닐 때만 실행됩니다. 기본값은 현재 PC에서 확인된 `SINDOH N600 Series PCL-8`, 1부입니다.

## 검증 상태

- TypeScript 빌드: 통과
- 업무 모듈 테스트: 11개 파일, 72개 테스트 통과
- v2 통합 사례: 발주 6건 → 로젠 PO+SKU 배치 6건 → 카톤·송장 14건 → 발주별 쉽먼트 6건
- 같은 실행 재호출 시 로젠 등록·송장 출력·쿠팡 업로드·쉽먼트 문서 출력 중복 방지 확인
- 발주별 부분 처리·후속 재개, 확정 업로드의 발주별 귀속 보존, 실연동 전체 실행 게이트, 동시 단계 호출 직렬화, 진행된 카톤 스냅샷 보존 확인
- 4단계 이후 중단된 실행의 자동 재개와 로젠 등록·업로드·인쇄 요청 중단 시 `unknown` 보존 및 자동 반복 차단 확인
- 실제 Supplier Hub 30일 목록 26건과 상태 분류, 발주 `138250790`의 확정 양식 다운로드·준비 엑셀 작성까지 교정 완료. 7단계 업로드와 이후 물리 출력은 미실행
- 로젠 공식 API: 요청 계약과 선택 라우팅은 구현·시험 완료, TEST Key 미발급 및 외부 송장 출력 팝업 미교정으로 실호출·실출력은 미실행

Supplier Hub 화면 구조가 바뀌어 필수 입력란·버튼·테이블을 찾지 못하면 인쇄를 계속하지 않고 오류로 중단합니다.

## 개발 명령

```powershell
npm install
npm run check
npm start
```

공식 MCP Apps 방식에 맞춰 HTML은 `text/html;profile=mcp-app` 리소스로 제공되고, 화면의 동작은 MCP Apps `tools/call` 브리지를 사용합니다.

- [OpenAI: Add UI to your MCP server](https://developers.openai.com/plugins/build/chatgpt-ui)
- [MCP Apps specification](https://modelcontextprotocol.io/docs/extensions/apps)
