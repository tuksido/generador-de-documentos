# Integration of Functional Project Version

The user provided a functional version of the application in `C:\Users\HP\Downloads\document`. I will use this as the new base for the project, ensuring all features are preserved while maintaining the deployment configuration necessary for Railway.

## Proposed Changes

### [Backend]
#### [MODIFY] [server.ts](file:///c:/Users/HP/Downloads/generaddor de facturas/server.ts)
- Replace with the functional version's logic.
- **Maintain Railway Fixes**:
  - Bind to `0.0.0.0`.
  - Use `process.env.PORT`.
  - Use synchronous static file serving for reliability.
  - Fix path resolution for `dist`.

### [Frontend]
#### [MODIFY] [src/](file:///c:/Users/HP/Downloads/generaddor de facturas/src/)
- Replace all files in `src/` with the versions from `C:\Users\HP\Downloads\document\src/`.
- Ensure all API calls use the new `/api` prefix and `credentials: 'include'`.

### [Configuration]
#### [MODIFY] [package.json](file:///c:/Users/HP/Downloads/generaddor de facturas/package.json)
- Sync dependencies with the functional version.
- Keep the `esbuild` build script for production performance.

## Verification Plan

### Automated Tests
- Run `npm run build` to ensure the new code compiles correctly.
- Push to GitHub and monitor Railway deployment logs.

### Manual Verification
- Verify login/signup flow.
- Verify invoice creation and real-time preview (feature from functional version).
- Verify document saving and history retrieval.
