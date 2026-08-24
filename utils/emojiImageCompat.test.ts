import { beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DB, openDB } from './db';
import { normalizeEmojiRecord, reportEmojiImageLoadFailure } from './emojiImageCompat';
import EmojiImage from '../components/chat/EmojiImage';

const clearEmojis = async (): Promise<void> => {
    const db = await openDB();
    await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('emojis', 'readwrite');
        tx.objectStore('emojis').clear();
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
};

beforeEach(clearEmojis);

describe('emoji image compatibility', () => {
    it('preserves canonical names, groups and URLs', () => {
        expect(normalizeEmojiRecord({
            name: 'wave',
            url: 'https://img.example/wave.png',
            categoryId: 'friends',
        })).toEqual({
            name: 'wave',
            url: 'https://img.example/wave.png',
            categoryId: 'friends',
        });
    });

    it('restores common legacy image fields and category names', () => {
        expect(normalizeEmojiRecord({
            name: 'legacy-url',
            imageUrl: 'https://img.example/a.png',
            groupId: 'old-group',
        } as any)).toEqual({
            name: 'legacy-url',
            url: 'https://img.example/a.png',
            categoryId: 'old-group',
        });
        expect(normalizeEmojiRecord({
            name: 'legacy-src',
            src: 'data:image/png;base64,AA==',
            category: 'old-category',
        } as any)).toEqual({
            name: 'legacy-src',
            url: 'data:image/png;base64,AA==',
            categoryId: 'old-category',
        });
        expect(normalizeEmojiRecord({
            name: 'legacy-object',
            image: { url: 'https://img.example/c.png' },
        } as any)?.url).toBe('https://img.example/c.png');
    });

    it('prefers a persistent source over an expired blob URL', () => {
        expect(normalizeEmojiRecord({
            name: 'persisted',
            url: 'blob:https://app.invalid/old',
            imageUrl: 'https://img.example/real.png',
        } as any)?.url).toBe('https://img.example/real.png');
    });

    it('reads a legacy IndexedDB record repeatedly without rewriting or reimporting it', async () => {
        const db = await openDB();
        await new Promise<void>((resolve, reject) => {
            const tx = db.transaction('emojis', 'readwrite');
            tx.objectStore('emojis').put({
                name: 'legacy saved',
                imageUrl: 'https://img.example/saved.png',
                category: 'legacy-group',
            });
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });

        const expected = [{
            name: 'legacy saved',
            url: 'https://img.example/saved.png',
            categoryId: 'legacy-group',
        }];
        expect(await DB.getEmojis()).toEqual(expected);
        expect(await DB.getEmojis()).toEqual(expected);
    });

    it('normalizes a legacy backup during import and keeps it after reopening', async () => {
        await DB.importFullData({
            savedEmojis: [{
                name: 'backup legacy',
                src: 'https://img.example/backup.png',
                groupId: 'backup-group',
            }],
        } as any);

        expect(await DB.getEmojis()).toContainEqual({
            name: 'backup legacy',
            url: 'https://img.example/backup.png',
            categoryId: 'backup-group',
        });
    });

    it('loads remote images without leaking the page referrer', () => {
        const markup = renderToStaticMarkup(React.createElement(EmojiImage, {
            src: 'https://img.example/sticker.png',
            alt: '',
        }));
        expect(markup).toContain('referrerPolicy="no-referrer"');
        expect(markup).toContain('src="https://img.example/sticker.png"');
    });

    it('reports a failed remote URL without replacing it with the emoji name', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        reportEmojiImageLoadFailure('https://unreachable.example/sticker.png');
        expect(warn).toHaveBeenCalledWith('[emoji] image failed to load', {
            url: 'https://unreachable.example/sticker.png',
            reason: 'remote-resource-unreachable-or-rejected',
        });
        warn.mockRestore();
    });
});
