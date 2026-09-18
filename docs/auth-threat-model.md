# Auth Threat Model — HomeCloud Phase 9

## 1. Scope and source of truth

This document describes the **actually implemented** threat model of the
Authentication & Sessions subsystem of HomeCloud at the Phase 9 baseline.

It is derived from the current source code only:

- `backend/src/auth/auth.service.ts`
- `backend/src/auth/auth.controller.ts`
- `backend/src/auth/jwt.strategy.ts`
- `backend/src/auth/guards/jwt.guard.ts`
- `backend/src/auth/local.strategy.ts`
- `backend/src/auth/auth.module.ts`
- `backend/src/entities/refresh-token.entity.ts`
- `backend/src/entities/user.entity.ts`
- `backend/src/migrations/1746825000000-CreateRefreshTokensTable.ts`
- `backend/src/common/guards/rate-limit.guard.ts`
- `backend/src/main.ts`
- `backend/src/common/startup-validation.service.ts`
- `frontend/src/api/client.ts`

Anything **not** present in that code is documented as *not implemented* —
even if `README.md`, `docs/ROADMAP.md` or the Frontend roadmap mention it.
In particular, mentions of `httpOnly cookie` storage in those documents are
**aspirational**, not implemented.

## 2. Implemented — authentication flow

### 2.1 Register (`POST /api/v1/auth/register`)

- `AuthService.register(email, password, name?)`.
- Rejects an already-existing email with `ConflictException` ("User with this
  email already exists"). This check is **not** transactional and is subject to
  a race: two concurrent registrations with the same email can both pass the
  check before either `save()`; the DB `users.email` `UNIQUE` constraint is the
  only final guard.
- Password is hashed with `bcrypt.hash(password, 12)` before any persistence.
- User is created with `isActive = true`, `isEmailVerified = false` (default).
- On success the controller returns `{ message, accessToken, refreshToken }`.
- No email verification is triggered. `isEmailVerified` stays `false` forever.

### 2.2 Login (`POST /api/v1/auth/login`)

- `AuthService.login(email, password)`.
- Generic error path: user not found, user inactive (`!user.isActive`), and
  wrong password all throw the **same** `UnauthorizedException("Invalid
  credentials")`. This is a deliberate user-enumeration mitigation.
- Password verified with `bcrypt.compare(password, user.password)`.
- On success returns `{ message, accessToken, refreshToken }` via
  `generateTokens(...)`.
- No "remember me", no session persistence beyond the refresh token row.

### 2.3 Password hashing

- Registration and `changePassword`: `bcrypt.hash(..., 12)`.
- Refresh-token storage: `bcrypt.hash(refreshToken, 10)` (see §3.3).
- `validateUser` (used by `LocalStrategy`) and `login` both use
  `bcrypt.compare`.
- `hashPassword(password)` public helper exists (cost 12) but is not wired to
  any endpoint.

## 3. Implemented — access and refresh JWT

### 3.1 Access token

- Payload shape: `JwtPayload = { sub: number, email: string }`.
- `jti` is **not** added to access tokens.
- Signed with `configService.get("JWT_SECRET")`, expiry
  `configService.get("JWT_EXPIRES_IN") || "15m"`.
- Verified by `JwtStrategy` (`passport-jwt`, `fromAuthHeaderAsBearerToken()`)
  and by the custom `JwtGuard`.
- `JwtStrategy.validate` re-checks `isActive: true` in the DB on every request,
  so a deactivated user's still-valid access token is rejected.

### 3.2 Refresh token (JWT layer)

- Payload: `{ jti: randomUUID(), sub, email }`.
- `jti` is generated with Node `randomUUID()` at **every** issuance — at login
  and at every rotation.
- Signed with `configService.get("JWT_REFRESH_SECRET")`, expiry
  `configService.get("JWT_REFRESH_EXPIRES_IN") || "7d"`.
- Verified in `auth.controller.refresh` by `verifyRefreshToken`, which uses
  `jwtService.verify(token, { secret: JWT_REFRESH_SECRET })` and wraps any
  failure in `UnauthorizedException("Invalid refresh token")`.

### 3.3 Refresh token storage

- The raw refresh token is **never** persisted.
- `storeRefreshToken` computes `bcrypt.hash(refreshToken, 10)` and stores only
  the hash in `refresh_tokens.token_hash`.
- `token_hash` has a `UNIQUE` index (`idx_refresh_tokens_token_hash`).
- On rotation the old row's `replaced_by` is set to the **hash** of the new
  token, not the raw token.

## 4. Implemented — refresh rotation and reuse detection

`AuthService.refresh(userId, refreshToken)` is the core state machine. It runs
inside a TypeORM `manager.transaction(...)`.

Order inside the transaction:

1. Load user by `id`; reject if missing or inactive.
2. Reject empty refresh token.
3. `findAndLockRefreshToken(manager, userId, refreshToken)`:
   - `manager.find(RefreshTokenEntity, { where: { userId } })` — loads **all**
     token rows for the user (linear scan, no index on the hash).
   - For each candidate, `bcrypt.compare(refreshToken, candidate.tokenHash)`.
   - On match, `manager.findOne(RefreshTokenEntity, { where: { id }, lock: {
     mode: "pessimistic_write" } })` — acquires a row-level write lock.
   - Returns `null` if no candidate matches.
4. Reject if no stored token ("Invalid refresh token").
5. Reject if `storedToken.expiresAt < new Date()` ("Refresh token expired").
6. **Reuse detection:** if `storedToken.revoked === true`:
   - call `revokeAllUserTokensInTransaction(manager, userId)` (sets
     `revoked = true, revokedAt = now` on all non-revoked rows for the user);
   - return `{ reused: true }`.
7. Sign a new refresh JWT (new `jti`), hash it (cost 10).
8. `manager.update(RefreshTokenEntity, { id: storedToken.id, revoked: false },
   { revoked: true, revokedAt: now, replacedBy: newTokenHash })`.
   - The `revoked: false` predicate in the `where` clause makes this update
     idempotent-safe: if the row was already revoked between the lock release
     and the update, `affected === 0`.
9. If `updateResult.affected === 0` → `revokeAllUserTokensInTransaction(...)`
   and return `{ reused: true }`.
10. Compute `expiresAt` from `JWT_REFRESH_EXPIRES_IN` (parsed locally with a
    regex `(\d+)([smhd])`, default 7d).
11. `manager.create` + `manager.save` the new token row
    (`{ tokenHash, expiresAt, userId }`; `revoked` defaults `false`,
    `replacedBy` left `null`).
12. Sign a fresh access token and return `{ reused: false, tokens }`.

After the transaction, the controller maps `{ reused: true }` to
`UnauthorizedException("Refresh token was reused")`.

### 4.1 `replacedBy`

- Column `refresh_tokens.replaced_by` (`TEXT`, nullable).
- Set on the **old** row during rotation to the bcrypt hash of the **new**
  token.
- It is write-only: no code path reads `replacedBy` for any decision. It is a
  forensic audit trail only.

### 4.2 Concurrency semantics

- The `pessimistic_write` lock serialises concurrent refreshes against the
  **same** row. The spec test confirms that of two concurrent refreshes with
  the same token exactly one succeeds and one throws "Refresh token was reused".
- The lock is per-row, not per-user. Two refreshes with **different** valid
  tokens of the same user can proceed concurrently because they lock different
  rows.
- The whole rotation is inside one transaction, so the revoke → update →
  insert sequence is atomic with respect to the DB.

## 5. Implemented — logout, change-password, revoke-all

### 5.1 Logout (`POST /api/v1/auth/logout`, `JwtGuard`)

- `AuthService.logout(userId, refreshToken)`:
  - No-op if `refreshToken` is falsy.
  - `bcrypt.hash(refreshToken, 10)` then `refreshTokenRepository.findOne({
    where: { tokenHash, userId } })`.
  - If found and `!storedToken.revoked`, update the row to
    `revoked = true, revokedAt = now`.
- Requires a valid access token (route is behind `JwtGuard`) but the actual
  revocation targets the refresh row identified by the submitted refresh
  token string. If the client sends a wrong/expired refresh token, logout
  silently succeeds without revoking anything.

### 5.2 Change password (`POST /api/v1/auth/change-password`, `JwtGuard`)

- Verifies old password with `bcrypt.compare`.
- Re-hashes the new password with cost 12 and saves the user.
- Then calls `revokeAllUserTokens(userId)` — **all** of the user's refresh
  tokens are revoked, including the one currently in use. The caller is
  effectively force-logged-out everywhere.
- `ChangePasswordDto` enforces `newPassword` `MinLength(8)`.

### 5.3 Revoke-all

- Public method `revokeAllUserTokens(userId)` — builder update:
  `revoked = true, revokedAt = now` where `userId = :userId AND revoked =
  false`. **Not** transactional, no row lock.
- Internal `revokeAllUserTokensInTransaction(manager, userId)` — same query
  executed through the transaction manager.
- **Not exposed as an endpoint.** Reachable only via `changePassword` and via
  the reuse-detection path inside `refresh`.

## 6. Implemented — rate limiting and secret validation

### 6.1 Rate limiting

Two layers exist, and they are **different mechanisms**:

1. `express-rate-limit` middleware in `main.ts`:
   - Global on `/api/v1`: 100 requests / 60 s.
   - Dedicated on `/api/v1/auth`: **10 requests / 60 s** (per IP).
2. `RateLimitGuard` (`common/guards/rate-limit.guard.ts`):
   - In-memory `Map<string, number[]>`, 100 requests / 60 s per IP.
   - **Declared in `CommonModule` but never applied to any controller or
     route.** It is dead code with respect to the auth flow.

The effective brute-force protection on auth endpoints is therefore the
`express-rate-limit` 10/60 s per-IP rule. It is IP-based; shared or
proxied IPs are not distinguished, and there is no per-user or per-email
counter.

### 6.2 Secret validation

- `AuthService.validateJwtSecret()` / `validateRefreshSecret()`:
  - Rejects values in a hardcoded `WEAK_SECRETS` set (incl. `changeme`,
    `secret`, `password`, `jwt_secret`, empty).
  - Rejects length `< 32`.
- `StartupValidationService.validateJwtSecrets()` runs at bootstrap and
  **throws** (blocking startup) for the same conditions, and additionally
  requires `JWT_SECRET !== JWT_REFRESH_SECRET`.
- `.env.example` ships `change-me-in-production` for both secrets — the
  startup guard will block the app unless these are replaced.
- **Secret rotation is not implemented.** There is no mechanism to change a
  secret and invalidate outstanding tokens.

## 7. Threat coverage matrix

| Threat | Status | Implemented mitigation |
|---|---|---|
| Weak/default JWT secret | Mitigated | Startup block + runtime check, ≥32 chars, weak-value set |
| Credential replay (refresh token) | Mitigated | Rotation + `replacedBy`; reuse → revoke-all |
| Refresh-token theft (DB) | Mitigated | Only bcrypt hash stored, cost 10; raw token never persisted |
| Brute-force password guess | Partially mitigated | Generic "Invalid credentials"; 10 req/60 s per IP on `/auth` |
| Concurrent refresh of same token | Mitigated | `pessimistic_write` row lock + `affected === 0` check |
| Stale access token after deactivation | Mitigated | `JwtStrategy.validate` re-checks `isActive` |
| User enumeration via login | Mitigated | Single generic error for all failure modes |
| Session fixation | Partially mitigated | New refresh token issued on every login/register; the previously issued refresh token is NOT invalidated by login — it remains usable until its own expiry, rotation, or logout |
| DB compromise (token table) | Partially mitigated | Hashes are reversible only with the JWT secret + bcrypt work; no raw tokens |
| CSRF | **Not mitigated** | See §8 |
| Token theft via XSS (frontend) | **Not mitigated** | See §8 |
| Expired-token accumulation | **Not mitigated** | See §8 |
| Per-session enumeration/revocation | **Not mitigated** | See §8 |
| Secret rotation | **Not mitigated** | See §8 |
| Email verification | **Not mitigated** | See §8 |
| Password reset | **Not mitigated** | See §8 |

## 8. Not implemented (explicit gaps)

These mechanisms are **absent** from the current codebase. Nothing below is
implemented; the bullets describe what is missing and the residual risk.

### 8.1 Email verification — NOT IMPLEMENTED

- `users.isEmailVerified` column exists (default `false`) but **no** endpoint,
  token, or flow sets it to `true`. Registration succeeds without any email
  confirmation.
- Risk: any email string is accepted as a usable account owner; account
  takeover via mailbox access is not gated by ownership proof.

### 8.2 Password reset — NOT IMPLEMENTED

- No `/auth/forgot-password`, `/auth/reset-password`, or equivalent endpoint
  exists. There is no reset-token entity, no email dispatch, and no expiry.
- Risk: a user who forgets their password has no supported recovery path.

### 8.3 Expired refresh-token cleanup — NOT IMPLEMENTED

- `refresh_tokens` rows are never deleted by any scheduler or background job.
  Expiry is only checked at refresh time (`storedToken.expiresAt < new Date()`
  → "Refresh token expired"). Expired rows remain in the table indefinitely.
- Risk: unbounded table growth; forensic `replacedBy`/`revokedAt` data
  accumulates; a DB backup carries stale token hashes.

### 8.4 Session enumeration / per-session revocation — NOT IMPLEMENTED

- `revokeAllUserTokens(userId)` is **all-or-nothing per user**. There is no
  endpoint that lists a user's sessions, no per-token revocation API, and no
  UI for it.
- Risk: a leaked refresh token can only be revoked by revoking **every** token
  of that user (e.g. via `changePassword`), force-logging-out all devices.

### 8.5 CSRF protection — NOT IMPLEMENTED

- No CSRF token generation, validation, or double-submit cookie handling
  exists anywhere in the backend.
- `main.ts` configures CORS with `credentials: true` and a single configured
  origin in production (`FRONTEND_URL`). With credentialed cross-origin
  requests and no CSRF token, state-changing endpoints
  (`/auth/login`, `/auth/register`, `/auth/refresh`, `/auth/logout`,
  `/auth/change-password`) are exposed to cross-site request forgery from any
  origin the browser attaches credentials to.
- Note: the auth endpoints read the refresh token from the JSON **body**, not
  from a cookie, which reduces the practical CSRF surface for token theft, but
  does not eliminate it for the account-state-changing operations.

### 8.6 Secret rotation — NOT IMPLEMENTED

- `JWT_SECRET` / `JWT_REFRESH_SECRET` are read from config at sign/verify time
  and never rotated. There is no key id (`kid`), no grace-period key list, and
  no invalidation of outstanding tokens on rotation.
- Risk: compromise of a secret invalidates nothing; all past tokens remain
  valid until their natural expiry.

### 8.7 Frontend token storage — NOT httpOnly

- `frontend/src/api/client.ts` stores `access_token` and `refresh_token` in
  `localStorage` and attaches `access_token` as a `Bearer` header on every
  request. The 401 interceptor only removes both keys from `localStorage`.
- The Frontend roadmap (`docs/ROADMAP.md` F2) mentions `httpOnly cookie` as a
  **preference for a future phase**, not as implemented behaviour.
- Risk: any XSS in the frontend reads both tokens from `localStorage` and can
  exfiltrate them; the refresh token is usable directly from JS.

## 9. Residual risk summary

1. **Refresh-token DB leak** → attacker can bcrypt-crack hashes (cost 10) if
   they also obtain `JWT_REFRESH_SECRET`; rotation limits the window.
2. **Shared-IP brute force** → the 10/60 s limit is per IP only; a NAT or
   proxy shared by an attacker and innocent users dilutes the limit.
3. **Register race** → the email-existence check is non-transactional; the
   DB `UNIQUE` constraint is the only final guard.
4. **CSRF** on state-changing auth endpoints (no CSRF token; credentialed
   CORS).
5. **XSS** → both tokens live in `localStorage`.
6. **Unbounded `refresh_tokens` growth** — no cleanup.
7. **No account recovery** — no password reset; no email verification.
8. **No secret rotation** — a secret compromise is unrecoverable without a
   forced global logout.
