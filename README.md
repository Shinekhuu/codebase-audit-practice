# Codebase Audit Practice

A Node.js/TypeScript blog API with intentionally planted security, performance, and reliability issues. Practice auditing unfamiliar codebases and making minimal, surgical fixes.

## Structure

```
src/
  shared/
    types.ts          — Shared TypeScript types
  server/
    index.ts          — Express server entry point
    auth.ts           — Authentication & authorization
    database.ts       — Database queries (PostgreSQL)
    routes.ts         — API route handlers
tests/
  audit.test.ts       — Unit tests
```

## Getting Started

```bash
pnpm install
pnpm test
```

## Exercise

Set a 90-minute timer and begin.

1. Read the entire codebase — architecture, data flow, conventions
2. Identify security, performance, and reliability issues
3. Prioritize and fix the most critical issues first
4. One atomic commit per fix with a written justification
5. Run `pnpm test` after every change

## Tips

- Read all code before writing any fix
- 2-3 thorough fixes > 5 shallow ones
- AI tools are welcome
- Document issues you find but don't have time to fix
