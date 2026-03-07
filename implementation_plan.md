# Integration of Functional Project Version

The user provided a functional version of the application in `C:\Users\HP\Downloads\document`. I will use this as the new base for the project, ensuring all features are preserved while maintaining the deployment configuration necessary for Railway.

## Bug Fix: Export, Print, and Profile Save
The user reports:
1. PDF export still fails (no download).
2. Printing results in a blank page.

### Proposed Changes
- **src/index.css**:
  - Replace the global `body * { display: none }` with a targeted list of UI elements to hide during print (`nav`, `button`, `aside`, etc.).
  - Ensure `.print-container` and its parents are NOT hidden and occupy the full viewport.
  - Reset `max-height` and `overflow` on parents during print to prevent content cropping.
- **App.tsx**:
  - **PDF Fix**: Add `logging: true` to `html2canvas` for debugging and use a more standard `windowWidth`. Ensure `jsPDF` uses `blob` and `URL.createObjectURL` as a fallback if `save()` fails on some mobile browsers.
  - **Print Fix**: Ensure `window.print()` is called after a short timeout if necessary, though direct call is usually fine.

## Verification Plan

### Automated Tests
- Run `npm run build` to ensure the new code compiles correctly.
- Push to GitHub and monitor Railway deployment logs.

### Manual Verification
- Save a profile and verify the page returns to the list without going blank.
- Export a multi-page PDF and verify all pages are correctly scaled.
- Print the invoice and verify it shows the content instead of a blank page.
- **[NEW] Verify totals in History and Dashboard on mobile view (fallback logic).**

## Bug Fix: Mobile Totals as 0
The user reported that totals appear as 0 on mobile. This is likely due to the `total` column being NULL for some records and the frontend lacking a fallback to the JSON data.

### Proposed Changes
- **server.ts**: Add migration to populate `total` column from `data.grandTotal` for existing records.
- **App.tsx**: Update History and Dashboard components to use `inv.total || inv.data?.grandTotal || 0` for calculations.
- **[NEW] Translator Fix**: Add `translate="no"` and class `notranslate` to all elements displaying currency or totals in `App.tsx` and `InvoiceTemplate.tsx`.
