# Project notes

## Scope

This repository is a personal web deployment of the MIT-licensed fish2018/pansou backend.
The frontend under `web/` is independently written for this repository; do not copy code or assets from `fish2018/pansou-web`, whose local checkout did not provide an explicit license.
Retain the upstream `LICENSE` and copyright notices.

## Architecture

- Go 1.25 backend; existing `/api/search`, `/api/health`, `/api/auth/*` contracts remain compatible.
- Small, dependency-free HTML/CSS/JavaScript frontend embedded in the Go binary.
- Same-origin deployment is the supported production mode. GitHub stores code, not a continuously running Go process.
- Public listeners must require authentication, an explicitly configured strong JWT secret, and a non-empty user configuration. Never commit real credentials.
- A separate local installation exists outside this repository; do not modify it as part of public-release changes.

## Verification

- Build the Go application and run the new web adapter/security tests.
- Check frontend JavaScript syntax, authenticated search, filters, copying/export, error and empty states.
- Check desktop and mobile widths, keyboard access, visible focus, readable contrast, and long-result wrapping.
- All search results are unverified candidates; metadata is not proof of downloadable files or video quality.

## Collaboration boundaries

- Backend adaptation work owns `main.go`, `publicweb.go`, `publicweb_test.go`, and `Dockerfile`.
- Frontend/release work owns `web/`, deployment examples, CI workflows, and documentation.
- No automatic cloud-account creation or paid resources. No registry publication is needed for the initial build workflow.

## Release implementation

- `publicweb.go` embeds `web/`, delegates existing API routes, validates listener/authentication settings, and applies origin/path/body-size guards and a bounded login throttle.
- `web/data.js` validates link schemes, handles Go's omitted empty response map, deduplicates magnet hashes, and neutralizes CSV formulas.
- Frontend sessions use session storage or memory, not saved account passwords. Third-party result text is never inserted as HTML.
- Styles use a light blue/neutral token set, local IBM Plex Sans (OFL), semantic states, 44px controls, and 768/480px adaptations.
- `tests/browser-smoke.mjs` is optional browser verification. It needs `playwright-core` and `PANSOU_BROWSER_EXECUTABLE`; `PANSOU_PLAYWRIGHT_MODULE` may point to an existing module installation.
- GitHub CI runs Go checks, Node built-in tests, a Docker build, and local-container HTTP/authentication smoke tests. It does not publish an image or create hosting resources.
- See `VERIFICATION.md` for verification scope and `DEPLOYMENT.md` for production requirements.
