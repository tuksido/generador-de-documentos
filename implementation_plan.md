# Integration of Functional Project Version

The user provided a functional version of the application in `C:\Users\HP\Downloads\document`. I will use this as the new base for the project, ensuring all features are preserved while maintaining the deployment configuration necessary for Railway.

## Bug Fix: PDF "oklch" Color Error
The user reports: `Error al generar el PDF: Attempting to parse an unsupported color function "oklch"`.
This is caused by Tailwind CSS v4 using modern `oklch` colors which `html2canvas` cannot parse.

### Proposed Changes
- **src/index.css**:
  - Replace `@import "tailwindcss";` with a safer configuration or override the base colors to use RGB/HEX.
  - Specifically, set `--color-blue-500` and other used colors to HEX equivalents at the top level or inside `@media print`.
- **src/components/InvoiceTemplate.tsx**:
  - Replace any dynamic Tailwind classes that might rely on `oklch` with hardcoded HEX/RGB values in the `style` attribute for the elements inside the invoice pages.
  - This ensures `html2canvas` sees simple, parsable colors.
- **src/App.tsx**:
  - Ensure the `onclone` hook in `exportPDF` also forces standard colors if needed.

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
