# 백엔드

Node.js 24 LTS + TypeScript + Fastify + PostgreSQL. `../setting/Start-Local.cmd` 또는 `../setting/scripts/Start-Backend.ps1`로 로컬 DB와 API를 실행한다. 전체 설정 방법은 `../setting/docs/development/SETUP.md`에 있다.

| 위치 | 역할 |
| --- | --- |
| `src/app.ts` | API 라우트와 의존성 주입 |
| `src/server.ts` | HTTP 실행·DB 연결·종료 |
| `src/config.ts` | 환경변수 검증 |
| `src/migrate.ts`, `migrations/` | 트랜잭션과 잠금을 사용하는 DB 구조 변경 |
| `src/kakao.ts`, `src/naver.ts`, `src/login-routes.ts`, `src/login-store.ts` | 카카오·네이버 인증 검증·OAuth·자동 가입·세션 |
| `tests/` | 헬스체크·환경설정·카카오 앱/사용자 검증 테스트 |
| `scripts/smoke.ts` | 실제 DB·HTTP 연결 검증 |
| `scripts/auth-smoke.ts` | 격리 PostgreSQL 스키마에서 자동 가입·재로그인·OAuth 재사용 차단과 클라이언트 모달 검증 |
| `compose.yaml`, `Dockerfile` | 향후 컨테이너 실행 구성 |

게임 API 자격증명은 `accessToken`·`refreshToken`이다. 모든 플랫폼에 15분 접속 토큰과 갱신 시 다시 30일로 연장되는 갱신 토큰을 발급하고 `POST /v1/auth/session/refresh`로 회전한다. PC 웹 결과도 같은 토큰 쌍을 제공한다. SDK 검증 본문은 `providerAccessToken`·네이버 `providerRefreshToken`으로 구분한다. DB에는 해시만 저장하며 재사용/로그아웃은 기기 세션 묶음을 폐기한다. `/v1/auth/providers`의 `protocol_version=2`로 클라이언트와 API 호환성을 확인한다.

`004_mobile_sessions.sql`을 로컬 DB에 적용했고 재현용 `SESSION_ROTATION_KEY`는 Git 제외 `.env`에서 재시작마다 유지한다. 기존 테이블의 mobile 접두사는 PC에도 사용하는 세션 저장 구조의 역사적 이름이다. 상세 정책·API·검증 상태는 [로그인 유지 정책](../setting/docs/development/SESSION_LIFECYCLE.md)에 기록한다. 2026-10-13 장애 수정에서는 사용자 승인으로 최신 백엔드를 빌드·실행했고 단위 테스트 14개와 격리 PostgreSQL 인증 테스트를 통과했다. 실제 제공자 계정 로그인은 별도 확인이 필요하다.

API는 헬스체크, 제공자 상태, `/v1/auth/{kakao|naver}/start`, `/callback`, `/result`, `/native`, `/v1/auth/me`, `/v1/auth/logout`을 제공한다. 카카오는 앱·만료·사용자 ID를 검증하고 네이버는 서버의 ID·Secret으로 코드/갱신 토큰을 교환한 뒤 새 토큰의 사용자 정보를 조회한다. provider+subject를 기준으로 자동 가입/재로그인한다. 이메일 부재·변경은 로그인에 영향을 주지 않고 다른 사용자·제공자는 자동 병합하지 않는다. 사용자 비밀번호 열과 재화 API는 없다. 최초 사장님/찻집 이름은 아래 setup API로 저장한다.

네이버는 `003_login_provider.sql`과 함께 추가했다. 설정·미검증 범위는 `../setting/docs/development/NAVER_LOGIN.md`를 따른다. 사용자 지시로 이번 패치에서는 빌드·컴파일·TypeScript 테스트 실행과 서버 재기동을 생략했다.

카카오 설정과 검증 상태는 `../setting/docs/development/KAKAO_LOGIN.md`를 따른다. 단위 테스트는 `npm test`, 격리 인증 통합 검증은 `npm run smoke:auth`다. 후자는 모의 카카오 응답만 사용하며 실제 사용자 데이터에 테스트 계정을 만들지 않는다.

`.env.example`은 예시이며 실제 `.env`와 DB 관리자 비밀값은 Git 제외다. 외부 배포용 인증·HTTPS·운영 비밀 관리가 설정된 상태는 아니다. 현재 기본 리슨 주소는 개발 PC 자신만 접근하는 `127.0.0.1`이다.

카카오 콜백 안내는 앱과 동일한 `Dongle-Regular.ttf`를 `assets/fonts/`에서 제공한다. 클라이언트 원본과 같은 파일이며 SIL OFL 라이선스를 함께 보관한다. 제목 48px·본문 34px의 regular 서체를 적용하며 Docker 이미지에도 해당 리소스를 포함한다.

## 찻집 이름 중복확인

`POST /v1/auth/cafe-name/check`, Bearer accessToken, JSON `{ "cafe_name": "도트한잔" }` → `{ "cafe_name": "도트한잔", "available": true }`.

인증 실패 401, 이름 형식 오류 400(`invalid_cafe_name` 및 `reason`), 요청 과다 429, 연결/DB 오류 503이다. 한글(음절·자모), 영문 A–Z/a–z, 숫자 0–9만 허용하며 공백(앞뒤 포함)·특수문자·이모지·다른 언어 문자는 거부한다. 이름은 NFC 정규화 후 1~64 문자이고, 한글 조합 차이와 영문 ASCII 대소문자는 같은 이름으로 판정한다.

마이그레이션 `005_cafe_name_unique.sql`은 nullable cafe_name, 정규화된 생성 키, UNIQUE/CHECK 제약을 추가한다. `006_cafe_name_characters.sql`은 허용 문자 CHECK 제약을 추가한다. 조회는 같은 정규화 함수를 사용하며 본인 이름은 사용 가능으로 응답한다. 확인 API는 이름을 예약/저장하지 않는다. setup API는 UNIQUE 충돌(PostgreSQL 23505)을 cafe_name_taken으로 처리한다.

## 최초 찻집 확정

`POST /v1/auth/cafe/setup`, Bearer accessToken, JSON `{ "owner_character_id": "cat-black", "cafe_name": "도트한잔" }` → `{ "player": { "id": "…", "owner_character_id": "cat-black", "cafe_name": "도트한잔" } }`.

인증 계정만 저장한다. 9종 ID 화이트리스트, 기존 NFC/문자/유일성 규칙을 적용한다. 한 계정 행을 잠그고 두 값을 함께 저장하며, 확정 이후 같은 요청은 200, 변경 요청은 409 profile_already_set, 다른 계정의 이름과 충돌하면 409 cafe_name_taken이다. 401 만료, 400 형식 오류, 503 임시 오류도 구분한다. `007_owner_profile.sql`의 CHECK/불변 트리거가 직접 DB 쓰기에서도 확정값 수정/초기화를 차단한다. `GET /v1/auth/me`는 저장된 두 필드를 반환한다.

`npm run smoke:profile`은 임시 스키마에서 저장/재시도/동시 이름 충돌/동일 계정 경합/직접 수정 거부/재조회/세션 만료를 검사한다. 실제 계정은 변경하지 않는다. 로컬 DB 마이그레이션과 백엔드 빌드·재시작을 완료했으며 클라이언트 실행/빌드는 생략했다.
