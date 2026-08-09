# Blue Eyes USPS Tracker Chrome Extension

This is a standalone Chrome extension prototype. It does not replace the existing web app.

## Load locally

1. Open `chrome://extensions`.
2. Enable `Developer mode`.
3. Click `Load unpacked`.
4. Select this folder: `backend/chrome-extension`.
5. Pin the extension and open the popup.
6. Click `Open Workspace` for long tracking jobs. The workspace is a normal Chrome tab and will not close when you switch tabs.

## Notes

- The workspace processes USPS tracking codes with 2 workers for the USPS.com -> Quick Tools flow.
- If USPS renders a blank page or the tracking input is missing, the worker waits 7 seconds, then reloads the page up to 2 times before failing that batch.
- The same 7-second reload retry is also applied to blank USPS result pages after submit.
- After a batch returns results, the next batch starts after a short 3-6 second delay.
- Each worker processes up to 10 codes per USPS page request.
- Each batch has a longer navigation/fill budget, then waits up to 60 seconds after submit before marking rows as `Not tracked`.
- Results are kept in the same order as the input list.
- Results include a `Delivery Date` column for delivered packages, formatted as `dd/mm/yyyy`.
- Results include a `Last Update Date` column parsed from the latest USPS status date, formatted as `d/m`.
- `Additional Info` filters common USPS footer/navigation text so rows stay shorter when pasted into Excel.
- The popup opens the workspace for tracking jobs because Chrome can close popups when switching tabs.
- UPS numbers starting with `1Z` are marked as unsupported.
- It opens or reuses a background USPS tab, starts from USPS.com, opens Quick Tools -> Track a Package, fills the tracking input, submits the form, and reads USPS result DOM from Chrome itself.
- It scrolls to the USPS tracking input, fills it visibly, verifies the tracking codes remain in the input, then submits.
- Results can be downloaded as CSV from the popup.
- Workspace results can be copied by row, by common columns, or as all tab-separated rows for direct Excel paste.
- This still depends on USPS page selectors, so USPS UI changes may require selector updates.
