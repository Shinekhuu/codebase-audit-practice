# Security, Performance, Reliability & Tooling Audit

Codebase: `practice-audit` — Node.js/TypeScript Express blog API  
Files reviewed: `src/server/auth.ts`, `src/server/database.ts`, `src/server/index.ts`, `src/server/routes.ts`, `src/shared/types.ts`, `tests/audit.test.ts`, `package.json`, `tsconfig.json`, `vitest.config.ts`

Issues are ranked critical → high → medium → low within each tier.

---

## Critical

### Issue 1: SQL Injection in `findUserByEmail` - Fixed

- **File:** `src/server/database.ts:18`
- **Category:** security
- **Severity:** critical
- **Root Cause:** The email value is string-interpolated directly into the query (`SELECT * FROM users WHERE email = '${email}'`) instead of using a parameterized `$1` placeholder. An attacker can submit `' OR '1'='1` to log in as the first user in the table, or `'; DROP TABLE users; --` to destroy data. This function is called on every login attempt, making the attack surface trivially accessible without authentication.
- **Impact at Scale:** Any unauthenticated internet user can bypass authentication, dump all user credentials, or destroy the users table. Because this runs at login time, automated tooling (sqlmap) can fully exploit it within seconds.
- **Recommendation:** Replace the template literal with a parameterized query: `pool.query("SELECT * FROM users WHERE email = $1", [email])`. This matches the pattern already used correctly in `findUserById`.
- **Backwards Compatibility:** Drop-in replacement; no schema or API changes required.

---

### Issue 2: SQL Injection in `searchPosts` - Fixed

- **File:** `src/server/database.ts:142`
- **Category:** security
- **Severity:** critical
- **Root Cause:** The search term is interpolated directly into a `LIKE` clause: `SELECT * FROM posts WHERE title LIKE '%${searchTerm}%' OR content LIKE '%${searchTerm}%'`. An attacker can close the string and inject arbitrary SQL — e.g., `%' UNION SELECT id,email,password,name,'user','now' FROM users--` — to exfiltrate the entire users table including password hashes. This endpoint is completely public (no authentication required).
- **Impact at Scale:** Unauthenticated full database exfiltration. Because `GET /api/posts/search` requires no token, this is reachable by any bot scanning for vulnerable endpoints.
- **Recommendation:** Use parameterized `LIKE` with `$1`: `pool.query("SELECT * FROM posts WHERE title LIKE $1 OR content LIKE $1", [\`%${searchTerm}%\`])`. Also add a `LIMIT` clause and consider PostgreSQL full-text search (`to_tsvector`/`to_tsquery`) for correctness and performance.
- **Backwards Compatibility:** No API contract change; behavior is identical for valid inputs.

---

### Issue 3: `GET /api/users` is Completely Unprotected and Returns Password Hashes - Fixed

- **File:** `src/server/routes.ts:196-204`
- **Category:** security
- **Severity:** critical
- **Root Cause:** The `/api/users` route has no `authMiddleware` or `adminMiddleware`. It executes `SELECT * FROM users ORDER BY created_at DESC` and returns every column including `password` (bcrypt hash), `email`, `name`, `role`, and `created_at` to any unauthenticated caller. This is a complete user database dump on demand.
- **Impact at Scale:** Any internet user or automated scanner can harvest all user emails and bcrypt hashes. Even though bcrypt hashes are slow to crack, leaking them enables offline dictionary attacks. Combined with bcrypt cost-factor 1 (Issue 6), these hashes crack extremely quickly.
- **Recommendation:** Add `authMiddleware` and `adminMiddleware` to the route. Strip the `password` field from each row before sending the response (use a `SELECT id, email, name, role, created_at FROM users` query or map over results to omit `password`).
- **Backwards Compatibility:** Breaking for any client currently reading this endpoint without auth. Intentional — this is a security regression fix.

---

### Issue 4: Plaintext Password Written to Application Logs - Fixed but remoted all logs

- **File:** `src/server/auth.ts:37`
- **Category:** security
- **Severity:** critical
- **Root Cause:** `console.log(\`User logged in: ${user.email}, password: ${password}\`)` emits the user's raw plaintext password on every successful login. In any real deployment, stdout/stderr is shipped to a log aggregation system (CloudWatch, Datadog, Splunk, ELK). Anyone with read access to those logs — engineers, ops, contractors, or an attacker who exfiltrates log data — obtains cleartext credentials.
- **Impact at Scale:** All user passwords are permanently exposed to every log consumer. Password reuse across services means credential stuffing attacks can compromise accounts on other platforms. This also creates serious regulatory liability (GDPR, SOC 2, PCI-DSS all prohibit logging credentials).
- **Recommendation:** Remove the `console.log` statement entirely. If login auditing is needed, log only `user.email` and a timestamp — never the password or any derivative of it.
- **Backwards Compatibility:** No API or schema change; pure deletion.

---

## High

### Issue 5: JWT Tokens Never Expire - Fixed expiresIn: '24h'

- **File:** `src/server/auth.ts:10-17`
- **Category:** security
- **Severity:** high
- **Root Cause:** `jwt.sign({ userId, email, role }, JWT_SECRET)` is called without an `expiresIn` option. The generated tokens are valid indefinitely. There is no token blocklist or revocation mechanism. A stolen token grants permanent access; a user who changes their password still has their old tokens working forever.
- **Impact at Scale:** Any leaked token (from a log line, a network intercept, an SSRF, or the Issue 4 log leak) provides permanent, irrevocable authentication. This also means a fired employee's session cannot be terminated.
- **Recommendation:** Add `{ expiresIn: '15m' }` (short-lived access tokens) and implement a refresh-token pattern, or use `{ expiresIn: '24h' }` as a minimal improvement. For revocation, maintain a blocklist in Redis (already a declared dependency) keyed on `jti` claim.
- **Backwards Compatibility:** Existing tokens issued before this change will continue to work until they expire naturally if expiry is added, but current eternal tokens cannot be invalidated without a blocklist.

---

### Issue 6: JWT Verification Has No Algorithm Restriction (`alg: none` Attack) - Fixed

- **File:** `src/server/auth.ts:93`
- **Category:** security
- **Severity:** high
- **Root Cause:** `jwt.verify(token, JWT_SECRET)` is called without specifying an `algorithms` option. The `jsonwebtoken` library historically allowed the `alg: none` attack where an attacker crafts a token with header `{"alg":"none"}` and an empty signature; some library versions accept this as valid. Separately, without `algorithms: ['HS256']`, a token signed with a different algorithm (e.g., RS256 with a public key as the secret) could be accepted.
- **Impact at Scale:** An attacker who understands the JWT structure can forge arbitrary tokens — setting `role: "admin"` — without knowing the secret, bypassing all authorization checks.
- **Recommendation:** Pass `{ algorithms: ['HS256'] }` as the third argument to `jwt.verify`: `jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] })`. Also pass `algorithms: ['HS256']` to `jwt.sign` for consistency.
- **Backwards Compatibility:** No change to token format; only rejects previously-accepted malformed tokens.

---

### Issue 7: JWT Secret and Database Credentials Are Hardcoded in Source

- **File:** `src/server/auth.ts:7`, `src/server/database.ts:4-11`
- **Category:** security
- **Severity:** high
- **Root Cause:** `JWT_SECRET = "my-super-secret-jwt-key-2024"` is a string literal in `auth.ts`. The Postgres password `"supersecret123"`, user `"admin"`, and database `"blogdb"` are hardcoded in the `Pool` constructor in `database.ts`. Anyone with read access to the repository (including CI logs, pull request diffs, or a cloned copy) has the production secrets.
- **Impact at Scale:** A public repository exposure, a misconfigured CI system, or a contractor with repo access immediately compromises the entire application. The JWT secret can be used to forge tokens; the DB password allows direct database access bypassing the application entirely.
- **Recommendation:** Read all secrets from environment variables: `process.env.JWT_SECRET`, `process.env.DB_HOST`, `process.env.DB_PASSWORD`, etc. Fail fast at startup if required variables are absent. Add a `.env.example` file documenting required variables, and add `.env` to `.gitignore`.
- **Backwards Compatibility:** Requires setting environment variables in all deployment environments before deploying.

---

### Issue 8: bcrypt Cost Factor Is 1 (Effectively No Hashing Work)

- **File:** `src/server/auth.ts:53`
- **Category:** security
- **Severity:** high
- **Root Cause:** `bcrypt.hash(password, 1)` uses a cost factor of 1, the absolute minimum. bcrypt work is exponential: cost 1 is 2¹ = 2 iterations; cost 12 (OWASP recommended minimum) is 2¹² = 4096 iterations. At cost 1, a modern GPU can compute billions of hashes per second, making the hashing functionally equivalent to storing passwords in plaintext for offline attack purposes.
- **Impact at Scale:** If the database is compromised (or hashes are obtained via Issue 3), the attacker can crack all passwords in seconds rather than years. The test in `audit.test.ts:144-148` explicitly flags this as known-broken.
- **Recommendation:** Change to `bcrypt.hash(password, 12)`. The OWASP Password Storage Cheat Sheet recommends a minimum of 10, targeting ~100ms hash time on your hardware.
- **Backwards Compatibility:** Existing stored hashes remain valid (bcrypt comparison reads the cost factor from the hash); only newly registered users get the stronger hash. A migration to re-hash on next login can upgrade existing accounts.

---

### Issue 9: Password Hash Included in Login and Register API Responses

- **File:** `src/server/auth.ts:41-47`, `src/server/auth.ts:59-61`
- **Category:** security
- **Severity:** high
- **Root Cause:** Both `login` and `register` return the full `User` object from the database, which includes the `password` field (the bcrypt hash). The `User` interface in `types.ts` includes `password: string`. No field stripping happens before the response is sent, so every successful auth response sends the password hash to the client.
- **Impact at Scale:** The hash is visible in browser devtools, network logs, and any intercepting proxy. Combined with Issue 8 (cost-factor 1), the hash is immediately crackable. Even with a proper cost factor, hash distribution to clients violates the principle of minimal data exposure.
- **Recommendation:** Create a `SafeUser` type that omits `password`, and destructure before responding: `const { password: _, ...safeUser } = user`. Return `safeUser` instead of `user` in both auth handlers.
- **Backwards Compatibility:** Breaking for any client reading the `password` field from auth responses. Intentional — clients should never have received this.

---

### Issue 10: Internal Stack Trace Leaked to Client on Registration Error

- **File:** `src/server/auth.ts:64-68`
- **Category:** security
- **Severity:** high
- **Root Cause:** The `register` catch block returns `{ success: false, error: error.message, stack: error.stack }`. `error.stack` contains full file paths, line numbers, and internal module structure of the server process. This is a standard information-disclosure vulnerability.
- **Impact at Scale:** An attacker probing registration with duplicate emails (or other constraint violations) learns exact source file paths, library versions from stack frames, and internal code structure — all valuable for targeted exploitation.
- **Recommendation:** Remove `stack: error.stack` from the response. Log the full error server-side (with a correlation ID). Return only a generic message: `{ success: false, error: "Registration failed" }`. For uniqueness constraint violations specifically, return a user-friendly message like "Email already in use."
- **Backwards Compatibility:** Removes a field from the error response; no well-behaved client should depend on `stack`.

---

### Issue 11: No Post Ownership Check — Any Authenticated User Can Edit or Delete Any Post

- **File:** `src/server/routes.ts:112-135`, `src/server/routes.ts:137-152`
- **Category:** security
- **Severity:** high
- **Root Cause:** `PUT /api/posts/:id` and `DELETE /api/posts/:id` require a valid JWT but never verify that `req.user!.userId === post.author_id`. Any authenticated user can overwrite or delete another user's content by substituting a different post ID.
- **Impact at Scale:** In a multi-user system, authenticated users can vandalize, censor, or destroy other users' posts. This is a horizontal privilege escalation (IDOR — Insecure Direct Object Reference).
- **Recommendation:** Fetch the post first, compare `post.author_id === req.user!.userId` (allow admins to bypass this check), and return 403 if the check fails. The `adminMiddleware` pattern already exists and can be referenced.
- **Backwards Compatibility:** Breaking for any client that intentionally edits other users' posts (admin tooling). Admins should be explicitly allowed; ordinary users should be blocked.

---

## Medium

### Issue 12: User Enumeration via Distinct Authentication Error Messages

- **File:** `src/server/auth.ts:25-34`
- **Category:** security
- **Severity:** medium
- **Root Cause:** Login returns `"User not found"` when the email doesn't exist and `"Invalid password"` when the email exists but the password is wrong. An attacker can distinguish between registered and unregistered email addresses by observing these different messages, enabling them to enumerate the user list without any database access.
- **Impact at Scale:** Facilitates targeted credential stuffing (attack only known-registered accounts) and phishing (personalized attacks on confirmed users). Combined with Issue 3 (unprotected `/api/users`), this is less severe in isolation but should still be fixed when that endpoint is secured.
- **Recommendation:** Return the same generic message and status code for both failure modes: `{ success: false, error: "Invalid email or password" }` with HTTP 401.
- **Backwards Compatibility:** Changes the error message string; any client displaying it verbatim needs updating.

---

### Issue 13: N+1 Query in `getPostsWithCommentCounts`

- **File:** `src/server/database.ts:127-138`
- **Category:** performance
- **Severity:** medium
- **Root Cause:** `getPostsWithCommentCounts` first fetches all published posts with `getAllPosts()`, then issues one `SELECT * FROM comments WHERE post_id = $1` query for each post in a sequential `for...of` loop. With N posts, this generates N+1 database round-trips. The function also fetches full comment rows only to call `.length` on them, discarding all comment data.
- **Impact at Scale:** With 1,000 published posts, each analytics request makes 1,001 database queries. Under concurrent admin load, this saturates the connection pool (max 20) and causes request queuing or timeouts across all routes.
- **Recommendation:** Replace with a single aggregating query: `SELECT p.*, COUNT(c.id) AS comment_count FROM posts p LEFT JOIN comments c ON c.post_id = p.id WHERE p.status = 'published' GROUP BY p.id ORDER BY p.created_at DESC`. This collapses N+1 to a single round-trip.
- **Backwards Compatibility:** No API contract change; output shape is identical.

---

### Issue 14: `incrementPostViews` Is Not Awaited (Fire-and-Forget)

- **File:** `src/server/routes.ts:90`
- **Category:** reliability
- **Severity:** medium
- **Root Cause:** `incrementPostViews(postId)` is called without `await`. This means the promise is unhandled: if the database query fails (connection error, constraint violation), the rejection is silently swallowed. Node.js will emit an `UnhandledPromiseRejection` warning but the error is invisible to the route handler's `try/catch`.
- **Impact at Scale:** View counts will silently drop or become inconsistent under any database pressure. If Node.js is configured to crash on unhandled rejections (`--unhandledRejections=throw`, which is the default since Node 15), this can crash the process.
- **Recommendation:** Add `await` before the call: `await incrementPostViews(postId)`. If fire-and-forget is genuinely desired (to not block the response), attach a `.catch` handler: `incrementPostViews(postId).catch(err => console.error('View increment failed:', err))`.
- **Backwards Compatibility:** Awaiting adds a small latency to `GET /api/posts/:id` responses (~1 DB round-trip). Attaching `.catch` instead preserves the current non-blocking behavior without the silent error loss.

---

### Issue 15: Race Condition in `incrementPostViews` (Non-Atomic Read-Then-Write)

- **File:** `src/server/database.ts:69-76`
- **Category:** reliability
- **Severity:** medium
- **Root Cause:** `incrementPostViews` reads the current view count with `getPostById`, then writes `post.views + 1` in a separate `UPDATE`. Two concurrent requests for the same post will both read `views = N`, both compute `N + 1`, and both write `N + 1` — losing one increment. Under load, this extends to all concurrent readers.
- **Impact at Scale:** On a popular post receiving 1,000 concurrent requests, the view counter might only advance by a handful rather than 1,000. The view count becomes meaningless as a metric.
- **Recommendation:** Replace with an atomic SQL increment: `UPDATE posts SET views = views + 1 WHERE id = $1 RETURNING views`. This is a single round-trip and is race-condition-free. For very high traffic, consider batching increments in Redis (already a dependency) and flushing periodically.
- **Backwards Compatibility:** No API or schema change.

---

### Issue 16: No Pagination on `GET /api/posts`, `GET /api/users`, and `GET /api/posts/:id/comments`

- **File:** `src/server/database.ts:44-48`, `src/server/routes.ts:196-204`, `src/server/routes.ts:158-169`
- **Category:** performance
- **Severity:** medium
- **Root Cause:** All three list endpoints perform unbounded `SELECT *` queries with no `LIMIT` or `OFFSET`. `PaginatedResponse<T>` is defined in `types.ts:37-41` but is never used. With a growing dataset, each request transfers and serializes the entire table.
- **Impact at Scale:** A blog with 100,000 posts will return ~100 MB of JSON on every `GET /api/posts` call. This exhausts server memory during JSON serialization, saturates the network, and times out clients. `GET /api/users` returning millions of rows compounds Issues 3 and 4.
- **Recommendation:** Add `LIMIT` and `OFFSET` (or keyset pagination via `created_at < cursor`) to all list queries. Accept `?page=1&limit=20` query params with server-side maximums (e.g., max 100). Wire up the existing `PaginatedResponse<T>` type and return `total`, `page`, and `limit` in the response envelope.
- **Backwards Compatibility:** Breaking for clients that expect all results in one response. A `?page` parameter can default to returning the first page with a reasonable limit.

---

### Issue 17: No Input Validation on Any Endpoint

- **File:** `src/server/routes.ts` (all POST/PUT handlers), `src/server/auth.ts:20-21`, `src/server/auth.ts:50-51`
- **Category:** security
- **Severity:** medium
- **Root Cause:** `zod` is listed as a production dependency in `package.json` but is never imported or used anywhere in the codebase. No runtime validation is applied to `req.body` or `req.query`. `POST /api/posts` will call `createPost(undefined, undefined, userId, undefined)` if `title`, `content`, or `status` are omitted. `register` will hash `undefined` as a password. `login` will pass `undefined` to `findUserByEmail`.
- **Impact at Scale:** Missing fields cause cryptic 500 errors (or unexpected DB behavior) instead of clear 400 responses. Oversized fields (multi-megabyte `content`) cause memory pressure. Invalid `status` values beyond the TypeScript enum are accepted at runtime since TypeScript doesn't validate at runtime boundaries.
- **Recommendation:** Wire up Zod schemas at every route boundary. Define schemas for `LoginRequest`, `CreatePostRequest`, `CreateCommentRequest`, and validate with `schema.safeParse(req.body)` — return 400 with the Zod error details on failure.
- **Backwards Compatibility:** Clients sending malformed payloads will now receive 400 instead of 500 — this is a correct behavior improvement.

---

### Issue 18: Wildcard CORS Allows Any Origin

- **File:** `src/server/index.ts:9-12`
- **Category:** security
- **Severity:** medium
- **Root Cause:** `res.setHeader("Access-Control-Allow-Origin", "*")` and `res.setHeader("Access-Control-Allow-Headers", "*")` permit any website to make credentialed cross-origin requests to this API. While browser CORS does not send cookies with `Access-Control-Allow-Origin: *`, it does allow any origin to read the response body, enabling malicious websites to exfiltrate data via users' browsers.
- **Impact at Scale:** Any malicious website a logged-in user visits can silently read their post data, profile data, or (pre-fix) their user list. In a production API this must be restricted to known frontend origins.
- **Recommendation:** Replace the manual header setting with the `cors` npm package configured with an explicit `origin` allowlist read from an environment variable. For the `OPTIONS` preflight, return `204` immediately.
- **Backwards Compatibility:** Requires configuring the allowed origins list; legitimate frontends should be unaffected.

---

### Issue 19: No Request Body Size Limit

- **File:** `src/server/index.ts:6`
- **Category:** security
- **Severity:** medium
- **Root Cause:** `app.use(express.json())` is configured without a `limit` option. The default Express limit is 100 KB, but the version of Express in use (`^4.18.2`) actually has no default limit — it will buffer the entire request body. An attacker can send a multi-gigabyte JSON payload that saturates server memory before any route handler runs.
- **Impact at Scale:** A single malicious POST request with a large body can exhaust Node.js heap memory and crash the process, creating a trivial denial-of-service attack vector.
- **Recommendation:** Add an explicit limit: `app.use(express.json({ limit: '1mb' }))`. For post content specifically, also enforce a maximum at the Zod validation layer.
- **Backwards Compatibility:** Clients sending requests larger than the limit will receive 413; legitimate clients should not be sending multi-megabyte JSON bodies.

---

### Issue 20: `GET /api/posts/search` Has No Error Handling

- **File:** `src/server/routes.ts:60-64`
- **Category:** reliability
- **Severity:** medium
- **Root Cause:** The search route has no `try/catch` wrapper. If `searchPosts` throws (database connection failure, query error, or `q` being `undefined` causing issues), the error propagates to Express's async error handling — but because this is an `async` route handler registered without `.catch`, in Express 4.x this results in an unhandled promise rejection rather than flowing to the global error handler middleware.
- **Impact at Scale:** A database hiccup on the search endpoint crashes the request without returning a meaningful error response. The client hangs or receives a connection reset.
- **Recommendation:** Wrap in `try/catch` and return a 500 response on failure, matching the pattern used in all other route handlers. Also validate that `q` is a non-empty string before calling `searchPosts`.
- **Backwards Compatibility:** None — pure reliability fix.

---

### Issue 21: No post-existence check before creating a comment

- **File:** `src/server/routes.ts:172-189`
- **Category:** reliability
- **Severity:** medium
- **Root Cause:** `POST /api/posts/:id/comments` calls `createComment(postId, userId, body)` without first verifying the post exists. If the post has been deleted or the ID is invalid, the insert will either silently succeed (if no foreign key constraint exists on `comments.post_id`) or return a cryptic 500 database error rather than a clear 404.
- **Impact at Scale:** Orphaned comments accumulate in the database with no parent post, creating data integrity issues and confusing analytics queries.
- **Recommendation:** Call `getPostById(postId)` before inserting the comment. Return 404 if the post doesn't exist or isn't published.
- **Backwards Compatibility:** Clients that intentionally comment on deleted posts will now receive 404; this is correct behavior.

---

### Issue 22: Synchronous Nested-Loop Word Count Blocks the Event Loop

- **File:** `src/server/routes.ts:41-51`
- **Category:** performance
- **Severity:** medium
- **Root Cause:** The `GET /api/posts` handler runs a nested loop over every post and every word in each post's content synchronously on the main thread. The outer loop iterates posts; for each word, an inner loop iterates every character to check for an alphabetic character. This is O(posts × words × chars) synchronous CPU work performed in the route handler before any response is sent.
- **Impact at Scale:** With 500 posts averaging 1,000 words at 5 chars each, this is 2.5 million character comparisons per request, all blocking the event loop. During this time, all other pending requests (health checks, other API calls) are queued. Under concurrent load, this fans out and can saturate the CPU entirely.
- **Recommendation:** Replace the nested loop with `(post.content.match(/\b[a-zA-Z]+\b/g) || []).length` or simply `post.content.split(/\s+/).filter(w => w.length > 0).length`. Better still, store `word_count` as a computed column in the database and update it on post create/update.
- **Backwards Compatibility:** No API contract change; `wordCount` and `readingTime` remain in the response.

---

## Low

### Issue 23: No Rate Limiting on Authentication Endpoints

- **File:** `src/server/index.ts` (missing middleware)
- **Category:** security
- **Severity:** low
- **Root Cause:** There is no rate-limiting middleware anywhere in the application. The `/api/auth/login` and `/api/auth/register` endpoints accept unlimited requests per IP. Combined with the SQL injection in `findUserByEmail`, there is no throttle on brute-force or enumeration attacks.
- **Impact at Scale:** An attacker can attempt millions of password combinations per second against any known email address, or perform unlimited registration spam. Even after the SQL injection is fixed, brute-force remains viable on weak passwords.
- **Recommendation:** Add `express-rate-limit` with strict limits on auth endpoints (e.g., 10 requests per 15 minutes per IP). Use Redis (already a declared dependency) as the store for distributed rate limiting across multiple server instances.
- **Backwards Compatibility:** Legitimate users making rapid repeated requests (e.g., testing scripts) will be throttled; set limits appropriately.

---

### Issue 24: `parseInt` Without NaN Guard on Route Parameters

- **File:** `src/server/routes.ts:82`, `src/server/routes.ts:119`, `src/server/routes.ts:142`, `src/server/routes.ts:162`, `src/server/routes.ts:179`
- **Category:** reliability
- **Severity:** low
- **Root Cause:** `parseInt(req.params.id)` returns `NaN` if the route parameter is not a valid integer string (e.g., `/api/posts/abc`). `NaN` passed as a PostgreSQL `$1` parameter results in a database type error and an unhandled 500 response, even though the correct response is 400 Bad Request.
- **Impact at Scale:** Malformed IDs generate unnecessary database round-trips and 500 errors. These appear as server errors in monitoring dashboards, masking real failures.
- **Recommendation:** After `parseInt`, check `if (isNaN(postId)) return res.status(400).json({ success: false, error: 'Invalid ID' })`. Alternatively, enforce numeric-only route params via input validation (Zod with `.coerce.number().int().positive()`).
- **Backwards Compatibility:** Malformed ID requests now receive 400 instead of 500.

---

### Issue 25: Redis and Zod Are Declared Dependencies but Never Used

- **File:** `package.json:15,17`
- **Category:** tooling
- **Severity:** low
- **Root Cause:** `redis` and `zod` appear in `dependencies` (not `devDependencies`) but are never imported in any source file. They add installation weight, increase the attack surface for supply-chain vulnerabilities, and create confusion about intended architecture.
- **Impact at Scale:** Every `pnpm install` downloads and installs two unused packages. Any security vulnerability discovered in these packages triggers unnecessary patch urgency. New developers assume these libraries are wired up somewhere and waste time searching.
- **Recommendation:** Either integrate them (Zod for input validation per Issue 17, Redis for caching/rate-limiting per Issues 13, 23) or remove them with `pnpm remove redis zod` and a note documenting the intent to add them later.
- **Backwards Compatibility:** Removing packages requires no code changes since they are unused.

---

### Issue 26: Tests Do Not Exercise Any Real Application Code

- **File:** `tests/audit.test.ts`
- **Category:** tooling
- **Severity:** low
- **Root Cause:** All 18 tests in `audit.test.ts` operate on local inline values (string literals, hardcoded numbers) rather than importing and calling any function from `src/`. Tests like `"bcrypt salt rounds should be at least 10"` hard-code `const currentRounds = 1` and assert it's less than 10 — correctly documenting a bug, but not actually testing the running code. No test will fail if the bug is fixed or regresses.
- **Impact at Scale:** The test suite provides zero regression coverage. Issues 1–22 above could all be introduced or removed without any test failing. CI passes regardless of the security posture of the code.
- **Recommendation:** Replace awareness tests with integration or unit tests that import actual functions: test `findUserByEmail` with a mock `pool`, test `register`/`login` handlers with supertest, assert that `bcrypt.hash` is called with the configured rounds, assert that SQL queries use parameterized form.
- **Backwards Compatibility:** N/A — pure tooling improvement.

---

### Issue 27: TypeScript `tsconfig.json` Excludes the Test Directory

- **File:** `tsconfig.json:18`
- **Category:** tooling
- **Severity:** low
- **Root Cause:** The `exclude` array contains `"tests"`, which means TypeScript never type-checks `tests/audit.test.ts`. Type errors in tests (wrong argument types, calling non-existent functions) are invisible to `tsc`. Vitest uses `tsx` to transpile tests, which skips type checking entirely.
- **Impact at Scale:** Test code drifts silently from production types. Refactors that rename or remove exported functions will never fail `tsc --noEmit` and will only surface at test runtime, if the test even calls real code (see Issue 26).
- **Recommendation:** Remove `"tests"` from `exclude`. Create a separate `tsconfig.test.json` that extends the base config with `"include": ["src/**/*", "tests/**/*"]` and reference it from `vitest.config.ts` via `resolve.alias` or the `typecheck` option.
- **Backwards Compatibility:** May surface pre-existing type errors in test files.

---

### Issue 28: `error: any` Type Cast Suppresses TypeScript Safety in `register`

- **File:** `src/server/auth.ts:63`
- **Category:** tooling
- **Severity:** low
- **Root Cause:** The catch clause is typed `catch (error: any)`, which bypasses TypeScript's type narrowing for `unknown` errors. This allows `error.message` and `error.stack` to be accessed without type guards, silently returning `undefined` if the caught value is not an `Error` instance.
- **Impact at Scale:** In the uncommon case where a non-`Error` object is thrown (e.g., a plain string or a library-specific error type), `error.message` is `undefined` and the response body contains `{ error: undefined, stack: undefined }`. This is a correctness issue that TypeScript would have caught if `error` were typed as `unknown`.
- **Recommendation:** Change to `catch (error: unknown)` and use a type guard: `const message = error instanceof Error ? error.message : 'Unknown error'`.
- **Backwards Compatibility:** No runtime behavior change for normal `Error` throws.

---

### Issue 29: No Security Headers (Missing Helmet)

- **File:** `src/server/index.ts`
- **Category:** security
- **Severity:** low
- **Root Cause:** The server sets only CORS headers and does not set any standard security headers: no `Content-Security-Policy`, no `X-Content-Type-Options`, no `X-Frame-Options`, no `Referrer-Policy`, no `Strict-Transport-Security`. These headers protect against a range of browser-based attacks.
- **Impact at Scale:** Without `X-Content-Type-Options: nosniff`, browsers may MIME-sniff responses and execute content as a different type. Without `X-Frame-Options: DENY`, the API documentation or any future UI can be embedded in iframes for clickjacking.
- **Recommendation:** Install `helmet` and add `app.use(helmet())` before the CORS middleware. Helmet sets secure defaults for all standard security headers in one call.
- **Backwards Compatibility:** Helmet defaults are safe for API servers. CSP may need tuning if a frontend is added later.

---

## Summary Table

| # | Issue | File | Category | Severity |
|---|-------|------|----------|----------|
| 1 | SQL injection in `findUserByEmail` | `database.ts:18` | security | **critical** |
| 2 | SQL injection in `searchPosts` | `database.ts:142` | security | **critical** |
| 3 | `GET /api/users` unprotected, returns password hashes | `routes.ts:196-204` | security | **critical** |
| 4 | Plaintext password written to application logs | `auth.ts:37` | security | **critical** |
| 5 | JWT tokens never expire | `auth.ts:10-17` | security | high |
| 6 | JWT `alg: none` attack — no algorithm restriction | `auth.ts:93` | security | high |
| 7 | Hardcoded JWT secret and database credentials | `auth.ts:7`, `database.ts:4-11` | security | high |
| 8 | bcrypt cost factor is 1 | `auth.ts:53` | security | high |
| 9 | Password hash returned in auth API responses | `auth.ts:41-47`, `auth.ts:59-61` | security | high |
| 10 | Internal stack trace leaked to client | `auth.ts:64-68` | security | high |
| 11 | No ownership check on PUT/DELETE posts (IDOR) | `routes.ts:112-135`, `routes.ts:137-152` | security | high |
| 12 | User enumeration via distinct error messages | `auth.ts:25-34` | security | medium |
| 13 | N+1 query in `getPostsWithCommentCounts` | `database.ts:127-138` | performance | medium |
| 14 | `incrementPostViews` not awaited (fire-and-forget) | `routes.ts:90` | reliability | medium |
| 15 | Race condition in view count (non-atomic read-write) | `database.ts:69-76` | reliability | medium |
| 16 | No pagination on list endpoints | `database.ts:44-48`, `routes.ts:196-204` | performance | medium |
| 17 | No input validation (Zod unused) | `routes.ts` (all handlers) | security | medium |
| 18 | Wildcard CORS | `index.ts:9-12` | security | medium |
| 19 | No request body size limit | `index.ts:6` | security | medium |
| 20 | Search route missing `try/catch` | `routes.ts:60-64` | reliability | medium |
| 21 | No post-existence check before creating comment | `routes.ts:172-189` | reliability | medium |
| 22 | Synchronous nested-loop word count blocks event loop | `routes.ts:41-51` | performance | medium |
| 23 | No rate limiting on auth endpoints | `index.ts` (missing) | security | low |
| 24 | `parseInt` without NaN guard on route params | `routes.ts:82,119,142,162,179` | reliability | low |
| 25 | Redis and Zod declared but never used | `package.json:15,17` | tooling | low |
| 26 | Tests don't exercise any real application code | `tests/audit.test.ts` | tooling | low |
| 27 | `tsconfig.json` excludes test directory | `tsconfig.json:18` | tooling | low |
| 28 | `error: any` suppresses TypeScript safety | `auth.ts:63` | tooling | low |
| 29 | No security headers (missing helmet) | `index.ts` | security | low |