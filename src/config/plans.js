export const planLimits = {
    free: {
        maxFiles: 5,
        maxFileSizeMB: 10,
        maxNotebooks: 5,
    },
    plus: {
        maxFiles: 12,
        maxFileSizeMB: 25,
        maxNotebooks: Infinity, // Use Infinity for unlimited
    }
};