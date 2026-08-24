import React from 'react';
import { reportEmojiImageLoadFailure } from '../../utils/emojiImageCompat';

type EmojiImageProps = React.ImgHTMLAttributes<HTMLImageElement>;

const EmojiImage: React.FC<EmojiImageProps> = ({ src, onError, ...props }) => (
    <img
        {...props}
        src={src}
        referrerPolicy="no-referrer"
        onError={(event) => {
            reportEmojiImageLoadFailure(typeof src === 'string' ? src : '');
            onError?.(event);
        }}
    />
);

export default EmojiImage;
