# 백엔드

Node.js 24 LTS + TypeScript + Fastify + PostgreSQL. `../setting/Start-Local.cmd` 또는 `../setting/scripts/Start-Backend.ps1`로 로컬 DB와 API를 실행한다. 전체 설정 방법은 `../setting/docs/development/SETUP.md`에 있다.

| 위치 | 역할 |
| --- | --- |
| `src/app.ts` | API 라우트와 의존성 주입 |
| `src/server.ts` | HTTP 실행·DB 연결·종료 |
| `src/config.ts` | 환경변수 검증 |
| `src/migrate.ts`, `migrations/` | 트랜잭션과 잠금을 사용하는 DB 구조 변경 |
| `tests/` | 헬스체크 실패 처리 및 미설정 인증 상태 테스트 |
| `scripts/smoke.ts` | 실제 DB·HTTP 연결 검증 |
| `compose.yaml`, `Dockerfile` | 향후 컨테이너 실행 구성 |

API는 `/health/live`, `/health/ready`, `/v1/auth/providers`만 제공한다. 인증 콜백·로그인 세션·저장 API는 아직 없다. `players`와 `social_identities` 테이블은 제공자 인증을 연결할 기반이며 사용자 비밀번호 열을 갖지 않는다.

`.env.example`은 예시이며 실제 `.env`와 DB 관리자 비밀값은 Git 제외다. 외부 배포용 인증·HTTPS·운영 비밀 관리가 설정된 상태는 아니다. 현재 기본 리슨 주소는 개발 PC 자신만 접근하는 `127.0.0.1`이다.
