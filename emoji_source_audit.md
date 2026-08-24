# Emoji Source Audit

## Working category

- iPhone observation: exactly one category displays images.
- Its name and records cannot be read from Windows because iOS Safari/PWA IndexedDB is device-local. Source inspection suggests the likely category is `Sully 专属`: 8 canonical HTTPS images on `cdn.jsdelivr.net`. This is an inference, not a claim about the inaccessible iPhone records.

## Broken categories

- iPhone observation: every other imported category remains blank/broken.
- Exact category names, counts, URL fields, schemes, and hosts are unavailable from the Windows workspace. The available Chrome/Edge production-origin databases were last updated on 2026-08-16; an isolated read returned `emojis: 0` and `emoji_categories: 0`, so they cannot represent the current iPhone dataset.

## Hosts

- `cdn.jsdelivr.net`: 8 code-defined `Sully 专属` HTTPS sources. The iPhone working category is consistent with this source, but the category identity was not directly inspectable.
- Imported-category hosts: unknown; no current URL inventory exists in the repository, reports, supplied attachments, or Windows IndexedDB.
- Windows curl reached the local SOCKS proxy and began TLS to `cdn.jsdelivr.net` but produced no HTTP status within the timeout. This is inconclusive and is not recorded as a 403 or dead host.

## Root cause

- The remaining failures are source-specific rather than another emoji schema/resolver failure: one category works through the same picker and message rendering path.
- Current source code does not convert remote emoji URLs into Blob/object URLs. iOS will block plain HTTP images on the HTTPS app; expired `blob:` URLs cannot survive restart; dead/403/hotlink-protected URLs and malformed/encoded URLs require the actual stored URLs to distinguish.
- Without the iPhone records, assigning hosts or counts to mixed content, 403, expiry, Blob, or encoding would be guesswork.

## Minimal fix

- No additional rendering change was made. There is no verified host for a safe `http→https` upgrade and no evidence supporting a hard-coded replacement.
- The next merge-safe action is to obtain a sanitized aggregate from the iPhone runtime (category, scheme, host, status only; no image content) and then migrate only URLs whose HTTPS replacement is verified. This does not require reimporting the emoji pack.

## 是否需迁移图片源

- Not yet determinable per host. HTTP sources with working HTTPS equivalents need only a URL migration; 403/dead hosts or lone expired Blob URLs require migration to a durable image source. User reimport is not required.
