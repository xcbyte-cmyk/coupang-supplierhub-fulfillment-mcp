# 화면 소스 구조

운영 화면과 실습 화면은 소스를 역할별로 편집하고, 배포 시 각각 하나의 HTML로 조립한다.
기존 URL, DOM ID, API 계약, 브라우저 저장 키를 그대로 사용한다.

| 경로 | 담당 |
| --- | --- |
| `src/ui/fulfillment/page.html` | 초보자용·전문가용 공통 화면 구조 |
| `src/ui/fulfillment/styles.css` | 화면 배치, 중앙 정렬, 작업 도구, 반응형 스타일 |
| `src/ui/fulfillment/api.js` | 상태 조회 및 도구 호출의 공통 전송·응답 오류 처리 |
| `src/ui/fulfillment/app.js` | 업무 실행, 검토 창, 작업 선택·초기화, 녹화·모니터링 |
| `src/ui/practice/page.html` | 실습 화면 구조 |
| `src/ui/practice/styles.css` | 실습 화면 스타일 |
| `src/ui/practice/curriculum.js` | 가상 발주, 세 가지 예제, 16단계 안내 |
| `src/ui/practice/model.js` | 실습 상태, 수량·카톤 계산, 검토 조건, 완료·생략 판단 |
| `src/ui/practice/app.js` | DOM 표시, 사용자 입력 수집, 로컬 저장, 결과 다운로드 |
| `scripts/build-ui.mjs` | 소스를 결합하고 JavaScript 구문을 확인한 뒤 HTML 생성 |

## 수정과 실행

1. `src/ui/` 아래에서 해당 화면의 소스를 수정한다.
2. `npm run build:ui`로 화면만 생성하거나, `npm run build`로 서버도 빌드한다.
3. 서버는 HTML을 시작할 때 읽으므로 실행 중인 서버를 재시작하고 브라우저를 새로고침한다.

`npm run dev`, `npm test`, `npm run check`에서도 화면 생성이 포함된다.
`public/fulfillment.html`과 `public/practice.html`은 생성 결과이므로 직접 수정하지 않는다.
생성 결과도 저장소에 포함해 기존 배포·문서 캡처·독립 HTML 사용 방식을 유지한다.
별도의 프런트엔드 패키지 설치나 외부 CDN은 필요하지 않다.

## 보존할 동작

- 운영 화면의 7·13단계 검토와 14단계 송장 확인은 화면 실행 코드에 남긴다. 공통 API 함수가 검토나 업무 실행 순서를 결정하지 않는다.
- 초기화는 선택·입력·화면 상태만 비운다. 기존 업무 기록 삭제와 구분한다.
- 초보자용·전문가용은 같은 작업을 이어가며 기존 작업 도구 위치 저장 키도 유지한다.
- 실습은 `supplierhub-practice-v1`의 기존 기록을 읽는다. 실습 모델에는 DOM, 네트워크, 운영 DB, 계정, 프린터 접근이 없다.
- 조립된 실습 HTML의 `connect-src 'none'`, `form-action 'none'`을 유지한다. 외부 스크립트를 로드하지 않는다.

## 검증

`tests/ui-modules.test.ts`는 신규·기확정 발주의 완주, 재고 부족 수량 검증, 확인이 필요한 단계의 정지,
기존 실습 기록 복원, API 요청 계약과 오류 처리를 확인한다.
기존 HTTP·업무 테스트는 생성된 화면과 서버 계약을 계속 검증한다.

2026-09-16 확인: TypeScript·화면 빌드 성공. `ui-modules`, `fulfillment-ui`, `server-http`,
`carton-order-review` 네 테스트 파일의 31개 검사가 통과했다.
브라우저에서 실습 실행·실습 초기화와 운영 화면의 상태 조회도 확인했다.
전체 검사에서는 위 화면 문구 검사를 수정하기 전 152개 중 39개가 실패했다.
화면 문구 검사 1개는 현재 버튼 구조에 맞춰 수정해 재검사에서 통과했으며,
나머지 38개는 이번에 변경하지 않은 업무 테스트 3개 파일에 남아 있다.
주된 실패 지점은 기존 테스트가 실제 발주서 포장 기준 확인 없이 13단계 완료를 기대하는 부분이다.
이 화면 리팩토링에서는 해당 업무 조건을 완화하거나 테스트를 제외하지 않았다.
