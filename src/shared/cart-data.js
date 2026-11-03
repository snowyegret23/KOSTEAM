import { getSteamAccountId } from './restore-validation.js';

export function readSsrCartData(document) {
    const raw = document.querySelector('script#valve-ssr-data[type="application/json"]')?.textContent;
    if (!raw) throw new Error('Steam cart data is unavailable');
    const data = JSON.parse(raw);
    if (data.route !== '/cart/' && data.route !== '/cart') throw new Error('Unexpected Steam cart route');
    const userInfo = data.UserConfig;
    const loaders = data.loaderData?.map(value => typeof value === 'string' ? JSON.parse(value) : value);
    const cartId = loaders?.find(value => value?.cartID)?.cartID;
    if (userInfo?.logged_in === false && cartId?.type === 'anonymous') {
        return { userInfo, webapi_token: '', accountcart: { cart: { line_items: [] } } };
    }
    if (userInfo?.logged_in !== true || cartId?.type !== 'account') {
        throw new Error('Steam account cart is unavailable');
    }
    const token = loaders?.find(value => typeof value?.strWebAPIToken === 'string')?.strWebAPIToken;
    const accountId = getSteamAccountId(token);
    if (!accountId || accountId !== userInfo.steamid ||
        !Number.isSafeInteger(userInfo.accountid) ||
        BigInt(accountId) - 76561197960265728n !== BigInt(userInfo.accountid)) {
        throw new Error('Steam cart account does not match');
    }
    const queryData = typeof data.renderContext?.queryData === 'string'
        ? JSON.parse(data.renderContext.queryData) : data.renderContext?.queryData;
    const carts = queryData?.queries?.filter(query =>
        query?.queryKey?.length === 3 && query.queryKey[0] === 'shopping_cart' &&
        query.queryKey[1] === 'account' && query.queryKey[2] === userInfo.accountid);
    if (carts?.length !== 1 || carts[0].state?.status !== 'success' ||
        !Array.isArray(carts[0].state.data?.line_items)) {
        throw new Error('Steam cart contents are unavailable');
    }
    return { userInfo, webapi_token: token, accountcart: { cart: carts[0].state.data } };
}
