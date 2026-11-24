import { useEffect, useRef, type Dispatch, type SetStateAction } from 'react';
import type { Message } from '../types';
import { CLOUD_PHOTO_SETTLED_EVENT, rememberCloudTaskMessage, startCloudPhotoPoller } from '../utils/cloudImageGen';

/** Keep the open conversation in sync when a photo finishes or Safari resumes. */
export function useCloudPhotoUpdates(messages: Message[], setMessages: Dispatch<SetStateAction<Message[]>>) {
    const visible = useRef(messages);
    visible.current = messages;
    useEffect(() => {
        const resume = () => {
            if (document.hidden) return;
            for (const message of visible.current) {
                const taskId = message.metadata?.cloudImageTaskId;
                if (!taskId || message.metadata?.chatPhoto?.status !== 'pending') continue;
                rememberCloudTaskMessage(taskId, { messageId: message.id, charId: message.charId, groupId: message.groupId });
                startCloudPhotoPoller(taskId);
            }
        };
        const settled = (event: Event) => {
            const updated = (event as CustomEvent<Message>).detail;
            setMessages(current => current.map(m => m.id === updated.id
                && m.metadata?.cloudImageTaskId === updated.metadata?.cloudImageTaskId ? updated : m));
        };
        window.addEventListener(CLOUD_PHOTO_SETTLED_EVENT, settled);
        window.addEventListener('pageshow', resume);
        document.addEventListener('visibilitychange', resume);
        return () => {
            window.removeEventListener(CLOUD_PHOTO_SETTLED_EVENT, settled);
            window.removeEventListener('pageshow', resume);
            document.removeEventListener('visibilitychange', resume);
        };
    }, [setMessages]);
}
