# Integration of Functional Project Version

The user provided a functional version of the application in `C:\Users\HP\Downloads\document`. I will use this as the new base for the project, ensuring all features are preserved while maintaining the deployment configuration necessary for Railway.

## Bug Fix: Export and Print Functionality
The user reports that PDF export, printing, and Excel exports are not working.

### Proposed Changes
- **src/index.css**:
  - Update `@media print` to include all preview scale classes (`scale-[0.5]`, `scale-[0.75]`, etc.) to ensure the invoice prints at 1:1 scale.
  - Fix the `visibility: hidden` logic to ensure only the invoice is printed and no empty pages are generated from hidden layout elements.
- **App.tsx**:
  - **PDF Fix**: Update `exportPDF` to handle capturing multiple pages more reliably. Ensure `html2canvas` captures at a high enough resolution and ignores the preview scaling transforms.
  - **Excel Fix**: Update `History` component's `exportToExcel` to use the fallback `inv.total || inv.data?.grandTotal || 0`.
  - **Print Fix**: Add a specific `print-only` container or ensure the current logic doesn't hide essential content.
- **InvoiceTemplate.tsx**:
  - Add a helper class to handle 1:1 scale during export/print.

## Verification Plan

### Automated Tests
- Run `npm run build` to ensure the new code compiles correctly.
- Push to GitHub and monitor Railway deployment logs.

### Manual Verification
- Verify successful Excel export from History and Clients.
- Verify PDF generation on both desktop and mobile views.
- Verify print layout (no sidebar/buttons visible, correct scaling).
- **[NEW] Verify totals in History and Dashboard on mobile view (fallback logic).**

## Bug Fix: Mobile Totals as 0
The user reported that totals appear as 0 on mobile. This is likely due to the `total` column being NULL for some records and the frontend lacking a fallback to the JSON data.

### Proposed Changes
- **server.ts**: Add migration to populate `total` column from `data.grandTotal` for existing records.
- **App.tsx**: Update History and Dashboard components to use `inv.total || inv.data?.grandTotal || 0` for calculations.
- **[NEW] Translator Fix**: Add `translate="no"` and class `notranslate` to all elements displaying currency or totals in `App.tsx` and `InvoiceTemplate.tsx`.
