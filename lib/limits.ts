// Limits shared by the chat box and the server.

/**
 * Longest message a shopper can send. Claude reads about 4 characters per token and holds 1 million tokens
 * (the whole chat, search results included), so ~1 million characters is the most one message can usefully be.
 */
export const MAX_MESSAGE_CHARS = 1_000_000;
