export const planLimits = {
    free: {
        maxFiles: 5,
        maxFileSizeMB: 10,
        maxNotebooks: 5,
    },
    plus: {
        maxFiles: 12,
        maxFileSizeMB: 100,
        maxNotebooks: Infinity, // Use Infinity for unlimited
    },
    pro: {
        maxFiles: 100,
        maxFileSizeMB: 100,
        maxNotebooks: Infinity, // Use Infinity for unlimited
    }
};

export const modelLimits = {
    free: {
        agentModel: 'gemini-2.5-flash',
        thinkingBudget: 0,
        vectorDim: 512,
        flashcardModel: 'gemini-2.5-flash-lite'
    },
    plus: {
        agentModel: 'gemini-3-flash-preview',
        thinkingBudget: -1,
        vectorDim: 512,
        flashcardModel: 'gemini-2.5-flash'
    },
    pro: {
        agentModel: 'gemini-3-flash-preview',
        thinkingBudget: -1,
        vectorDim: 512,
        flashcardModel: 'gemini-3-flash-preview'
    }
}

export function getModelConfig(plan) {
    let limits = modelLimits[plan];
    return limits
}