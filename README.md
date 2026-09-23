# Supplier Hub Private Label Workflow MCP

화면 개발 소스는 `src/ui/`에 있습니다. [화면 소스 구조와 빌드 방법](docs/UI_SOURCE.md)을 참고하세요. `public/fulfillment.html`, `public/practice.html`은 `npm run build:ui`로 생성합니다.

개발·확인 기준 문서: [전체 개발 명세 및 16단계 확인 절차](docs/DEVELOPMENT_SPEC.md). 2026-09-14 운영 13단계의 입수수량 누락 사례, 원본 대조, 50개입 가정, 보완 기능과 재개 조건을 포함합니다. 가정에 따른 카톤 계산과 실제 로젠 등록 완료를 구분합니다.

운영 화면은 **01 발주 준비(1~6) → 02 확정과 발주서(7~10) → 03 로젠 배송(11~14) → 04 입고 마무리(15~16)**로 묶었습니다. 각 묶음은 실제 단계별 상태를 체크 목록으로 표시하고, 개별 실행 버튼과 자세한 이력은 접힌 세부 영역에 보관합니다. 묶음은 자기 구간 끝에서 멈추며 다음 묶음은 직접 실행합니다.

새로 발주확정할 때는 선택 발주·센터·입고예정일과 준비된 엑셀 파일을 검토한 뒤 7단계를 실행합니다. 로젠 새 등록 전에는 13단계 미리보기를 확인합니다. 묶음 재개 시 완료된 업로드·인쇄·등록은 건너뛰고, 로젠 화면 연결인 11~12단계는 다시 연결합니다. 부분 완료·중단·실패·결과 불명확 상태에서는 다음 단계로 넘어가지 않습니다.

발주확정 전 검토 화면의 **파일 열기**는 현재 실행에 연결된 확정 엑셀을 서버가 실행되는 Windows PC의 기본 앱으로 엽니다. 버튼은 열기 요청만 하며 검토 체크나 업로드를 자동 진행하지 않습니다. 준비 파일이 변경됐거나 없어졌으면 화면에 안내합니다.

오른쪽 아래 **작업 도구**는 페이지를 스크롤해도 보이는 이동식 작업창입니다. 제목을 드래그하거나 방향키로 옮기고, 접기·펼치기와 기본 위치 복귀를 사용할 수 있습니다. 위치·접힘·모니터링 설정은 같은 브라우저에 저장합니다.

- **녹화 시작:** 공유할 화면을 선택해 녹화하고, 중지하면 WebM 파일 저장을 요청합니다. 검토 창과 단계 실행 중에도 녹화 버튼을 사용할 수 있습니다.
- **현재 실행 확인:** 선택한 Run의 저장 기록을 읽어 하단 실행 결과에 표시합니다.
- **전체 실행:** Run이 선택돼 있으면 남은 단계부터, 없으면 1단계부터 16단계까지 화면의 단계별 API를 순서대로 호출합니다. 기존 묶음 버튼과 달리 다음 묶음으로 이어지지만, 7단계 발주확정과 13단계 새 등록은 검토 화면에서 확인해야 진행합니다. 이미 완료한 제출·인쇄는 건너뜁니다. 송장 출력까지 완료된 실행은 11~12 재연결도 생략합니다.
- **모니터링:** 선택 Run의 기록을 5초마다 읽어 완료 단계 수·진행 단계·확인 필요 상태·마지막 조회 시각을 표시합니다. 켜기/끄기가 가능하며 검토 중 입력값을 덮어쓰지 않습니다.
- **다음 단계 전 멈춤:** 현재 요청이 끝나면 다음 단계 호출을 멈춥니다. 검토 대기 중이면 검토를 취소하고 종료합니다. 이미 시작한 업로드나 인쇄 요청을 강제 취소하지 않습니다.

전체 실행 중 부분 완료·중단·실패·결과 불명확 상태가 나오면 멈춥니다. 14단계에서 송장번호 확인이 필요하면 번호를 확인한 뒤 **전체 실행**을 다시 눌러 남은 단계를 진행합니다. 화면의 전체 실행은 사람이 검토하는 연속 실행이며, 기존 무인 실행 도구 `run_fulfillment_workflow`와 예약 실행의 운영 모드 제한은 그대로 적용됩니다.

13단계에서 입수수량이 누락되면 `/fulfillment`의 **8단계 이후 · 13단계 등록 준비**에서 후보 또는 직접 입력값으로 계산하고, 포장 기준 확인 체크 후 저장합니다. 이어서 **13단계 등록 미리보기**에서 PO·SKU·수량·카톤·송수하인과 기존 등록 이력을 확인한 뒤 등록합니다. 이전 Run을 유지하며 1~10단계를 반복하지 않습니다. 서버를 재시작했다면 11~12단계로 로젠 화면을 다시 연결합니다. 입수수량 저장과 미리보기만으로 외부 주문이 등록되지는 않습니다.

쿠팡 Supplier Hub의 `Private Label 발주 리스트` 조회부터 발주확정, 택배 주문·송장, 쉽먼트 문서 출력까지 관리하는 로컬 MCP Apps 대시보드입니다. 운영 화면은 `http://127.0.0.1:4310/fulfillment`에서 사용합니다. 현재 포함된 택배사 구현과 실연동 교정값은 **로젠택배 기준 예시**이며, 모든 사용자가 로젠택배나 같은 프린터를 쓴다고 가정하지 않습니다.

## 16단계 Fulfillment MCP

같은 `/mcp` 서버에 다음 16개 단계 도구, 4단계 호환 별칭과 운영 도구를 구현했습니다.

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
- 발주서·쉽먼트·송장 프린터는 사용자 PC의 `.env`에서 각각 지정하며 서로 같거나 달라도 됨
- 담당 Agent: Supplier Hub 단계는 `Supplier Hub Agent`, 로젠 11~14단계는 `Logen Agent`, 로컬 판정·엑셀 작성·출력 기록은 `Fulfillment Coordinator`
- 로젠 연동방법: 실행별로 `api` 또는 `website_mcp`를 선택하며, 11단계에서 선택한 방식이 해당 `runId`에 고정됨

기본 데모 모드에서는 브라우저·물리 프린터를 사용하지 않고 전체 16단계를 실행할 수 있습니다. 실연동 모드에서는 Supplier Hub와 로젠의 전용 Chrome 프로필을 각각 사용합니다.

## 실연동 설정

`.env.example`을 참고해 로컬 `.env`를 구성합니다. 비밀번호와 API Secret Key는 SQLite에 저장되지 않으며 저장소에 커밋하지 않습니다.

### 사용자별 택배사와 프린터

택배사와 프린터는 사용자·사업장·계약 조건·PC마다 달라지는 로컬 설정입니다. 저장소의 로젠 URL, 셀렉터, API 항목과 SINDOH/AllLive 이름은 현재 개발 환경의 기준 구현 또는 예시값일 뿐 공통 기본값이 아닙니다.

- **택배사:** 현재 11~14단계에는 로젠 웹사이트 MCP와 로젠 Open API 어댑터가 구현되어 있습니다. 다른 택배사를 사용할 때는 해당 택배사의 로그인, 주문등록, 송장출력, 송장번호 조회 어댑터를 추가하고 11~14단계에 연결해야 합니다. 택배사 이름만 바꿔서는 연동되지 않습니다.
- **프린터:** 각 사용자 PC의 Windows 설정 또는 인쇄 대화상자에 표시되는 정확한 프린터 이름을 아래 환경변수에 입력합니다. 다른 사용자의 프린터 이름이나 공유 경로를 그대로 복사하지 않습니다.

```env
FULFILLMENT_ORDER_PRINTER=발주서 인쇄용 Windows 프린터 이름
FULFILLMENT_SHIPMENT_PRINTER=쉽먼트 문서 인쇄용 Windows 프린터 이름
FULFILLMENT_WAYBILL_PRINTER=택배 송장 인쇄용 Windows 프린터 이름 또는 공유 경로
```

발주서와 쉽먼트 문서는 같은 프린터를 지정해도 되고 별도 프린터를 지정해도 됩니다. 실연동 전에는 각 PC에서 설치 여부, 온라인 상태, 기본 용지와 라벨 규격, 공유 프린터 접근 권한을 단계별로 교정합니다. 실제 비밀번호, API 키, 사용자별 프린터·공유 경로가 담긴 `.env`는 커밋하지 않습니다.

4311 Windows 인쇄 MCP를 직접 시작할 때도 해당 PC의 송장 프린터를 넘겨야 합니다.

```powershell
npm run start:logen-windows-mcp -- -PrinterName "Windows에 표시되는 송장 프린터 이름"
```

실연동 전에 다음 값이 필요합니다.

- 송하인 주소·전화번호와 로젠 거래처코드
- SKU별 입수수량과 센터별 수취 주소·전화번호
- Supplier Hub 쉽먼트 화면 URL·셀렉터
- 쉽먼트 일괄등록 작업목록 URL, 라벨·내역서 PDF 요청 템플릿
- 로젠 주문등록·송장출력·송장조회 URL·셀렉터
- Supplier Hub 송장입력 원본 XLSX 경로

`FULFILLMENT_MASTER_DATA_FILE`에는 `products`, `centers`, `sender`를 가진 JSON 파일을 지정할 수 있습니다. `FULFILLMENT_SHIPMENT_WORKBOOK`을 지정하면 송장입력 준비본의 SKU·입수수량을 SQLite 상품 기준정보로 가져옵니다. `FULFILLMENT_SHIPMENT_UPLOAD_TEMPLATE`은 15단계에서 스타일을 보존한 채 카톤 행과 송장번호를 채우는 원본입니다.

현재 기준 택배사인 로젠은 두 채널을 제공합니다.

- `website_mcp`: 로젠 기업전용시스템을 전용 Chrome 프로필로 조작합니다. 라이브 셀렉터가 비어 있으면 등록·인쇄 버튼을 누르지 않고 교정 필요 상태로 중단합니다.
- `api`: 공식 `registerOrderData`로 주문을 등록하고 `inquirySlipNoMulti`로 출력 송장번호를 조회합니다. `LOGEN_API_ENVIRONMENT=test|live`, `LOGEN_CUSTOMER_CODE`, 인증키 `LOGEN_API_SECRET_KEY` 또는 호환 별칭 `LOGEN_REST_API`가 필요합니다. `LOGEN_API_USER_ID`를 비워두면 공식 문서 안내대로 거래처코드를 사용합니다. 공식 송장 출력 API는 파일이 아니라 외부 출력 팝업을 제공하므로, 현재는 팝업 MCP 교정 전까지 14단계를 명시적으로 차단합니다.

방화벽·인증키 연결만 확인하고 주문을 생성하지 않는 개발계 스모크 테스트는 다음 명령으로 실행합니다. 이 명령은 `registerOrderData`에 빈 `data` 배열을 전송합니다.

```powershell
npm run probe:logen-api
```

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

### 실습 예제 페이지

`http://127.0.0.1:4310/practice`에서 샘플 발주 3건으로 16단계를 연습할 수 있습니다. 운영 화면 상단의 **실습 예제 열기**로도 이동합니다.

- 신규 발주 전체 처리, 이미 확정된 발주(5~7단계 생략), 재고 부족에 따른 확정수량 조정 예제를 제공합니다.
- 발주 선택, 수량 입력, 카톤 계산, 출력 결과 확인, 가상 송장·쉽먼트 연결을 화면에서 연습합니다.
- 각 단계의 완료 기록은 전용 브라우저 저장 키 `supplierhub-practice-v1`에 저장되며, 실습 결과를 텍스트 파일로 내려받을 수 있습니다.
- 실습 페이지는 업무 API·DB·프린터를 호출하지 않습니다. 콘텐츠 보안 정책으로 네트워크 요청과 폼 제출도 차단합니다.

### 운영 대시보드

[`start-dashboard.cmd`](./start-dashboard.cmd)를 실행하면 빌드 후 서버를 숨김 창으로 시작하고 `http://127.0.0.1:4310/fulfillment`를 엽니다.

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

실제 인쇄 전에는 각 사용자 PC의 `.env`에 지정된 프린터가 Windows에 설치되어 있고 오프라인이 아닌지 확인해야 합니다. 저장소의 예시 프린터 이름을 운영 기본값으로 간주하지 마세요.

## 검증 상태

- TypeScript 빌드: 통과
- 업무 모듈 및 HTTP/MCP 통합 테스트: 19개 파일, 124개 테스트 통과 (2026-09-14)
- v2 통합 사례: 발주 6건 → 로젠 PO+SKU 배치 6건 → 카톤·송장 14건 → 발주별 쉽먼트 6건
- 같은 실행 재호출 시 로젠 등록·송장 출력·쿠팡 업로드·쉽먼트 문서 출력 중복 방지 확인
- 발주별 부분 처리·후속 재개, 확정 업로드의 발주별 귀속 보존, 실연동 전체 실행 게이트, 동시 단계 호출 직렬화, 진행된 카톤 스냅샷 보존 확인
- 4단계 이후 중단된 실행의 자동 재개와 로젠 등록·업로드·인쇄 요청 중단 시 `unknown` 보존 및 자동 반복 차단 확인
- Supplier Hub·로젠 실연동은 계정별 화면 셀렉터, 프린터, API 승인 상태에 따라 별도 교정 필요
- 외부 저장·업로드·물리 인쇄는 `calibration` 모드에서 단계별로 확인한 뒤 활성화

Supplier Hub 화면 구조가 바뀌어 필수 입력란·버튼·테이블을 찾지 못하면 인쇄를 계속하지 않고 오류로 중단합니다.

## 개발 명령

기존 실행의 기준정보와 카톤 계획을 외부 요청 없이 확인할 때는 `npm run inspect:fulfillment -- --run RUN_ID`를 사용합니다. `--carton-units SKU=수량`은 계산 가정만 추가하며 운영 값을 저장하지 않습니다. 상세 절차는 [개발 명세](docs/DEVELOPMENT_SPEC.md#9-재현-가능한-확인-명령)를 참고하세요.

서버 코드는 다음 역할로 나뉩니다. 분리된 HTTP·도구 처리·MCP 모듈은 가져오는 것만으로 서버나 업무 실행을 시작하지 않으며, `src/server.ts`에서 실제 어댑터를 연결하고 서버를 시작합니다.

- `src/server.ts`: 환경설정, 어댑터·저장소 연결, 상태 조회, 서버 시작과 예약 실행
- `src/server-http.ts`: 운영 화면·상태 API, 공통 도구 요청 처리, MCP HTTP 전송
- `src/server-tool-handlers.ts`: 화면 도구 이름과 업무 메서드 연결, 입력값 처리, 호환 별칭
- `src/server-mcp.ts`: MCP 도구·앱 리소스 등록과 응답 구성

`tests/server-http.test.ts`는 임시 로컬 포트와 업무 대역을 사용해 API·MCP 응답 및 입력 처리를 확인합니다. 운영 DB, 외부 주문등록, 물리 프린터는 사용하지 않습니다.

```powershell
npm install
npm run check
npm start
```

공식 MCP Apps 방식에 맞춰 HTML은 `text/html;profile=mcp-app` 리소스로 제공되고, 화면의 동작은 MCP Apps `tools/call` 브리지를 사용합니다.

- [OpenAI: Add UI to your MCP server](https://developers.openai.com/plugins/build/chatgpt-ui)
- [MCP Apps specification](https://modelcontextprotocol.io/docs/extensions/apps)
