# Requirements Analysis Questions

## Sources

- [desc] Initial description: "Fix the bug where completed todos reappear after a page reload."
- [scope] Workflow-selected scope: `bugfix`.

## Q1. [Product owner] Which todos must survive a reload?

Completed todos come back after a reload because only the open list is saved. This decides what the fix stores.

- A. Every todo, open and completed
- B. Only open todos; completed ones are cleared on reload
- C. Completed todos for 7 days, then cleared
- X. Other (please specify)

[Answer]: A. Every todo, open and completed

## Q2. [Product owner] Should completed todos stay visible after the fix?

- A. Yes, in a collapsed "Done" section
- B. Yes, at the bottom of the list
- C. No, hide them but keep them stored
- X. Other (please specify)

[Answer]:

## Q3. [Developer] Where should todos be stored? (select all that apply)

The app writes to `localStorage` today; the fix can keep that or move storage.

- A. Keep `localStorage`
- B. `IndexedDB`
- C. The existing backend API
- X. Other (please specify)

[Answer]: ______

## Q4. [Operations engineer] Do existing users need their stored todos migrated?

- A. Yes, convert the old format on first load
- B. No, start fresh
- X. Other (please specify)

[Answer]:   

## Consolidated Summary Confirmation

Do these answers look correct?

- Looks correct
- Request changes

[Answer]:
