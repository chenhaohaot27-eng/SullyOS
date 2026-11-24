/** Strip photo actions before splitting prose. Only brackets outside JSON strings and
 * arrays may close the tag. An unfinished action stays private during SSE and on EOF. */
export function stripChatPhotoCommands(
    text: string,
    onCommand?: (raw: string, payload: string, complete: boolean) => void,
): string {
    const start = /\[\[SEND_PHOTO[:：]/g;
    let cursor = 0;
    let prose = '';
    let match: RegExpExecArray | null;
    while ((match = start.exec(text))) {
        prose += text.slice(cursor, match.index);
        const payloadStart = start.lastIndex;
        let quoted = false;
        let arrays = 0;
        let end = payloadStart;
        for (; end < text.length; end++) {
            const char = text[end];
            if (quoted && char === '\\') end++;
            else if (char === '"') quoted = !quoted;
            else if (!quoted && char === '[') arrays++;
            else if (!quoted && char === ']') {
                if (arrays > 0) arrays--;
                else if (text[end + 1] === ']') break;
            }
        }
        const complete = end < text.length;
        cursor = complete ? end + 2 : text.length;
        onCommand?.(text.slice(match.index, cursor), text.slice(payloadStart, end), complete);
        start.lastIndex = cursor;
    }
    return prose + text.slice(cursor);
}
