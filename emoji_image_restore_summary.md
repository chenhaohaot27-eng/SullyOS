# Emoji Image Restore Summary

## Root cause

- The emoji store schema is still `name / url / categoryId`; recent changes did not rename it or convert remote URLs into Blob URLs.
- Runtime reads only accepted `url`, so legacy imports using `imageUrl`, `image`, `src`, `emojiUrl`, `stickerUrl`, or older category aliases could retain a valid name while yielding an empty image source.
- Picker and message images loaded remote URLs with the GitHub Pages referrer. Hosts with hotlink protection could reject these requests. Emoji rendering now uses `referrerPolicy="no-referrer"` without enabling CORS mode or replacing failures with fake images/text.
- A persisted `blob:` URL cannot survive its original browser session. When a legacy record also contains a persistent URL, the persistent source is now preferred. A genuinely unreachable remote domain remains a network/resource failure and is reported to the console as such.

## Changed files

- `utils/emojiImageCompat.ts`
- `utils/emojiImageCompat.test.ts`
- `utils/db.ts`
- `components/chat/EmojiImage.tsx`
- `components/chat/ChatInputArea.tsx`
- `components/chat/ChatModals.tsx`
- `components/chat/MessageItem.tsx`
- `apps/GroupChat.tsx`

## Tests

- Targeted emoji compatibility, legacy backup/IndexedDB reload, group/category preservation, image request policy, existing emoji residue, and AI emoji resolver tests: 13 passed.
- Picker selection and user send payload remain unchanged: the resolved canonical URL is still sent as an `emoji` message; category switching still uses the existing filters.
- Full repository typecheck still reports pre-existing errors in unrelated modules; no new error points to the added compatibility files. Production compilation succeeds.

## Build

- `pnpm run build`: passed.

## Reimport required

- No. Existing canonical and supported legacy imported records are restored at read time and remain usable after refresh/restart without rewriting IndexedDB.
