function getLabelIds(value) {
    return typeof value === 'string'
        ? value.trim().split(/\s+/).filter(Boolean)
        : [];
}

/**
 * Recognizes a cart action that labels itself together with its owning item.
 *
 * @param {{id?: string, labelledBy?: string}} control
 * @param {(id: string) => boolean} [isContextId]
 * @returns {boolean}
 */
export function isContextualCartControl(control, isContextId = () => true) {
    if (!control || typeof isContextId !== 'function') return false;

    const id = typeof control.id === 'string' ? control.id.trim() : '';
    if (!id) return false;

    const labelIds = getLabelIds(control.labelledBy);
    if (!labelIds.includes(id)) return false;

    return labelIds.some(labelId => labelId !== id && isContextId(labelId));
}

export function isContextualRemoveControl(control, isContextId = () => true) {
    const hasTitle = typeof control?.title === 'string' && control.title.trim().length > 0;
    return !hasTitle && isContextualCartControl(control, isContextId);
}

/**
 * Identifies Steam's remove control from a two-control accessibility group.
 * Returns -1 when the relationship is incomplete or ambiguous.
 *
 * @param {{id?: string, labelledBy?: string, title?: string | null, className?: string}[]} controls
 * @param {(id: string) => boolean} [isSharedContextId]
 * @returns {number}
 */
export function getRemoveControlIndex(controls, isSharedContextId = () => true) {
    if (!Array.isArray(controls) || controls.length !== 2) return -1;
    if (typeof isSharedContextId !== 'function') return -1;

    const ids = controls.map(control => (
        typeof control?.id === 'string' ? control.id.trim() : ''
    ));
    if (ids.some(id => !id) || ids[0] === ids[1]) return -1;

    const labelIds = controls.map(control => getLabelIds(control?.labelledBy));
    if (!labelIds.every((labels, index) => labels.includes(ids[index]))) return -1;

    const controlIds = new Set(ids);
    const sharedContextIds = labelIds[0].filter(labelId => (
        !controlIds.has(labelId) && labelIds[1].includes(labelId)
    ));
    if (!sharedContextIds.some(isSharedContextId)) return -1;

    const hasTitle = controls.map(control => (
        typeof control?.title === 'string' && control.title.trim().length > 0
    ));
    if (hasTitle[0] !== hasTitle[1]) return hasTitle[0] ? 1 : 0;
    if (hasTitle[0]) return -1;

    const classes = controls.map(control => getLabelIds(control.className));
    const addClasses = ['_2qvlyUCwtTBUslo1Z7-RlG', '_8IaR06zcRE4-'];
    const removeClasses = ['_3YCgcpoCojlbS6DvkNsG2J', 'BFDdk5e7x8k-'];
    const addIndex = classes.findIndex(names => addClasses.some(name => names.includes(name)));
    const removeIndex = classes.findIndex(names => removeClasses.some(name => names.includes(name)));
    if (addIndex < 0 || removeIndex < 0 || addIndex === removeIndex) return -1;
    if (addClasses.some(name => classes[removeIndex].includes(name)) ||
        removeClasses.some(name => classes[addIndex].includes(name))) return -1;
    return removeIndex;
}
