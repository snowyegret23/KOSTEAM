function getLabelIds(value) {
    return typeof value === 'string'
        ? value.trim().split(/\s+/).filter(Boolean)
        : [];
}

/**
 * Recognizes the untitled cart action that labels itself together with its
 * owning item. This also covers items where Steam does not render an Add
 * control.
 *
 * @param {{id?: string, labelledBy?: string, title?: string | null}} control
 * @param {(id: string) => boolean} [isContextId]
 * @returns {boolean}
 */
export function isContextualRemoveControl(control, isContextId = () => true) {
    if (!control || typeof isContextId !== 'function') return false;

    const id = typeof control.id === 'string' ? control.id.trim() : '';
    if (!id) return false;

    const labelIds = getLabelIds(control.labelledBy);
    if (!labelIds.includes(id)) return false;

    const hasTitle = typeof control.title === 'string' && control.title.trim().length > 0;
    if (hasTitle) return false;

    return labelIds.some(labelId => labelId !== id && isContextId(labelId));
}

/**
 * Identifies Steam's remove control from a two-control accessibility group.
 * Returns -1 when the relationship is incomplete or ambiguous.
 *
 * @param {{id?: string, labelledBy?: string, title?: string | null}[]} controls
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
    if (hasTitle[0] === hasTitle[1]) return -1;

    return hasTitle[0] ? 1 : 0;
}
