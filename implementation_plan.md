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
- **[NEW] Verify totals in History and Dashboard on mobile view (fallback logic).**

## Bug Fix: Mobile Totals as 0
The user reported that totals appear as 0 on mobile. This is likely due to the `total` column being NULL for some records and the frontend lacking a fallback to the JSON data.

### Proposed Changes
- **server.ts**: Add migration to populate `total` column from `data.grandTotal` for existing records.
- **App.tsx**: Update History and Dashboard components to use `inv.total || inv.data?.grandTotal || 0` for calculations.
- **[NEW] Translator Fix**: Add `translate="no"` and class `notranslate` to all elements displaying currency or totals in `App.tsx` and `InvoiceTemplate.tsx`.
