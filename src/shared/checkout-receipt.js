export function isConfirmedCheckoutReceipt(state) {
    return state?.receiptVisible === true &&
        state.pendingReceiptVisible !== true &&
        state.cartVisible !== true &&
        state.receiptErrorVisible !== true &&
        state.purchaseSummaryVisible === true &&
        state.confirmationCodeVisible === true;
}
