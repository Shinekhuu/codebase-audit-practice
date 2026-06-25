# Architecture Review — practice-audit

## Part 1 – High-level Architecture

```mermaid
flowchart LR
    Client["HTTP Client\n(browser / mobile / curl)"]

    subgraph Server["Express API Server (Node.js · PORT 3000)"]
        EntryPoint["index.ts\nCORS · JSON body parser\nglobal error handler"]
        Router["routes.ts\n/api/auth/*\n/api/posts/*\n/api/posts/:id/comments\n/api/users"]
        Auth["auth.ts\nJWT sign & verify\nbcrypt hashing\nauthMiddleware · adminMiddleware"]
        DB["database.ts\npg Pool (max 20)"]
    end

    PostgreSQL[("PostgreSQL\nlocalhost:5432\ndatabase: blogdb\ntables: users · posts · comments")]

    RedisUnused["Redis\n(package.json only —\nnever imported)"]
    ZodUnused["Zod\n(package.json only —\nnever imported)"]

    Client -->|"HTTP REST"| EntryPoint
    EntryPoint --> Router
    Router -->|"authMiddleware / adminMiddleware"| Auth
    Router -->|"SQL queries"| DB
    Auth -->|"findUserByEmail · createUser"| DB
    DB -->|"pg protocol"| PostgreSQL

    style RedisUnused stroke-dasharray: 5 5,fill:#f5f5f5
    style ZodUnused stroke-dasharray: 5 5,fill:#f5f5f5
```

### Component Responsibilities

| Component | File | Responsibility |
|-----------|------|----------------|
| **HTTP Client** | — | Any external consumer (browser, mobile app, CLI). No frontend exists in this repo; it is a pure REST API. |
| **Express API Server** | `src/server/index.ts` | Entry point. Configures wildcard CORS headers (`Access-Control-Allow-Origin: *`), JSON body parsing (no size limit), mounts the router at `/api`, and registers a global 500 error handler. Listens on `$PORT` (default 3000). |
| **Router** | `src/server/routes.ts` | Declares all REST routes. Public: `GET /api/posts`, `GET /api/posts/search`, `GET /api/posts/:id`, `GET /api/posts/:id/comments`, `GET /api/users` (unguarded). Authenticated (Bearer JWT): `POST /PUT /DELETE /api/posts`, `POST /api/posts/:id/comments`. Admin-only: `GET /api/posts/analytics`. Also computes per-post word count and reading time inline. |
| **Auth Module** | `src/server/auth.ts` | Issues JWTs (`jsonwebtoken`) containing `userId`, `email`, `role`. Verifies tokens in `authMiddleware`. Enforces `role === "admin"` in `adminMiddleware`. Password hashing/comparison via `bcrypt`. Entirely in-process — no external auth service. |
| **Database Module** | `src/server/database.ts` | Owns the `pg.Pool` (max 20 connections). Exposes typed CRUD functions for `users`, `posts`, and `comments`. Also exports the raw `pool` for the ad-hoc query in the users route. |
| **PostgreSQL** | (external process) | Primary and only persistent data store. Three tables: `users`, `posts`, `comments`. Credentials are hard-coded in `database.ts` (`host: localhost`, `port: 5432`, `database: blogdb`). |
| **Shared Types** | `src/shared/types.ts` | TypeScript interfaces (`User`, `Post`, `Comment`, `ApiResponse`, `PaginatedResponse`, request shapes). Consumed by both server modules. No runtime code. |

### What is absent from the running architecture

| Item | Status |
|------|--------|
| **Redis** | Listed in `package.json` but never imported or used in any source file. |
| **Zod** | Listed in `package.json` but never imported. No runtime input validation layer exists. |
| **Frontend / UI** | No frontend code in this repo. |
| **Message queue** | None. |
| **Background workers** | None. |
| **Cache** | None. |
| **External / third-party APIs** | None. No outbound HTTP calls anywhere. |
| **Object / file storage** | None. |
| **Infrastructure config** | No Dockerfile, docker-compose, or deployment manifests. |

---

## Part 2 – Request/Data Flow

### 2.1 User Registration

```mermaid
sequenceDiagram
    actor Client
    participant Router as routes.ts
    participant Auth as auth.ts
    participant DB as database.ts
    participant PG as PostgreSQL

    Client->>Router: POST /api/auth/register {email, password, name}
    Router->>Auth: register(req, res)
    Auth->>Auth: bcrypt.hash(password, 1)
    Auth->>DB: createUser(email, hashedPassword, name)
    DB->>PG: INSERT INTO users ... RETURNING *
    PG-->>DB: User row
    DB-->>Auth: User object (includes password hash)
    Auth->>Auth: jwt.sign({userId, email, role})
    Auth-->>Client: 201 {success, data: {user, token}}\n⚠ user object contains password hash
```

`register` hashes the password with bcrypt (cost factor 1 — intentionally weak), inserts the row, then immediately issues a JWT. The full user row including the password hash is returned in the response body.

### 2.2 User Login

```mermaid
sequenceDiagram
    actor Client
    participant Router as routes.ts
    participant Auth as auth.ts
    participant DB as database.ts
    participant PG as PostgreSQL

    Client->>Router: POST /api/auth/login {email, password}
    Router->>Auth: login(req, res)
    Auth->>DB: findUserByEmail(email)
    DB->>PG: SELECT * FROM users WHERE email = '${email}'
    Note over DB,PG: ⚠ string interpolation — SQL injection risk
    PG-->>DB: User row or empty
    DB-->>Auth: User | null

    alt user not found
        Auth-->>Client: 401 {error: "User not found"}
        Note over Auth,Client: ⚠ distinct error enables user enumeration
    else user found
        Auth->>Auth: bcrypt.compare(password, user.password)
        Auth->>Auth: console.log(email, password) ⚠ plaintext password logged
        Auth->>Auth: jwt.sign({userId, email, role}) — no expiresIn
        Auth-->>Client: 200 {success, data: {user, token}}\n⚠ user contains password hash
    end
```

Login looks up the user by email using a string-interpolated query, compares the submitted password against the stored bcrypt hash, and returns a JWT with no expiry. Two distinct error messages allow an attacker to enumerate registered email addresses.

### 2.3 Get All Posts (public)

```mermaid
sequenceDiagram
    actor Client
    participant Router as routes.ts
    participant DB as database.ts
    participant PG as PostgreSQL

    Client->>Router: GET /api/posts
    Router->>DB: getAllPosts()
    DB->>PG: SELECT * FROM posts WHERE status = 'published' ORDER BY created_at DESC
    Note over DB,PG: No LIMIT — returns every published post
    PG-->>DB: Post[]
    DB-->>Router: Post[]
    Router->>Router: for each post: nested loop counts words\n⚠ synchronous CPU work on every request
    Router-->>Client: 200 {success, data: enrichedPosts + wordCount + readingTime}
```

No authentication required. All published posts are returned in one query with no pagination. The route then performs synchronous per-post word counting inside a nested loop, blocking the event loop for large result sets.

### 2.4 Search Posts (public)

```mermaid
sequenceDiagram
    actor Client
    participant Router as routes.ts
    participant DB as database.ts
    participant PG as PostgreSQL

    Client->>Router: GET /api/posts/search?q=term
    Router->>DB: searchPosts(q)
    DB->>PG: SELECT * FROM posts WHERE title LIKE '%${searchTerm}%' OR content LIKE '%${searchTerm}%'
    Note over DB,PG: ⚠ string interpolation — SQL injection risk\nNo LIMIT · full table scan
    PG-->>DB: Post[]
    DB-->>Router: Post[]
    Router-->>Client: 200 {success, data: results}
```

Unauthenticated full-text search using a `LIKE` clause built via string interpolation. No result limit, so a blank query returns every row in the table.

### 2.5 Get Single Post (public, increments view count)

```mermaid
sequenceDiagram
    actor Client
    participant Router as routes.ts
    participant DB as database.ts
    participant PG as PostgreSQL

    Client->>Router: GET /api/posts/:id
    Router->>DB: getPostById(id)
    DB->>PG: SELECT * FROM posts WHERE id = $1
    PG-->>DB: Post | null
    DB-->>Router: Post | null

    alt post not found
        Router-->>Client: 404
    else post found
        Router->>DB: incrementPostViews(id)  [not awaited ⚠]
        Note over Router,DB: Fire-and-forget — errors silently lost
        DB->>PG: SELECT * FROM posts WHERE id = $1  [read]
        PG-->>DB: Post
        DB->>PG: UPDATE posts SET views = $1 WHERE id = $2  [write]
        Note over DB,PG: ⚠ read-then-write race condition
        Router-->>Client: 200 {success, data: post}
    end
```

The view increment is fire-and-forget (no `await`, no `.catch`). The increment itself uses a read-then-write pattern, causing a race condition when concurrent requests arrive for the same post.

### 2.6 Create Post (authenticated)

```mermaid
sequenceDiagram
    actor Client
    participant Router as routes.ts
    participant Auth as auth.ts
    participant DB as database.ts
    participant PG as PostgreSQL

    Client->>Router: POST /api/posts\nAuthorization: Bearer <token>
    Router->>Auth: authMiddleware
    Auth->>Auth: jwt.verify(token, JWT_SECRET)\n[no algorithm restriction ⚠]
    Auth-->>Router: req.user = {userId, email, role}
    Router->>DB: createPost(title, content, userId, status)
    DB->>PG: INSERT INTO posts ... RETURNING *
    PG-->>DB: Post
    DB-->>Router: Post
    Router-->>Client: 201 {success, data: post}
```

Requires a valid Bearer JWT. No ownership model beyond `author_id` being set to the authenticated user's ID; any authenticated user can also update or delete any other user's post (no ownership check on `PUT`/`DELETE`).

### 2.7 Get Post Comments (public) / Create Comment (authenticated)

```mermaid
sequenceDiagram
    actor Client
    participant Router as routes.ts
    participant Auth as auth.ts
    participant DB as database.ts
    participant PG as PostgreSQL

    Client->>Router: GET /api/posts/:id/comments
    Router->>DB: getCommentsByPostId(id)
    DB->>PG: SELECT * FROM comments WHERE post_id = $1 ORDER BY created_at ASC
    PG-->>DB: Comment[]
    DB-->>Router: Comment[]
    Router-->>Client: 200 {success, data: comments}

    Client->>Router: POST /api/posts/:id/comments\nAuthorization: Bearer <token>
    Router->>Auth: authMiddleware
    Auth-->>Router: req.user
    Note over Router: ⚠ Post existence not verified before inserting comment
    Router->>DB: createComment(postId, userId, body)
    DB->>PG: INSERT INTO comments ... RETURNING *
    PG-->>DB: Comment
    DB-->>Router: Comment
    Router-->>Client: 201 {success, data: comment}
```

`GET` is public with no pagination. `POST` requires auth but does not verify that the target post exists, allowing orphaned comments to be inserted against a non-existent `post_id`.

### 2.8 Admin Analytics (admin-only)

```mermaid
sequenceDiagram
    actor AdminClient
    participant Router as routes.ts
    participant Auth as auth.ts
    participant DB as database.ts
    participant PG as PostgreSQL

    AdminClient->>Router: GET /api/posts/analytics\nAuthorization: Bearer <token>
    Router->>Auth: authMiddleware
    Auth-->>Router: req.user (role checked next)
    Router->>Auth: adminMiddleware
    alt role !== "admin"
        Auth-->>AdminClient: 404 {error: "Not found"}
        Note over Auth,AdminClient: 404 used to obscure endpoint existence
    else role === "admin"
        Router->>DB: getPostsWithCommentCounts()
        DB->>PG: SELECT * FROM posts WHERE status = 'published'
        PG-->>DB: Post[]
        loop for each post  ⚠ N+1 queries
            DB->>PG: SELECT * FROM comments WHERE post_id = $1
            PG-->>DB: Comment[]
        end
        DB-->>Router: (Post & {comment_count})[]
        Router-->>AdminClient: 200 {success, data}
    end
```

Correctly double-gated behind `authMiddleware` then `adminMiddleware`. Returns a 404 (not 403) to non-admins to obscure the endpoint's existence. The underlying `getPostsWithCommentCounts` implementation issues one extra query per post — an N+1 problem.

### 2.9 Get All Users (unguarded)

```mermaid
sequenceDiagram
    actor Client
    participant Router as routes.ts
    participant PG as PostgreSQL

    Client->>Router: GET /api/users
    Note over Router: ⚠ No authMiddleware — completely public
    Router->>PG: SELECT * FROM users ORDER BY created_at DESC
    Note over Router,PG: Returns all columns including password hashes
    PG-->>Router: User[]
    Router-->>Client: 200 {success, data: users}\n⚠ includes password hashes for all users
```

`GET /api/users` has no authentication guard. Any unauthenticated caller receives all user rows including bcrypt password hashes and email addresses.

---

## Part 3 – Dependency Graph

```mermaid
flowchart LR
    subgraph Entry["Entry Layer"]
        index["index.ts"]
    end

    subgraph Routes["Route Layer"]
        routes["routes.ts"]
    end

    subgraph Auth["Auth Layer"]
        auth["auth.ts\nlogin · register\nauthMiddleware · adminMiddleware\ngenerateToken"]
    end

    subgraph Data["Data Layer"]
        database["database.ts\nfindUserByEmail · findUserById · createUser\ngetAllPosts · getPostById · createPost\nupdatePost · deletePost · incrementPostViews\ngetCommentsByPostId · createComment\ngetPostsWithCommentCounts · searchPosts\npool (exported)"]
    end

    subgraph Shared["Shared"]
        types["shared/types.ts\nUser · Post · Comment\nApiResponse · PaginatedResponse\nLoginRequest · CreatePostRequest · CreateCommentRequest"]
    end

    subgraph NPM["npm Packages"]
        express["express"]
        jwt["jsonwebtoken"]
        bcrypt["bcrypt"]
        pg["pg"]
    end

    index -->|"import router"| routes
    index -->|"uses"| express

    routes -->|"import login, register\nauthMiddleware, adminMiddleware\nAuthenticatedRequest"| auth
    routes -->|"import getAllPosts, getPostById\ncreatePost, updatePost, deletePost\ngetCommentsByPostId, createComment\nincrementPostViews, getPostsWithCommentCounts\nsearchPosts, pool"| database
    routes -->|"uses"| express

    auth -->|"import findUserByEmail\ncreateUser"| database
    auth -->|"import User"| types
    auth -->|"uses"| jwt
    auth -->|"uses"| bcrypt
    auth -->|"uses"| express

    database -->|"import User, Post, Comment"| types
    database -->|"uses"| pg
```

### Dependency Notes

| Module | Imports from | Exports to |
|--------|-------------|------------|
| `index.ts` | `routes.ts`, `express` | — (app default export for testing) |
| `routes.ts` | `auth.ts`, `database.ts`, `express` | `router` (default) |
| `auth.ts` | `database.ts`, `shared/types.ts`, `jsonwebtoken`, `bcrypt`, `express` | `login`, `register`, `authMiddleware`, `adminMiddleware`, `AuthenticatedRequest` |
| `database.ts` | `shared/types.ts`, `pg` | all query functions + `pool` |
| `shared/types.ts` | — (pure types) | TypeScript interfaces only |

---

## Part 4 – Security Boundaries

```mermaid
flowchart LR
    subgraph Untrusted["Untrusted Zone (Internet)"]
        Client["HTTP Client\nAll input untrusted"]
    end

    subgraph Perimeter["Perimeter (index.ts)"]
        CORS["Wildcard CORS ⚠\nAccess-Control-Allow-Origin: *"]
        BodyParser["express.json()\n⚠ No size limit"]
        ErrHandler["Global 500 handler"]
    end

    subgraph PublicRoutes["Public Routes (no auth)"]
        GetPosts["GET /api/posts"]
        SearchPosts["GET /api/posts/search\n⚠ SQL injection via LIKE"]
        GetPost["GET /api/posts/:id"]
        GetComments["GET /api/posts/:id/comments"]
        GetUsers["GET /api/users\n⚠ Returns all password hashes"]
    end

    subgraph AuthBoundary["Auth Boundary (authMiddleware)"]
        JWTVerify["jwt.verify(token, JWT_SECRET)\n⚠ Hardcoded secret\n⚠ No algorithm restriction\n⚠ Tokens never expire"]
    end

    subgraph AuthedRoutes["Authenticated Routes"]
        CreatePost["POST /api/posts\n⚠ No XSS sanitization"]
        UpdatePost["PUT /api/posts/:id\n⚠ No ownership check"]
        DeletePost["DELETE /api/posts/:id\n⚠ No ownership check"]
        CreateComment["POST /api/posts/:id/comments\n⚠ No post-existence check"]
    end

    subgraph AdminBoundary["Admin Boundary (adminMiddleware)"]
        RoleCheck["role === 'admin'\nReturns 404 to non-admins"]
    end

    subgraph AdminRoutes["Admin Routes"]
        Analytics["GET /api/posts/analytics"]
    end

    subgraph DBBoundary["Database Boundary (database.ts)"]
        ParamQueries["Parameterized queries ✓\nfindUserById, createUser\ngetPostById, createPost\nupdatePost, deletePost\ngetCommentsByPostId, createComment"]
        InjectionVuln["String interpolation ⚠\nfindUserByEmail → SQL injection\nsearchPosts → SQL injection"]
        Credentials["Hardcoded credentials ⚠\nhost/port/db/user/password in source"]
    end

    subgraph DataStore["Data Store"]
        PG[("PostgreSQL\nblogdb\nusers · posts · comments")]
    end

    subgraph Secrets["Secrets (all hardcoded ⚠)"]
        JWTSecret["JWT_SECRET = 'my-super-secret-jwt-key-2024'"]
        DBPass["DB password = 'supersecret123'"]
    end

    subgraph SensitiveDataFlows["Sensitive Data Flows"]
        PasswordLog["Plaintext password\nlogged to console ⚠"]
        HashInResponse["Password hash returned\nin login/register response ⚠"]
        StackTrace["error.stack leaked\nto client on register failure ⚠"]
    end

    Client -->|"HTTP"| CORS
    CORS --> BodyParser
    BodyParser --> PublicRoutes
    BodyParser -->|"Authorization header"| AuthBoundary
    AuthBoundary --> AuthedRoutes
    AuthedRoutes --> AdminBoundary
    AdminBoundary --> AdminRoutes

    PublicRoutes --> DBBoundary
    AuthedRoutes --> DBBoundary
    AdminRoutes --> DBBoundary
    DBBoundary --> PG

    JWTVerify -.->|"signs/verifies with"| JWTSecret
    Credentials -.->|"connects with"| DBPass

    AuthBoundary -.->|"login flow"| PasswordLog
    AuthBoundary -.->|"login/register response"| HashInResponse
    AuthBoundary -.->|"register error"| StackTrace
```

### Security Boundary Summary

| Boundary | Location | Notes |
|----------|----------|-------|
| **Network perimeter** | `index.ts` | Wildcard CORS; no rate limiting; no body size limit; no security headers (no helmet). |
| **Authentication** | `authMiddleware` in `auth.ts` | Bearer JWT verified against a hardcoded secret with no `algorithms` restriction (vulnerable to `alg: none` attack) and no `expiresIn` (tokens are eternal). |
| **Authorization** | `adminMiddleware` in `auth.ts` | Role check only. No resource-ownership enforcement: any authenticated user can update or delete any post. |
| **Input entry points** | All route bodies (`req.body`) and `req.query.q` | No validation layer (Zod is unused). No XSS sanitization on post content. SQL injection via string interpolation in `findUserByEmail` and `searchPosts`. |
| **Secrets** | `auth.ts:7`, `database.ts:6-11` | JWT secret and DB password are hard-coded strings in source. Should be read from environment variables. |
| **Sensitive data flows** | `auth.ts:37`, `auth.ts:41-47`, `auth.ts:64-68` | Plaintext password is logged on every login; full user object (including bcrypt hash) is returned by login and register; `error.stack` is returned to the client on registration failure. |
| **Database** | `database.ts` | Most queries use parameterized `$N` placeholders correctly. Exceptions: `findUserByEmail` and `searchPosts` use string interpolation, creating SQL injection vulnerabilities. |
| **Unguarded admin data** | `GET /api/users` (`routes.ts:196-204`) | Exposes all user rows including password hashes to unauthenticated callers. |