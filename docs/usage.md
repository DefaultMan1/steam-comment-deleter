# Filters, limits, and privacy

## How selection works

- Text filters match literal text, ignoring case. Separate terms with commas. Regular expressions are not supported.
- Author filters match a complete display name, SteamID, or profile URL.
- Date filters use your local calendar days. Comments with unknown dates are excluded when a date filter is active.
- Changing filters, Keep selections, or page content requires a new scan.
- Only comments with a Delete control supplied by Steam are eligible. Profile owners may be able to delete other people's comments.

**DELETE ALL** processes available pages with the same filters, up to **500 submitted operations per run**. Later pages are not individually previewed. The tool stops after three consecutive failed or uncertain attempts. For more than 500 comments, scan again and start another run.

Operations run one at a time, with a 0.5–0.9 second pause after each settled attempt, plus Steam's response time. Background-tab speed is not guaranteed.

## Privacy

The script uses Steam's existing controls. Steam makes the resulting network requests. The tool has no backend, reads no account credentials, and sends no comments to a third party. Browser storage retains local preferences. A browser execution lock prevents simultaneous deletion runs in multiple tabs.

## Compatibility

Tested with **Brave and Tampermonkey**. A user reported successful installation and real Steam comment deletion. Automated tests cover filtering, validation, the panel workflow, and simulated Steam responses. Firefox is included in CI, but live Steam use in Firefox is not verified.

Steam can change its page structure. If a deletion cannot be confirmed, check Activity and inspect the profile before trying again.


[Back to installation](../README.md)

