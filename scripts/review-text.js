export function removeReviewUrls(text) {
    return text.replace(/(?:https?:\/\/|www\.)[^\s"'<>]+/gi, token => {
        const annotation = token.search(/[,(\[（](?=[가-힣])/u);
        let suffix = annotation < 0 ? '' : token.slice(annotation);
        let url = annotation < 0 ? token : token.slice(0, annotation);
        for (const [open, close] of [['(', ')'], ['[', ']'], ['（', '）']]) {
            while (url.endsWith(close) && url.split(close).length > url.split(open).length) {
                suffix = close + suffix;
                url = url.slice(0, -1);
            }
        }
        return suffix;
    }).replace(/\(\s*\)|\[\s*\]|（\s*）/g, '');
}
